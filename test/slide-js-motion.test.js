import { clickEditorTool, openRibbonTab } from './editor-ui-helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStudio } from '../src/server.js';
import { initialState, prepareDeck, renderDeck, validateState } from '../src/deck.js';
import { renderThumbnail } from '../src/thumbnail.js';

const source='<html><head><style>body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{display:none;position:absolute;inset:0;background:white}.slide.active{display:block}</style></head><body><main id="stage"><section class="slide active"><h1>제목</h1></section><section class="slide"><p>둘째</p></section></main></body></html>';

test('slide JavaScript and motion options validate, render and stay out of thumbnails',()=>{
  const input=prepareDeck(source), state=initialState(input), id=input.elements[0].id;
  state.slideCode.s0={html:'<h1>코드</h1>',css:'@keyframes wob{to{rotate:5deg}}',js:'slide.dataset.ran="1";'};

  const valid=validateState(state,input), codeId=Object.keys(valid.patches).length?null:'c-s0--e0';
  assert.equal(valid.slideCode.s0.js,'slide.dataset.ran="1";');
  valid.animations[codeId]={effect:'float',duration:3000,delay:200,loop:true};
  assert.deepEqual(validateState(valid,input).animations[codeId],{effect:'float',duration:3000,delay:200,loop:true});
  const html=renderDeck(input.html,valid);
  assert.match(html,/<script data-sd-slide-js="s0">\(globalThis\.SDSlideScripts\|\|=\{\}\)\["s0"\]=function\(slide\)\{\nslide\.dataset\.ran="1";\n\};<\/script>/);
  assert.doesNotMatch(renderThumbnail(input.html,valid,'s0','n'),/SDSlideScripts/);
  const bad=patch=>()=>validateState({...valid,...patch},input);
  assert.throws(bad({slideCode:{s0:{html:'',css:'',js:'</ScRipt><script>x'}}}),/JavaScript/);
  assert.throws(bad({slideCode:{s0:{html:'',css:'',js:1}}}),/JavaScript/);
  assert.throws(bad({animations:{[codeId]:'explode'}}),/효과/);
  assert.throws(bad({animations:{[codeId]:{effect:'fade',duration:0}}}),/효과/);
  assert.throws(bad({animations:{[codeId]:{effect:'fade',keyframes:[]}}}),/효과/);
  assert.throws(bad({animations:{nope:'fade'}}),/효과/);
  // Blank JS is dropped so untouched states keep their former shape.
  assert.equal(Object.hasOwn(validateState({...valid,animations:{},slideCode:{s0:{html:'<h1>a</h1>',css:'',js:' '}}},input).slideCode.s0,'js'),false);
  assert.equal(globalThis.SDEffects.compact({effect:'fade',duration:500,delay:0,loop:false}),'fade');
});

test('editor saves slide JS and a motion preset; the presentation runs both and cleans up on exit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'studio-slide-js-')),app=await startStudio({port:0,contentPort:0,root});let browser;
  try{
    const prepared=prepareDeck(source),deck=await app.store.create({...prepared,files:new Map([['index.html',Buffer.from(prepared.html)]])});
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(8000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(app.origin+'/#deck='+deck.id);
    const ready=()=>page.waitForFunction(()=>typeof frameReady!=='undefined'&&frameReady&&!transitionBusy&&!objectBusy);
    const saved=async()=>{await page.waitForFunction(()=>!dirty&&!saving&&!transitionBusy);return (await app.store.get(deck.id)).state;};
    await ready();
    // A patch on an original element must survive a JS-only code change.
    const frame=page.frameLocator('#deckFrame');
    await frame.locator('h1').click();await page.waitForFunction(()=>selected?.id);
    const id=await page.evaluate(()=>selected.id);
    await openRibbonTab(page,'slide');await clickEditorTool(page,'effectsBtn');
    await page.locator('#animationValue').selectOption('float');await page.locator('#animationDelay').fill('0.3');
    await page.locator('#previewEffectBtn').click();
    const editing=page.frames().find(f=>f.url().startsWith(app.contentOrigin));
    await editing.waitForFunction(()=>document.getAnimations().some(a=>a.effect.getTiming().delay===300));
    await page.locator('#applyEffectsBtn').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await ready();
    let state=await saved();assert.deepEqual(state.animations[id],{effect:'float',duration:2400,delay:300,loop:true});
    await openRibbonTab(page,'file');await page.locator('#advancedTools').evaluate(e=>e.open=true);await page.locator('#codeBtn').click();
    await page.locator('#codeJs').fill('slide.dataset.ran=String(Number(slide.dataset.ran||0)+1);return()=>{slide.dataset.left="1"};');
    await page.locator('#codeApplyBtn').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await ready();
    state=await saved();assert.match(state.slideCode.s0.js,/dataset\.ran/);assert.ok(state.animations[id],'JS만 바꾸면 효과가 유지됩니다');
    const current=await app.store.get(deck.id),viewer=await browser.newPage({viewport:{width:1920,height:1080}});
    viewer.on('pageerror',e=>errors.push(e.message));
    await viewer.goto(`${app.contentOrigin}/v/${deck.id}/${current.previewToken}/index.html?rev=${current.revision}`);await viewer.waitForFunction(()=>!!window.__sd);
    const first=viewer.locator('[data-sd-slide]').first();
    assert.equal(await first.getAttribute('data-ran'),'1');
    assert.ok(await viewer.evaluate(()=>document.getAnimations().some(a=>a.effect.getTiming().iterations===Infinity)));
    await viewer.evaluate(()=>window.__sd.go(1));
    assert.equal(await first.getAttribute('data-left'),'1');assert.equal(await viewer.evaluate(()=>document.getAnimations().length),0);
    // The editing frame never runs slide JS.
    assert.equal(await frame.locator('[data-sd-slide]').first().getAttribute('data-ran'),null);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
});
