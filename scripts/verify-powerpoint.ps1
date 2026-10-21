[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$ManifestPath
)

# Windows desktop integration check. Only the generated, hash-matched fixture is
# opened. A running PowerPoint instance is a preflight failure so user documents
# are never attached to or closed. No processes are terminated by this script.
$ErrorActionPreference = 'Stop'
$app = $null
$presentation = $null
$chartWorkbook = $null
$createdApplication = $false
$result = [ordered]@{
  startedAt = [DateTime]::UtcNow.ToString('o')
  passed = $false
  errors = @()
  checks = @()
  edits = @()
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$reportPath = Join-Path $outputRoot 'powerpoint-report.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Check([bool]$Condition, [string]$Label, $Actual = $null) {
  $script:result.checks += [ordered]@{ name = $Label; passed = $Condition; actual = $Actual }
  if (-not $Condition) { throw "Verification failed: $Label" }
}

function Read-Presentation($Deck) {
  $slides = @()
  $counts = [ordered]@{ text = 0; shapes = 0; pictures = 0; croppedImages = 0; tables = 0; charts = 0; groups = 0; animations = 0; transitions = 0 }
  for ($slideIndex = 1; $slideIndex -le $Deck.Slides.Count; $slideIndex++) {
    $slide = $Deck.Slides.Item($slideIndex)
    $items = @()
    for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
      $shape = $slide.Shapes.Item($shapeIndex)
      $item = [ordered]@{
        index = $shapeIndex; name = [string]$shape.Name; id = [int]$shape.Id; type = [int]$shape.Type
        left = [double]$shape.Left; top = [double]$shape.Top; width = [double]$shape.Width; height = [double]$shape.Height; rotation = [double]$shape.Rotation
      }
      if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
        $item.text = [string]$shape.TextFrame.TextRange.Text
        $item.paragraphs = [int]$shape.TextFrame.TextRange.Paragraphs().Count
        $item.font = [string]$shape.TextFrame.TextRange.Font.Name
        if ($shape.Name -like 'sd-native-text-*') { $counts.text++ }
      }
      if ($shape.Name -like 'sd-native-shape-*') { $counts.shapes++; $item.fillRgb = [int]$shape.Fill.ForeColor.RGB }
      if ($shape.Type -eq 13) {
        $counts.pictures++
        if ($shape.Name -like 'sd-native-image-*' -and $shape.Name -notlike 'sd-native-image-background-*') {
          $item.crop = [ordered]@{ left = [double]$shape.PictureFormat.CropLeft; top = [double]$shape.PictureFormat.CropTop; right = [double]$shape.PictureFormat.CropRight; bottom = [double]$shape.PictureFormat.CropBottom }
          if (($item.crop.left + $item.crop.top + $item.crop.right + $item.crop.bottom) -gt 0) { $counts.croppedImages++ }
        }
      }
      if ($shape.Type -eq 6) { $counts.groups++ }
      if ($shape.HasTable -eq -1) {
        $counts.tables++
        $item.table = [ordered]@{ rows = [int]$shape.Table.Rows.Count; columns = [int]$shape.Table.Columns.Count; cell22 = [string]$shape.Table.Cell(2, 2).Shape.TextFrame.TextRange.Text }
      }
      if ($shape.HasChart -eq -1) {
        $counts.charts++
        $item.chart = [ordered]@{ type = [int]$shape.Chart.ChartType; series = [int]$shape.Chart.SeriesCollection().Count; values = @($shape.Chart.SeriesCollection(1).Values) }
      }
      $items += $item
    }
    $notes = @()
    for ($n = 1; $n -le $slide.NotesPage.Shapes.Count; $n++) {
      $noteShape = $slide.NotesPage.Shapes.Item($n)
      if ($noteShape.HasTextFrame -eq -1 -and $noteShape.TextFrame.HasText -eq -1) { $notes += [string]$noteShape.TextFrame.TextRange.Text }
    }
    $transition = [int]$slide.SlideShowTransition.EntryEffect
    $animationCount = [int]$slide.TimeLine.MainSequence.Count
    $animationEffects = @()
    for ($effectIndex = 1; $effectIndex -le $animationCount; $effectIndex++) {
      $effect = $slide.TimeLine.MainSequence.Item($effectIndex)
      $animationEffects += [ordered]@{ type = [int]$effect.EffectType; shapeName = [string]$effect.Shape.Name; trigger = [int]$effect.Timing.TriggerType; duration = [double]$effect.Timing.Duration }
    }
    if ($transition -ne 0) { $counts.transitions++ }
    $counts.animations += $animationCount
    $slides += [ordered]@{ index = $slideIndex; name = [string]$slide.Name; notes = ($notes -join "`n"); transition = $transition; animations = $animationCount; animationEffects = $animationEffects; shapes = $items }
  }
  return [ordered]@{ slideCount = [int]$Deck.Slides.Count; width = [double]$Deck.PageSetup.SlideWidth; height = [double]$Deck.PageSetup.SlideHeight; counts = $counts; slides = $slides }
}

function Find-Shape($Deck, [string]$Name, [int]$SlideIndex) {
  $slide = $Deck.Slides.Item($SlideIndex)
  for ($i = 1; $i -le $slide.Shapes.Count; $i++) { if ($slide.Shapes.Item($i).Name -eq $Name) { return $slide.Shapes.Item($i) } }
  throw "Expected shape missing: $Name on slide $SlideIndex"
}

function Check-Effects($Snapshot, $Expected, [string]$Phase) {
  # Microsoft enum references:
  # https://learn.microsoft.com/en-us/office/vba/api/powerpoint.ppentryeffect
  # https://learn.microsoft.com/en-us/office/vba/api/powerpoint.msoanimeffect
  foreach ($effect in $Expected) {
    $slide = $Snapshot.slides[$effect.slide - 1]
    Check ($effect.transition -contains $slide.transition) ("$Phase slide $($effect.slide) transition type") $slide.transition
    $actualTypes = @($slide.animationEffects | ForEach-Object { $_.type } | Sort-Object)
    $expectedTypes = @($effect.animationTypes | Sort-Object)
    Check (($actualTypes -join ',') -eq ($expectedTypes -join ',')) ("$Phase slide $($effect.slide) animation types") $actualTypes
    foreach ($animation in $slide.animationEffects) {
      Check ($animation.trigger -eq 2) ("$Phase slide $($effect.slide) animation starts with previous: " + $animation.shapeName) $animation.trigger
      $validDuration = if ($animation.type -eq 10) { [Math]::Abs($animation.duration - .5) -lt .01 } else { $animation.duration -gt 0 -and $animation.duration -le .01 }
      Check $validDuration ("$Phase slide $($effect.slide) animation duration: " + $animation.shapeName) $animation.duration
    }
  }
}

try {
  $inputPath = (Resolve-Path -LiteralPath $InputPptx).Path
  if (-not $ManifestPath) { $ManifestPath = Join-Path (Split-Path -Parent $inputPath) 'fixture-manifest.json' }
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Check ($manifest.generator -eq 'production startStudio + Store.save + exportDeck(pptx-editable)') 'Generated service fixture provenance'
  $inputHash = (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Check ($inputHash -eq $manifest.sha256) 'Fixture hash matches manifest'
  Check ([IO.Path]::GetFullPath($manifest.pptx) -eq $inputPath) 'Input is the generated fixture path'
  $result.input = $inputPath
  $result.inputSha256 = $inputHash
  $running = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
  Check ($running.Count -eq 0) 'No existing PowerPoint process; user presentations remain untouched' $running.Count
  $result.existingExcelProcesses = @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $app = New-Object -ComObject PowerPoint.Application
  $createdApplication = $true
  $app.AutomationSecurity = 3
  # Keep Office repair prompts visible; never silently accept a repaired file.
  $app.DisplayAlerts = 2
  $result.office = [ordered]@{ version = [string]$app.Version; build = [string]$app.Build }
  Check ($app.Presentations.Count -eq 0) 'New PowerPoint application has no user presentations' $app.Presentations.Count
  # ReadOnly=false, Untitled=false, WithWindow=false. Only SaveAs writes a file.
  $presentation = $app.Presentations.Open($inputPath, 0, 0, 0)
  $before = Read-Presentation $presentation
  $result.before = $before
  Check-Effects $before $manifest.expectedEffects 'Initial open'
  Check ($before.slideCount -eq $manifest.slideCount) 'Slide count' $before.slideCount
  Check ([Math]::Abs($before.width - $manifest.slideSizePoints.width) -lt .1 -and [Math]::Abs($before.height - $manifest.slideSizePoints.height) -lt .1) '16:9 slide dimensions in points' @($before.width, $before.height)
  foreach ($pair in @(@('text', 'nativeText'), @('shapes', 'nativeShapes'), @('croppedImages', 'croppedImages'), @('tables', 'tables'), @('charts', 'charts'), @('transitions', 'transitions'), @('animations', 'animations'))) {
    $actual = $before.counts[$pair[0]]
    $required = $manifest.required.($pair[1])
    Check ($actual -ge $required) ("Native capability: " + $pair[0]) $actual
  }
  $firstSlide = $before.slides[0]
  Check ($firstSlide.notes.Contains($manifest.notesMarker)) 'Korean speaker notes available in actual PowerPoint'
  $allText = ($firstSlide.shapes | ForEach-Object { $_.text }) -join "`n"
  Check ($allText.Contains('PowerPoint 호환성') -and $allText.Contains('Ω')) 'Korean and Unicode text remain editable'
  Check ($allText.Contains($manifest.groupTextMarker)) 'Grouped text exported as independently editable native text'
  $rich = @($firstSlide.shapes | Where-Object { $_.text -and $_.text.Contains($manifest.richTextMarker) })
  Check ($rich.Count -eq 1 -and $rich[0].paragraphs -ge 3) 'Rich text paragraph structure' $(if ($rich.Count) { $rich[0].paragraphs } else { 0 })
  foreach ($expected in $manifest.expectedGeometry) {
    $actualShape = Find-Shape $presentation $expected.name $expected.slide
    $difference = @([Math]::Abs($actualShape.Left - $expected.x), [Math]::Abs($actualShape.Top - $expected.y), [Math]::Abs($actualShape.Width - $expected.w), [Math]::Abs($actualShape.Height - $expected.h), [Math]::Abs($actualShape.Rotation - $expected.rotation))
    Check (($difference | Measure-Object -Maximum).Maximum -lt .2) ("Native object geometry: " + $expected.name) $difference
  }
  for ($i = 1; $i -le $presentation.Slides.Count; $i++) {
    $presentation.Slides.Item($i).Export((Join-Path $outputRoot "powerpoint-before-slide-$i.png"), 'PNG', 1920, 1080)
  }

  $textShape = Find-Shape $presentation $manifest.expectedGeometry[0].name 1
  $changedText = 'PowerPoint에서 수정됨 — 저장 후 재확인 Ω'
  $textShape.TextFrame.TextRange.Text = $changedText
  $result.edits += [ordered]@{ kind = 'text'; slide = 1; name = [string]$textShape.Name; expected = $changedText }
  $basicShape = Find-Shape $presentation $manifest.expectedGeometry[1].name 1
  $newLeft = [double]$basicShape.Left + 12
  $newFill = 0x0066AA22
  $basicShape.Left = $newLeft
  $basicShape.Fill.ForeColor.RGB = $newFill
  $result.edits += [ordered]@{ kind = 'shape'; slide = 1; name = [string]$basicShape.Name; expectedLeft = $newLeft; expectedFillRgb = $newFill }

  $tableEdited = $false
  $chartEdited = $false
  for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
    $slide = $presentation.Slides.Item($slideIndex)
    for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
      $shape = $slide.Shapes.Item($shapeIndex)
      if ($shape.HasTable -eq -1 -and -not $tableEdited) {
        $changedCell = '수정됨 73'
        $shape.Table.Cell(2, 2).Shape.TextFrame.TextRange.Text = $changedCell
        $result.edits += [ordered]@{ kind = 'table'; slide = $slideIndex; name = [string]$shape.Name; expectedCell22 = $changedCell }
        $tableEdited = $true
      }
      if ($shape.HasChart -eq -1 -and -not $chartEdited) {
        # ChartData activates only this presentation's embedded workbook. Never
        # enumerate/close other Excel workbooks or quit an existing Excel app.
        $shape.Chart.ChartData.Activate()
        $chartWorkbook = $shape.Chart.ChartData.Workbook
        $sheet = $chartWorkbook.Worksheets.Item(1)
        $oldValue = $sheet.Cells.Item(2, 2).Value2
        $changedValue = 73.5
        $sheet.Cells.Item(2, 2).Value2 = $changedValue
        $shape.Chart.Refresh()
        $chartWorkbook.Close($true)
        $chartWorkbook = $null
        $shape.Chart.Refresh()
        $result.edits += [ordered]@{ kind = 'chart'; slide = $slideIndex; name = [string]$shape.Name; oldValue = $oldValue; expectedValue = $changedValue; address = 'B2' }
        $chartEdited = $true
      }
    }
  }
  if ($manifest.required.tables -gt 0) { Check $tableEdited 'Actual PowerPoint table cell edited' }
  if ($manifest.required.charts -gt 0) { Check $chartEdited 'Actual PowerPoint embedded chart workbook edited' }
  $editedPath = Join-Path $outputRoot ('fixture-edited-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.pptx')
  $presentation.SaveAs($editedPath, 24)
  $presentation.Close()
  $presentation = $null
  $result.editedPptx = $editedPath
  $presentation = $app.Presentations.Open($editedPath, 0, 0, 0)
  $after = Read-Presentation $presentation
  $result.after = $after
  Check-Effects $after $manifest.expectedEffects 'Save and reopen'
  foreach ($edit in $result.edits) {
    $shape = Find-Shape $presentation $edit.name $edit.slide
    switch ($edit.kind) {
      'text' { Check ($shape.TextFrame.TextRange.Text -eq $edit.expected) 'Edited text persists after save and reopen' $shape.TextFrame.TextRange.Text }
      'shape' {
        Check ([Math]::Abs($shape.Left - $edit.expectedLeft) -lt .1) 'Edited shape position persists after save and reopen' $shape.Left
        Check ($shape.Fill.ForeColor.RGB -eq $edit.expectedFillRgb) 'Edited shape fill persists after save and reopen' $shape.Fill.ForeColor.RGB
      }
      'table' { Check ($shape.Table.Cell(2, 2).Shape.TextFrame.TextRange.Text -eq $edit.expectedCell22) 'Edited table cell persists after save and reopen' $shape.Table.Cell(2, 2).Shape.TextFrame.TextRange.Text }
      'chart' {
        $values = @($shape.Chart.SeriesCollection(1).Values)
        Check ([Math]::Abs([double]$values[0] - $edit.expectedValue) -lt .0001) 'Edited chart series persists after save and reopen' $values
        $shape.Chart.ChartData.Activate()
        $chartWorkbook = $shape.Chart.ChartData.Workbook
        $persisted = $chartWorkbook.Worksheets.Item(1).Cells.Item(2, 2).Value2
        Check ([Math]::Abs([double]$persisted - $edit.expectedValue) -lt .0001) 'Embedded workbook B2 persists after save and reopen' $persisted
        $chartWorkbook.Close($false)
        $chartWorkbook = $null
      }
    }
  }
  for ($i = 1; $i -le $presentation.Slides.Count; $i++) {
    $presentation.Slides.Item($i).Export((Join-Path $outputRoot "powerpoint-after-slide-$i.png"), 'PNG', 1920, 1080)
  }
  $presentation.Saved = -1
  $presentation.Close()
  $presentation = $null
  Check ((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $inputHash) 'Original generated fixture remains byte-for-byte unchanged'
  $result.passed = $true
} catch {
  $result.errors += [ordered]@{ message = $_.Exception.Message; location = $_.InvocationInfo.PositionMessage; stack = $_.ScriptStackTrace }
} finally {
  if ($null -ne $chartWorkbook) { try { $chartWorkbook.Close($false) } catch { $result.errors += [ordered]@{ message = 'Embedded workbook cleanup: ' + $_.Exception.Message } } }
  if ($null -ne $presentation) { try { $presentation.Saved = -1; $presentation.Close() } catch { $result.errors += [ordered]@{ message = 'Fixture presentation cleanup: ' + $_.Exception.Message } } }
  if ($createdApplication -and $null -ne $app) {
    try {
      # A user could open another presentation during this run. Leave that app
      # open in that case; only the generated fixture above is ours to close.
      if ($app.Presentations.Count -eq 0) { $app.Quit() } else { $result.applicationLeftOpen = 'Another presentation is open; application was not quit.' }
    } catch { $result.errors += [ordered]@{ message = 'PowerPoint cleanup: ' + $_.Exception.Message } }
  }
  $presentation = $null
  $app = $null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  if ($result.errors.Count -gt 0) { $result.passed = $false }
  $result.completedAt = [DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText($reportPath, ($result | ConvertTo-Json -Depth 20), $utf8)
}
Write-Output ($result | ConvertTo-Json -Depth 20)
if (-not $result.passed) { exit 1 }
