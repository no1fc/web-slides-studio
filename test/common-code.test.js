import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { startStudio } from '../src/server.js';
import { initialState, prepareDeck, renderDeck, validateState } from '../src/deck.js';
import { exportDeck } from '../src/export.js';

const source='<html><head><style>body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{display:none;position:absolute;inset:0;background:white}.slide.active{display:block}</style><link rel="stylesheet" href="theme.css"><script type="application/json" id="data">{"a":1}</script></head><body><main id="stage"><section class="slide active"><h1>제목</h1></section><section class="slide"><p>둘째</p></section></main><script src="vendor.min.js"></script><script src="app.js"></script><script>document.body.dataset.inline="original";</script></body></html>';
const files=prepared=>new Map([['index.html',Buffer.from(prepared.html)],['theme.css',Buffer.from('h1{color:rgb(0, 0, 255)}')],['app.js',Buffer.from('document.body.dataset.app="original";')],['vendor.min.js',Buffer.from('/*lib*/')]]);

test('common code overrides validate and replace only the addressed inline block',()=>{
  const input=prepareDeck(source), state=initialState(input);
  assert.deepEqual(state.common,{});
  assert.deepEqual(validateState({order:state.order,patches:{},added:[],background:true},input).common,{});
  state.common={'style:0':'body{margin:1px}','script:0':'document.body.dataset.inline="edited";','file:theme.css':'h1{color:red}'};
  const html=renderDeck(input.html,validateState(state,input));
  assert.match(html,/<style>body\{margin:1px\}<\/style>/);assert.match(html,/dataset\.inline="edited"/);assert.match(html,/\{"a":1\}/);
  for(const common of [{'style:0':'a{}</style><script>'},{'script:0':'x</script>'},{'file:../x.css':''},{'file:a.html':''},{'weird':''},{'style:0':1}])
    assert.throws(()=>validateState({...state,common},input),/공통|경로/,JSON.stringify(common));
});

test('editor lists common code beside the slide, applies both together; files, export and AI rules follow',async()=>{
  const root=await mkdtemp(join(tmpdir(),'studio-common-')),app=await startStudio({port:0,contentPort:0,root});let browser;
  try{
    const prepared=prepareDeck(source),deck=await app.store.create({...prepared,files:files(prepared)});
    const listed=await(await fetch(`${app.origin}/api/decks/${deck.id}/authoring?slide=s0`)).json();
    assert.deepEqual(listed.common.map(e=>[e.key,e.kind]),[['style:0','css'],['file:theme.css','css'],['file:app.js','js'],['script:0','js']]);
    assert.deepEqual(listed.skipped,['vendor.min.js']);
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(8000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(app.origin+'/#deck='+deck.id);
    const ready=()=>page.waitForFunction(()=>typeof frameReady!=='undefined'&&frameReady&&!transitionBusy&&!objectBusy);
    const saved=async()=>{await page.waitForFunction(()=>!dirty&&!saving&&!transitionBusy);return (await app.store.get(deck.id)).state;};
    const apply=async()=>{await page.locator('#codeApplyBtn').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await ready();return saved();};
    await ready();
    await page.locator('#designToolsBtn').click();await page.locator('#ribbon-slide-tab').click();await page.getByRole('button',{name:'슬라이드 코드(HTML/CSS/JS)…'}).click();
    await page.locator('#codeCommonTab').click();
    assert.equal(await page.locator('#commonCode').inputValue(),listed.common[0].original);
    await page.locator('#commonSelect').selectOption('file:theme.css');await page.locator('#commonCode').fill('h1{color:rgb(255, 0, 0)}');
    await page.locator('#commonSelect').selectOption('file:app.js');await page.locator('#commonCode').fill('document.body.dataset.app="edited";');
    await page.locator('#commonSelect').selectOption('file:theme.css');assert.match(await page.locator('#commonCode').inputValue(),/255, 0, 0/);
    assert.match(await page.locator('#commonSelect option:checked').textContent(),/수정됨/);
    let state=await apply();
    assert.deepEqual(state.common,{'file:theme.css':'h1{color:rgb(255, 0, 0)}','file:app.js':'document.body.dataset.app="edited";'});
    assert.deepEqual(state.slideCode,{},'공통만 바꾸면 슬라이드는 원본 그대로');
    const frame=page.frameLocator('#deckFrame');
    assert.equal(await frame.locator('h1').evaluate(e=>getComputedStyle(e).color),'rgb(255, 0, 0)');
    assert.equal(await frame.locator('body').getAttribute('data-app'),'edited');
    assert.match((await readFile(app.store.path(deck.id,'assets','theme.css'),'utf8')),/0, 0, 255/,'가져온 원본 파일은 보존');
    const zip=await JSZip.loadAsync((await exportDeck({store:app.store,deck:await app.store.get(deck.id),format:'html'})).buffer);
    assert.match(await zip.file('theme.css').async('string'),/255, 0, 0/);
    // AI proposals may not change common code.
    const current=await app.store.get(deck.id),proposal=structuredClone(current.state);proposal.common['file:app.js']='fetch("/x")';
    const refused=await fetch(`${app.origin}/api/decks/${deck.id}/proposals`,{method:'POST',headers:{'Content-Type':'application/json',Origin:app.origin},body:JSON.stringify({revision:current.revision,state:proposal})});
    assert.equal(refused.status,400);assert.match((await refused.json()).error,/공통/);
    // Slide and common edits in one apply; revert drops the override.
    await page.locator('#codeBtn').dispatchEvent('click');await page.locator('#codeHtml').waitFor();
    await page.locator('#codeHtml').fill('<h1>새 제목</h1>');
    await page.locator('#codeCommonTab').click();await page.locator('#commonSelect').selectOption('file:app.js');await page.locator('#commonRevertBtn').click();
    await page.locator('#commonSelect').selectOption('script:0');await page.locator('#commonCode').fill('document.body.dataset.inline="edited";');
    state=await apply();
    assert.deepEqual(Object.keys(state.common).sort(),['file:theme.css','script:0']);assert.match(state.slideCode.s0.html,/새 제목/);
    assert.equal(await frame.locator('body').getAttribute('data-inline'),'edited');assert.equal(await frame.locator('body').getAttribute('data-app'),'original');
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
});
