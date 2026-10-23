import { clickEditorTool } from './editor-ui-helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStudio} from '../src/server.js';
import {prepareDeck} from '../src/deck.js';

test('link dialog lists pages, validates URLs, saves, undoes and removes links', async()=>{
  const root=await mkdtemp(join(tmpdir(),'studio-links-ui-'));
  const app=await startStudio({root,port:0,contentPort:0});let browser;
  try {
    const prepared=prepareDeck('<html><head></head><body><main id="stage"><section class="slide active"><h1>목차</h1></section><section class="slide"><h1>결과</h1></section></main></body></html>');
    const deck=await app.store.create({...prepared,files:new Map([['index.html',Buffer.from(prepared.html)]])});
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(5000);
    await page.goto(app.origin+'/#deck='+deck.id);
    const ready=()=>page.waitForFunction(()=>frameReady&&!transitionBusy&&!dirty&&!saving);
    await ready();
    const id=deck.elements.find(e=>e.slide==='s0').id;
    const select=async()=>{await page.evaluate(id=>post('select-ids',{ids:[id]}),id);await page.waitForFunction(id=>selected?.id===id,id);};
    const open=async()=>{await select();await clickEditorTool(page, 'linkBtn');};
    await open();
    await page.locator('#linkTypeValue').selectOption('slide');
    assert.match(await page.locator('#linkSlideValue').innerText(),/결과/);
    await page.locator('#linkSlideValue').selectOption('s1');await page.locator('#applyLinkBtn').click();await ready();
    assert.deepEqual((await app.store.get(deck.id)).state.patches[id].link,{type:'slide',slideId:'s1'});
    await page.locator('#undoBtn').click();await ready();
    assert.equal((await app.store.get(deck.id)).state.patches[id]?.link,undefined);
    await open();await page.locator('#linkUrlValue').fill('javascript:alert(1)');await page.locator('#applyLinkBtn').click();
    assert.ok(await page.locator('#linkEditError').innerText());
    await page.locator('#linkUrlValue').fill('https://example.com/');await page.locator('#applyLinkBtn').click();await ready();
    await page.reload();await ready();await open();assert.equal(await page.locator('#linkUrlValue').inputValue(),'https://example.com/');
    await page.locator('#removeLinkBtn').click();await ready();assert.equal((await app.store.get(deck.id)).state.patches[id].link,null);
  } finally {await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
});

test('served presentation opens external links safely and exported HTML retains page links', async()=>{
  const {exportDeck}=await import('../src/export.js'), {default:JSZip}=await import('jszip');
  const root=await mkdtemp(join(tmpdir(),'studio-links-output-')),app=await startStudio({root,port:0,contentPort:0});let browser;
  try {
    const prepared=prepareDeck('<html><head><style>body{margin:0}.slide{display:none}.slide.active{display:block}</style></head><body><main id="stage"><section class="slide active"><h1>웹</h1><p>다음 페이지</p></section><section class="slide"><h1>결과</h1></section></main></body></html>');
    let deck=await app.store.create({...prepared,files:new Map([['index.html',Buffer.from(prepared.html)]])});
    const [web,next]=deck.elements.filter(e=>e.slide==='s0');
    deck.state.patches[web.id]={link:{type:'url',url:'https://example.com/linked'}};
    deck.state.patches[next.id]={link:{type:'slide',slideId:'s1'}};
    deck=await app.store.save(deck.id,deck.revision,deck.state);
    const url=`${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html`;
    const presentation=await fetch(url),editor=await fetch(url+'?mode=edit'),thumb=await fetch(url+'?mode=thumbnail');
    assert.match(presentation.headers.get('content-security-policy'),/allow-popups-to-escape-sandbox/);
    for(const response of [editor,thumb])assert.doesNotMatch(response.headers.get('content-security-policy'),/allow-popups/);
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
    const context=await browser.newContext();await context.route('https://example.com/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Linked</h1>'}));
    const page=await context.newPage();await page.goto(url);
    const popupReady=context.waitForEvent('page');await page.locator(`[data-sd-id="${web.id}"]`).click();const popup=await popupReady;
    await popup.waitForLoadState();assert.equal(popup.url(),'https://example.com/linked');assert.equal(await popup.evaluate(()=>window.opener),null);await popup.close();
    await page.locator(`[data-sd-id="${next.id}"]`).click();assert.equal(await page.locator('.slide.active').getAttribute('data-sd-slide'),'s1');
    const output=await exportDeck({store:app.store,deck,format:'html'}),zip=await JSZip.loadAsync(output.buffer);
    await context.route('http://offline.test/**',async route=>{
      const path=new URL(route.request().url()).pathname.slice(1)||'index.html';const file=zip.file(path);
      await route.fulfill(file?{contentType:path.endsWith('.js')?'text/javascript':'text/html',body:await file.async('nodebuffer')}:{status:404,body:''});
    });
    await page.goto('http://offline.test/index.html');await page.locator(`[data-sd-id="${next.id}"]`).click();assert.equal(await page.locator('.slide.active').getAttribute('data-sd-slide'),'s1');
  } finally {await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
});
