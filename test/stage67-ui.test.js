import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import pptxgen from 'pptxgenjs';
import { startStudio } from '../src/server.js';
import { prepareDeck } from '../src/deck.js';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'studio-data-ui-')),app=await startStudio({port:0,contentPort:0,root});let browser;
  try {
    const prepared=prepareDeck('<html><head><style>body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{display:none;position:absolute;inset:0;background:white}.slide.active{display:block}</style></head><body><main id="stage"><section class="slide active"></section></main></body></html>');
    const deck=await app.store.create({...prepared,files:new Map([['index.html',Buffer.from(prepared.html)]])});
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(8000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(app.origin+'/#deck='+deck.id);
    const ready=()=>page.waitForFunction(()=>typeof frameReady!=='undefined'&&frameReady&&!transitionBusy&&!objectBusy);
    await ready();
    const saved=async()=>{await page.waitForFunction(()=>!dirty&&!saving&&!transitionBusy);return (await app.store.get(deck.id)).state;};
    await run({page,app,deck,ready,saved,browser});assert.deepEqual(errors,[]);
  }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
}
test('table cell editing, native selection, duplication, undo and reload retain data',()=>fixture(async({page,ready,saved})=>{
  await page.locator('#addTableBtn').click();
  await page.getByRole('textbox',{name:'1행 1열',exact:true}).fill('이름');
  await page.getByRole('textbox',{name:'2행 1열',exact:true}).fill('한국어');
  await page.getByRole('textbox',{name:'2행 2열',exact:true}).fill('42');
  await page.locator('#applyDataBtn').click();await ready();let state=await saved();
  assert.equal(state.added.length,1);const id=state.added[0].id;
  await page.waitForFunction(id=>selected?.id===id,id);
  assert.equal(await page.locator('#rotateValue').isDisabled(),true);
  assert.equal(await page.locator('#groupObjectsBtn').isDisabled(),true);
  assert.equal(await page.evaluate(()=>selected.groupable),false);
  await page.locator('#editDataBtn').click();await page.locator('#dataBulkDetails').waitFor({state:'visible'});await page.locator('#dataBulkDetails').evaluate(el=>el.open=true);await page.locator('#dataGridValue').fill('이름\t값\n바뀐 셀\t84');await page.locator('#applyDataBtn').click();await ready();
  state=await saved();assert.equal(state.patches[id].table.rows[1][0],'바뀐 셀');
  await page.waitForFunction(id=>selected?.id===id,id);
  await page.locator('#duplicateObjectsBtn').click();await ready();
  await page.waitForFunction(()=>state.added.length===2);state=await saved();assert.equal(state.added[1].table.rows[1][1],'84');
  await page.locator('#undoBtn').click();await ready();assert.equal((await saved()).added.length,1);
  await page.reload();await ready();state=await saved();assert.equal(state.patches[id].table.rows[1][0],'바뀐 셀');
}));
test('chart validation, effects, slide duplication and static export viewer retain coherent state',()=>fixture(async({page,ready,saved,app,deck,browser})=>{
  await page.locator('#addChartBtn').click();await page.locator('#dataBulkDetails').waitFor({state:'visible'});await page.locator('#dataBulkDetails').evaluate(el=>el.open=true);await page.locator('#dataGridValue').fill('항목\t매출\n1분기\tbad');await page.locator('#applyDataBtn').click();
  await page.waitForFunction(()=>document.querySelector('#dataEditError').textContent.length>0);assert.equal((await saved()).added.length,0);
  await page.locator('#dataBulkDetails').waitFor({state:'visible'});await page.locator('#dataBulkDetails').evaluate(el=>el.open=true);await page.locator('#dataGridValue').fill('항목\t매출\n1분기\t12\n2분기\t18');await page.locator('#applyDataBtn').click();await ready();let state=await saved();const id=state.added[0].id;
  await page.waitForFunction(id=>selected?.id===id,id);await page.locator('#ribbon-slide-tab').click();await page.locator('#effectsBtn').click();await page.locator('#transitionValue').selectOption('push');await page.locator('#animationValue').selectOption('fade');await page.locator('#applyEffectsBtn').click();await ready();state=await saved();assert.equal(state.animations[id],'fade');
  await page.locator('#duplicateSlideBtn').click();await ready();state=await saved();const duplicate=state.added.find(a=>a.slide!== 's0');assert.equal(state.transitions[duplicate.slide],'push');assert.equal(state.animations[duplicate.id],'fade');
  const current=await app.store.get(deck.id),viewer=await browser.newPage({viewport:{width:1920,height:1080}});
  await viewer.goto(`${app.contentOrigin}/v/${deck.id}/${current.previewToken}/index.html?rev=${current.revision}`);await viewer.waitForFunction(()=>!!window.__sd);
  await viewer.evaluate(()=>{window.__sd.go(1);window.__sd.clean();});assert.equal(await viewer.evaluate(()=>document.getAnimations().length),0);
  assert.equal(await viewer.locator('[data-sd-slide]').nth(1).locator('svg').count(),1);await viewer.close();
}));
test('PPTX import previews warnings without creating a deck and creates only after confirmation',()=>fixture(async({page,app})=>{
  const ppt=new pptxgen();ppt.layout='LAYOUT_WIDE';ppt.addSlide().addText('Imported title',{x:1,y:1,w:6,h:1,fontSize:32});
  ppt.addSlide().addText('Second imported slide',{x:1,y:1,w:6,h:1,fontSize:32});
  const buffer=await ppt.write({outputType:'nodebuffer'}),before=(await app.store.list()).length;
  await page.locator('#libraryBtn').click();await page.waitForFunction(()=>deck===null);
  await page.locator('#pptxInput').setInputFiles({name:'editable.pptx',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',buffer});
  await page.locator('#confirmPptxImportBtn').waitFor();assert.equal((await app.store.list()).length,before);
  await page.locator('#confirmPptxImportBtn').click();await page.waitForFunction(()=>!transitionBusy&&frameReady&&state.added.some(a=>a.text?.includes('Imported title')));
  assert.equal((await app.store.list()).length,before+1);
  await page.locator('.slide-item').nth(1).click();await page.waitForFunction(()=>!transitionBusy&&index===1);
  const frame=page.frameLocator('#deckFrame');
  assert.equal(await frame.locator('[data-sd-slide="s0"]').isVisible(),false);
  assert.equal(await frame.getByText('Second imported slide',{exact:true}).isVisible(),true);
  const stage=await frame.locator('#stage').boundingBox(),canvas=await page.locator('#deckFrame').boundingBox();
  assert.ok(Math.abs(stage.width-canvas.width)<2);
}));
test('data dialog locks during save and quoted multiline cells survive a no-op edit',()=>fixture(async({page,ready,saved})=>{
  await page.locator('#addTableBtn').click();
  await page.locator('#dataBulkDetails').waitFor({state:'visible'});await page.locator('#dataBulkDetails').evaluate(el=>el.open=true);await page.locator('#dataGridValue').fill('"줄1\n줄2"\t"탭\t셀"\n""\t끝');
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/validate',async route=>{await gate;await route.continue();});
  await page.locator('#applyDataBtn').click();
  assert.equal(await page.locator('#closeDialog').isDisabled(),true);assert.equal(await page.locator('#dataGridValue').isDisabled(),true);assert.equal(await page.locator('#dataGrid textarea').first().isDisabled(),true);assert.equal(await page.locator('#dataAddRowBtn').isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#dialog').isVisible(),true);
  release();await ready();let state=await saved();const id=state.added[0].id,rows=state.added[0].table.rows;
  assert.deepEqual(rows,[['줄1\n줄2','탭\t셀'],['','끝']]);await page.waitForFunction(id=>selected?.id===id,id);
  await page.locator('#editDataBtn').click();await page.locator('#applyDataBtn').click();await ready();state=await saved();assert.deepEqual(state.patches[id].table.rows,rows);
}));
test('export collection keeps measured rich text native and preserves clipped tables as raster',()=>fixture(async({app,deck,browser})=>{
  deck.state.added=[
    {id:'a-rich',slide:'s0',kind:'text',x:20,y:20,w:800,h:300,fontSize:40,richText:{paragraphs:[{runs:[{text:'한국어 rich',fontSize:52}],lineHeight:1.2},{runs:[{text:'second',fontSize:40}],lineHeight:1.4}]}},
    {id:'a-table',slide:'s0',kind:'table',x:900,y:20,w:500,h:20,table:{rows:[['Too short']],fontSize:40}},
  ];const current=await app.store.save(deck.id,deck.revision,deck.state),viewer=await browser.newPage({viewport:{width:1920,height:1080}});
  await viewer.goto(`${app.contentOrigin}/v/${deck.id}/${current.previewToken}/index.html?rev=${current.revision}`);await viewer.waitForFunction(()=>!!window.__sd);
  const objects=await viewer.evaluate(()=>{window.__sd.clean();return window.__sd.collect();});
  const rich=objects.find(o=>o.id==='a-rich');assert.equal(rich.nativeSupported,true);assert.ok(Math.abs(rich.renderedLineHeights[0]-62.4)<.1);assert.equal(rich.richText.paragraphs[0].renderedLineHeight,undefined);
  assert.equal(objects.find(o=>o.id==='a-table').nativeSupported,false);await viewer.close();
}));

test('group and ungroup preserve a shared entrance effect and reject mixed effects',()=>fixture(async({page,app,deck,ready,saved})=>{
  deck.state.added=[
    {id:'a-one',slide:'s0',kind:'shape',x:100,y:100,w:200,h:150,fill:'#123456'},
    {id:'a-two',slide:'s0',kind:'shape',x:400,y:100,w:200,h:150,fill:'#654321'},
  ];deck.state.animations={'a-one':'fade','a-two':'fade'};
  await app.store.save(deck.id,deck.revision,deck.state);await page.reload();await ready();
  const select=async ids=>{
    await page.evaluate(ids=>post('select-ids',{ids}),ids);
    await page.waitForFunction(ids=>selectedElements.length===ids.length&&ids.every(id=>selectedElements.some(e=>e.id===id)),ids);
  };
  await select(['a-one','a-two']);await page.locator('#ribbon-arrange-tab').click();await page.locator('#groupObjectsBtn').click();
  await page.waitForFunction(()=>state.added.length===1&&state.added[0].kind==='group');await ready();
  let state=await saved();const group=state.added[0];assert.deepEqual(state.animations,{[group.id]:'fade'});
  await select([group.id]);await page.locator('#ungroupObjectsBtn').click();
  await page.waitForFunction(()=>state.added.length===2&&state.added.every(o=>o.kind==='shape'));await ready();
  state=await saved();assert.equal(Object.keys(state.animations).length,2);assert.ok(state.added.every(o=>state.animations[o.id]==='fade'));
  const ids=state.added.map(o=>o.id);await select([ids[0]]);
  await page.locator('#ribbon-slide-tab').click();await page.locator('#effectsBtn').click();await page.locator('#animationValue').selectOption('appear');await page.locator('#applyEffectsBtn').click();await ready();
  const before=await saved();await select(ids);await page.locator('#ribbon-arrange-tab').click();await page.locator('#groupObjectsBtn').click();
  await page.getByText('서로 다른 진입 효과가 있습니다. 효과를 같게 맞춘 뒤 그룹으로 묶어 주세요.',{exact:true}).waitFor();
  assert.deepEqual(await saved(),before);
}));

const cell=(page,row,col)=>page.getByRole('textbox',{name:`${row}행 ${col}열`,exact:true});
const pasteCells=(target,text)=>target.evaluate((element,text)=>{
  const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);
  element.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
},text);

test('visual grid adds and removes selected rows and columns, pastes TSV and persists',()=>fixture(async({page,ready,saved})=>{
  await page.locator('#addTableBtn').click();
  assert.equal(await page.locator('#dataBulkDetails').getAttribute('open'),null);
  await page.locator('#dataAddRowBtn').click();await cell(page,4,1).fill('새 행');
  await page.locator('#dataAddColumnBtn').click();await cell(page,4,3).fill('삭제할 열');
  await cell(page,2,3).focus();await page.locator('#dataRemoveColumnBtn').click();
  await cell(page,3,1).focus();await page.locator('#dataRemoveRowBtn').click();
  assert.equal(await cell(page,3,1).inputValue(),'새 행');
  await pasteCells(cell(page,2,1),'서울\t25\n부산\t30\n대전\t40');
  assert.equal(await cell(page,4,2).inputValue(),'40');
  await page.locator('#applyDataBtn').click();await ready();
  let state=await saved();assert.deepEqual(state.added[0].table.rows,[['항목','값'],['서울','25'],['부산','30'],['대전','40']]);
  await page.reload();await ready();state=await saved();assert.equal(state.added[0].table.rows[3][0],'대전');
}));

test('grid limits reject oversized paste without losing cells and bulk edits stay synchronized',()=>fixture(async({page})=>{
  await page.locator('#addTableBtn').click();
  await pasteCells(cell(page,1,1),Array.from({length:20},(_,r)=>Array.from({length:10},(_,c)=>`${r}:${c}`).join('\t')).join('\n'));
  assert.equal(await page.locator('#dataAddRowBtn').isDisabled(),true);assert.equal(await page.locator('#dataAddColumnBtn').isDisabled(),true);
  await pasteCells(cell(page,20,10),'overflow\tvalue');
  assert.equal(await cell(page,20,10).inputValue(),'19:9');assert.match(await page.locator('#dataEditError').innerText(),/최대/);
  await page.locator('#dataBulkDetails').waitFor({state:'visible'});await page.locator('#dataBulkDetails').evaluate(el=>el.open=true);
  await page.locator('#dataGridValue').fill('A\tB\nC');
  assert.equal(await cell(page,1,1).isDisabled(),true);
  await page.locator('#dataGridValue').fill('one');
  assert.equal(await cell(page,1,1).inputValue(),'one');assert.equal(await cell(page,1,1).isDisabled(),false);
  assert.equal(await page.locator('#dataRemoveRowBtn').isDisabled(),true);assert.equal(await page.locator('#dataRemoveColumnBtn').isDisabled(),true);
  await cell(page,1,1).fill('two');assert.equal(await page.locator('#dataGridValue').inputValue(),'two');
}));

test('chart cells validate numeric input and save chart type and series colors',()=>fixture(async({page,ready,saved})=>{
  await page.locator('#addChartBtn').click();
  await cell(page,1,1).focus();assert.equal(await page.locator('#dataRemoveRowBtn').isDisabled(),true);assert.equal(await page.locator('#dataRemoveColumnBtn').isDisabled(),true);
  await cell(page,2,2).fill('not a number');await page.locator('#applyDataBtn').click();
  await page.waitForFunction(()=>document.querySelector('#dataEditError').textContent.length>0);assert.match(await page.locator('#dataEditError').innerText(),/숫자/);assert.equal((await saved()).added.length,0);
  await cell(page,2,2).fill('12');await cell(page,1,2).fill('매출');
  await page.locator('#dataAddColumnBtn').click();await cell(page,1,3).fill('비용');
  await page.locator('#chartColor-1').fill('#123456');await page.locator('#chartTypeValue').selectOption('line');
  await page.locator('#applyDataBtn').click();await ready();let state=await saved();
  assert.equal(state.added[0].chart.type,'line');assert.equal(state.added[0].chart.series[0].values[0],12);
  assert.equal(state.added[0].chart.series[1].name,'비용');assert.equal(state.added[0].chart.colors[1],'#123456');
  await page.waitForFunction(()=>selected?.id===state.added[0].id);await page.locator('#editDataBtn').click();
  await page.locator('#chartTypeValue').selectOption('pie');await page.locator('#applyDataBtn').click();await page.waitForFunction(()=>document.querySelector('#dataEditError').textContent.length>0);assert.match(await page.locator('#dataEditError').innerText(),/한 계열/);
  await cell(page,2,3).focus();await page.locator('#dataRemoveColumnBtn').click();
  await cell(page,2,2).fill('-1');await page.locator('#applyDataBtn').click();await page.waitForFunction(()=>document.querySelector('#dataEditError').textContent.length>0);assert.match(await page.locator('#dataEditError').innerText(),/음이 아닌/);
  await cell(page,2,2).fill('12');await page.locator('#chartColor-2').fill('#abcdef');await page.locator('#applyDataBtn').click();await ready();state=await saved();
  const id=state.added[0].id;assert.equal(state.patches[id].chart.type,'pie');assert.equal(state.patches[id].chart.colors[2],'#abcdef');
  await page.reload();await ready();assert.equal((await saved()).patches[id].chart.colors[2],'#abcdef');
}));
