import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStudio} from '../src/server.js';
import {prepareDeck,renderDeck,validateState,initialState} from '../src/deck.js';

test('design tokens validate and render only connected sizes and radii',()=>{
 const deck=prepareDeck('<html><body><section class="slide"><h1 data-sd-design="heading">Title</h1><p data-sd-design="body">Body</p><div data-sd-design="card">Card</div><p style="font-size:29px">Custom</p></section></body></html>');
 const initial=initialState(deck);const state={...initial,theme:{...initial.theme,sizes:{heading:120,body:50},radius:24}};
 const normalized=validateState(state,deck);const html=renderDeck(deck.html,normalized);
 assert.match(html,/--sd-theme-heading-size:120px/);assert.match(html,/--sd-theme-radius:24px/);
 assert.match(html,/font-size:29px/);
 assert.throws(()=>validateState({...state,theme:{...state.theme,radius:81}},deck));
 assert.throws(()=>validateState({...state,theme:{...state.theme,sizes:{heading:241}}},deck));
});

test('design panel previews without saving, discards and applies a restorable revision',async()=>{
 const root=await mkdtemp(join(tmpdir(),'studio-design-panel-'));const app=await startStudio({root,port:0,contentPort:0});let browser;
 try{
  const source=prepareDeck('<html><head><style>.slide{width:1920px;height:1080px;background:white}h1{font-size:76px}</style></head><body><section class="slide"><h1 data-sd-design="heading">Preview</h1><div data-sd-design="card">Card</div></section></body></html>');
  const deck=await app.store.create({...source,files:new Map([['index.html',Buffer.from(source.html)]])});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1366,height:768}});
  await page.goto(app.origin+'/#deck='+deck.id);await page.waitForFunction(()=>frameReady&&!transitionBusy);
  await page.frameLocator('#deckFrame').locator('h1').click();await page.waitForFunction(()=>selected?.id);
  const addedCount=await page.evaluate(()=>state.added.length);
  await page.locator('#designPanelBtn').click();await page.locator('#designHeadingSize').fill('120');await page.locator('#designHeadingSize').press('Tab');
  const heading=page.frameLocator('#deckFrame').locator('h1');await heading.evaluate(el=>new Promise(resolve=>{const done=()=>getComputedStyle(el).fontSize==='120px'?resolve():requestAnimationFrame(done);done();}));
  assert.equal((await app.store.get(deck.id)).revision,1);assert.equal(await page.evaluate(()=>dirty),false);
  await page.locator('#shuffleDesignBtn').focus();await page.keyboard.press('Control+d');await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>state.added.length),addedCount);assert.equal((await app.store.get(deck.id)).revision,1);
  await page.locator('#discardDesignBtn').click();assert.equal(await heading.evaluate(el=>getComputedStyle(el).fontSize),'76px');
  await page.locator('#designHeadingSize').fill('110');await page.locator('#designHeadingSize').press('Tab');
  await page.locator('#applyDesignBtn').click();await page.waitForFunction(()=>frameReady&&!dirty&&!saving&&deck.revision===2);
  assert.equal((await app.store.get(deck.id)).state.theme.sizes.heading,110);
  await page.locator('#designHeadingSize').fill('112');await page.locator('#designHeadingSize').press('Tab');await page.locator('#applyDesignBtn').click();await page.waitForFunction(()=>frameReady&&!dirty&&!saving&&deck.revision===3);
  assert.equal((await app.store.get(deck.id)).state.theme.sizes.heading,112);
  await page.reload();await page.waitForFunction(()=>frameReady);assert.equal(await heading.evaluate(el=>getComputedStyle(el).fontSize),'112px');
  const latest=await app.store.get(deck.id);await app.store.save(deck.id,latest.revision,deck.state,{source:'restore'});
  await page.reload();await page.waitForFunction(()=>frameReady);assert.equal(await heading.evaluate(el=>getComputedStyle(el).fontSize),'76px');
 }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
});

test('transparent fill removes the original background and survives render',()=>{
 const deck=prepareDeck('<html><body><section class="slide"><h1 style="background:#ff0000">Title</h1></section></body></html>');
 const state=initialState(deck);state.patches[deck.elements[0].id]={fill:'none'};
 const html=renderDeck(deck.html,validateState(state,deck));assert.match(html,/background:transparent/);
 assert.throws(()=>validateState({...state,patches:{[deck.elements[0].id]:{fill:'url(https://invalid.test)'}}},deck));
});
