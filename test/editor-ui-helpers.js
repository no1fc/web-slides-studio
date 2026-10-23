// Follow the visible editor shell; never bypass a hidden control or its dialog.
export async function openRibbonTab(page, name) {
  const opener = { format: 'slideToolsBtn', arrange: 'slideToolsBtn', insert: 'insertToolsBtn', slide: 'designToolsBtn', transition: 'designToolsBtn', present: 'fileToolsBtn', file: 'fileToolsBtn' }[name];
  const tab = page.locator(`#ribbon-${name}-tab`);
  if (!await tab.isVisible()) await page.locator(`#${opener}`).click();
  await tab.click();
}

export async function openInspector(page, name = 'format') {
  if (!await page.locator('.inspector').isVisible()) await page.locator('#inspectorToggleBtn').click();
  const tab = page.locator(`#inspector-${name}-tab`);
  if (!await tab.isVisible()) {
    await openRibbonTab(page, name === 'format' ? 'format' : 'arrange');
    if (name === 'layers') await page.locator('#showLayersBtn').click();
    else await page.locator('#collapseRibbonBtn').click();
  } else await tab.click();
}

export async function showEditorControl(page, id) {
  const control = page.locator(`#${id}`);
  if (await control.isVisible()) return;
  const parent = await control.evaluate(node => ({
    inspector: node.closest('.shell-inspector-scroll > section')?.id,
    ribbon: node.closest('.ribbon-panel')?.id,
    inRibbon: !!node.closest('#editorRibbon'),
  }));
  if (parent.inspector) await openInspector(page, parent.inspector.replace('inspector-', ''));
  else if (parent.inRibbon) await openRibbonTab(page, parent.ribbon?.replace('ribbon-', '') || 'insert');
  await control.waitFor({ state: 'visible' });
}

export async function clickEditorTool(page, id) {
  await showEditorControl(page, id);
  await page.locator(`#${id}`).click();
}
