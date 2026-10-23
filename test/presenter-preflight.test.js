import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStudio} from '../src/server.js';
import {prepareDeck} from '../src/deck.js';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'studio-presenter-'));
  const app=await startStudio({root,port:0,contentPort:0});
  let browser;
  try {
    const source=prepareDeck(`<html><head><style>html,body{margin:0}main{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none;background:white;color:black}.slide.active{display:block}h1{position:absolute;left:40px;top:30px;width:500px;height:80px}p{position:absolute;left:40px;top:160px;width:40px;height:20px;overflow:hidden;font-size:40px}img{position:absolute;left:600px;top:300px;width:100px;height:100px}.outside{position:absolute;left:1950px;top:400px;width:100px;height:80px}a{position:absolute;left:40px;top:400px}input{position:absolute;left:40px;top:500px}</style></head><body><main id="stage">${[1,2,3].map(n=>`<section class="slide${n===1?' active':''}"><h1>Page ${n}</h1><p>Overflow text must be examined</p><img src="missing.png" alt="Missing image"><div class="outside">Outside</div><a href="#missing-target">Broken link</a><input aria-label="Native input" value="Text"><aside class="notes">PRIVATE NOTE ${n}</aside></section>`).join('')}</main></body></html>`);
    let deck=await app.store.create({...source,files:new Map([['index.html',Buffer.from(source.html)]])});
    deck.state.order=['s2','s0','s1']; deck=await app.store.save(deck.id,deck.revision,deck.state);
    deck = await (await fetch(`${app.origin}/api/decks/${deck.id}`)).json();
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1280,height:720}}); page.setDefaultTimeout(7000);
    page.on('pageerror', error => console.error('Browser error:', error.message));
    await page.goto(app.origin+'/');
    await page.addScriptTag({url:app.origin+'/presenter.js'});
    await run({app,browser,page,deck});
  } finally {await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
}
async function launch(page,deck){
  await page.goto(new URL('/#deck='+deck.id,page.url()).href); await page.reload();
  await page.waitForFunction(()=>frameReady&&!transitionBusy);
  const popupPromise=page.waitForEvent('popup');
  await page.locator('#previewBtn').click();
  const popup=await popupPromise;
  await popup.waitForURL('**/presenter.html?session=*');
  await popup.frameLocator('#currentSlide').locator('[data-sd-slide="s2"]:visible').waitFor();
  return popup;
}
const slide=page=>page.frameLocator('#currentSlide').locator('[data-sd-slide]:visible');

test('presenter uses saved order, synchronizes audience both ways, keeps notes private and offers controls',()=>fixture(async({page,deck,app})=>{
  const presenter=await launch(page,deck);
  assert.match(await presenter.locator('#presentNotes').innerText(),/PRIVATE NOTE 3/);
  assert.equal(await presenter.frameLocator('#nextSlide').locator('[data-sd-slide]:visible').getAttribute('data-sd-slide'),'s0');
  const audiencePromise=presenter.waitForEvent('popup'); await presenter.locator('#openAudience').click(); const audience=await audiencePromise;
  await audience.waitForURL('**/presenter.html?session=*'); await slide(audience).waitFor();
  assert.equal(await audience.locator('.notes').count(),0);
  assert.equal(await audience.evaluate(()=>window.opener),null);
  assert.doesNotMatch(await audience.content(),/PRIVATE NOTE/);
  const audienceSrc = await audience.locator('#currentSlide').getAttribute('src');
  assert.ok(audienceSrc.startsWith(deck.audienceUrl.split('?')[0]));
  assert.ok(!audienceSrc.includes(deck.previewToken));
  assert.ok(!(await audience.content()).includes(deck.previewToken));
  const response=await fetch(audienceSrc); assert.doesNotMatch(await response.text(),/PRIVATE NOTE/);
  const privateRoute = new URL(audienceSrc); privateRoute.pathname = privateRoute.pathname.replace('/a/','/v/'); privateRoute.search = '';
  const denied = await fetch(privateRoute); assert.equal(denied.status,404); assert.doesNotMatch(await denied.text(),/PRIVATE NOTE/);
  await presenter.locator('#nextButton').click();
  await audience.waitForFunction(()=>document.getElementById('currentSlide').src.includes('index.html'));
  await audience.frameLocator('#currentSlide').locator('[data-sd-slide="s0"]:visible').waitFor();
  await audience.frameLocator('#currentSlide').locator('body').click({position:{x:5,y:5}}); await audience.keyboard.press('ArrowRight');
  await presenter.frameLocator('#currentSlide').locator('[data-sd-slide="s1"]:visible').waitFor();
  assert.match(await presenter.locator('#presentNotes').innerText(),/PRIVATE NOTE 2/);
  await presenter.locator('#blackScreen').click(); await audience.frameLocator('#currentSlide').locator('#sd-black-screen:visible').waitFor();
  await presenter.locator('#blackScreen').click(); await presenter.locator('#laserPointer').click();
  await audience.frameLocator('#currentSlide').locator('#sd-laser-pointer:visible').waitFor();
  await presenter.locator('#fullScreen').click(); assert.equal(await presenter.evaluate(()=>!!document.fullscreenElement),true);await presenter.evaluate(()=>document.exitFullscreen());
  const input=audience.frameLocator('#currentSlide').getByRole('textbox',{name:'Native input'}).filter({visible:true}); await input.focus();await audience.keyboard.press('ArrowLeft');
  assert.equal(await slide(audience).getAttribute('data-sd-slide'),'s1');
  await presenter.locator('#singleScreen').click(); assert.equal(await presenter.locator('.notes').isVisible(),false);
  await presenter.frameLocator('#currentSlide').locator('body').click({position:{x:5,y:5}});await presenter.keyboard.press('Escape');
  await presenter.locator('.notes:visible').waitFor();
  const size=await presenter.locator('body').evaluate(el=>({scroll:el.scrollWidth,width:innerWidth}));assert.ok(size.scroll<=size.width);
}));

test('blocked presenter popup has same-tab fallback and audience popup gives a usable alternative',()=>fixture(async({page,deck})=>{
  await page.evaluate(deck=>SDPresenter.open(deck,1,null),deck);
  await page.waitForURL('**/presenter.html?session=*'); await slide(page).waitFor();
  assert.match(await page.locator('#returnEditor').getAttribute('href'),new RegExp(deck.id));
  await page.evaluate(()=>window.open=()=>null);await page.locator('#openAudience').click();
  assert.match(await page.locator('#presentStatus').innerText(),/팝업이 차단/);
  await page.locator('#singleScreen').click();assert.equal(await page.locator('.notes').isVisible(),false);
}));

test('preflight finds actual layout, missing asset and invalid link issues without editing state',()=>fixture(async({page,deck,app})=>{
  await page.goto(app.origin+'/#deck='+deck.id); await page.reload();
  await page.waitForFunction(()=>typeof frameReady!=='undefined'&&frameReady&&!transitionBusy);
  const before=await app.store.get(deck.id);
  await page.evaluate(()=>{window.checkedIssues=[];window.addEventListener('message',event=>{if(event.data?.type==='preflight-result')window.checkedIssues=event.data.issues;});});
  await page.locator('#ribbon-present-tab').click(); await page.locator('#preflightBtn').click();
  await page.waitForFunction(()=>checkedIssues.length>0);
  const issues=await page.evaluate(()=>checkedIssues);
  for(const text of ['이미지를 불러오지','글이 글상자','슬라이드 밖','내부 링크']) assert.ok(issues.some(issue=>issue.message.includes(text)),text);
  assert.ok(issues.some(issue=>issue.severity==='manual'));
  assert.ok(issues.some(issue=>issue.id&&issue.index===0&&issue.slideId==='s2'));
  await page.getByRole('button',{name:/오류 · 1장 · 이미지를/}).click();
  await page.frameLocator('#deckFrame').locator('[data-sd-slide="s2"] .sd-selected').waitFor();
  assert.equal(await page.frameLocator('#deckFrame').locator('.sd-selected').evaluate(element=>element.tagName),'IMG');
  const after=await app.store.get(deck.id);assert.deepEqual(after.state,before.state);assert.equal(after.revision,before.revision);
}));
