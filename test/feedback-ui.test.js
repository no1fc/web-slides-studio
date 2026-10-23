import { clickEditorTool, openRibbonTab } from './editor-ui-helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStudio} from '../src/server.js';
import {prepareDeck} from '../src/deck.js';

async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'studio-feedback-ui-'));const app=await startStudio({root,port:0,contentPort:0});let browser;
 try{const input=prepareDeck('<html><head><style>body{margin:0}#stage{width:1920px;height:1080px;transform-origin:0 0}.slide{width:1920px;height:1080px;position:absolute;display:none;background:white}.slide.active{display:block}h1{font-size:64px}</style></head><body><main id="stage"><section class="slide"><h1>원래 제목</h1></section><section class="slide"><h1>둘째 장</h1></section></main></body></html>');input.files=new Map([['index.html',Buffer.from(input.html)]]);const d=await app.store.create(input);
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1366,height:768}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.origin+'/#deck='+d.id);await page.waitForFunction(()=>frameReady);await fn({page,app,deck:d});assert.deepEqual(errors,[]);
 }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
}
test('targeted private feedback persists and leads to reviewed AI change then manual resolution',()=>fixture(async({page,app,deck})=>{
 await page.frameLocator('#deckFrame').locator('.slide.active h1').click();await page.locator('#requestFeedbackBtn').click();await page.getByLabel('수정할 내용',{exact:true}).fill('제목을 더 짧게 바꿔 주세요');await page.locator('#saveFeedbackBtn').click();await page.locator('.feedback-item').waitFor();
 let list=await(await fetch(app.origin+`/api/decks/${deck.id}/feedback`)).json();assert.equal(list.items.length,1);assert.equal(list.items[0].elementId,'e0');assert.equal((await app.store.get(deck.id)).revision,1);assert.match(await page.locator('#feedbackPrompt').inputValue(),/slides_list_feedback/);
 await page.keyboard.press('Escape');await page.reload();await page.waitForFunction(()=>frameReady);await openRibbonTab(page, 'file');await page.locator('#feedbackBtn').click();await page.getByRole('button',{name:'대상으로 이동',exact:true}).click();await page.waitForFunction(()=>frameReady&&selected?.id==='e0');
 const state=structuredClone(deck.state);state.patches.e0={text:'짧은 제목'};const r=await fetch(app.origin+`/api/decks/${deck.id}/proposals`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({revision:1,state,summary:'수정 요청 반영'})});const proposal=await r.json();
 await clickEditorTool(page, 'aiChangesBtn');await page.locator('#proposal-'+proposal.id).click();await page.locator('#applyAIChangesBtn').click();await page.locator('#dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>frameReady);await page.locator('#feedbackBtn').click();assert.match(await page.locator('.feedback-item').innerText(),/요청 후 자료가 변경/);await page.getByRole('button',{name:'완료로 표시',exact:true}).click();await page.getByRole('button',{name:'다시 열기',exact:true}).waitFor();
 list=await(await fetch(app.origin+`/api/decks/${deck.id}/feedback`)).json();assert.equal(list.items[0].status,'resolved');assert.equal((await app.store.get(deck.id)).revision,2);
 await page.getByRole('button',{name:'다시 열기',exact:true}).click();await page.getByRole('button',{name:'완료로 표시',exact:true}).waitFor();await page.screenshot({path:'/tmp/slides-feedback-1366.png'});
}));
test('feedback text keeps normal Tab, missing target is explicit, and rejected saves preserve the draft',()=>fixture(async({page,app,deck})=>{
 await openRibbonTab(page, 'file');await page.locator('#feedbackBtn').click();await page.locator('#newFeedbackBtn').click();const text=page.getByLabel('수정할 내용',{exact:true});await text.fill('두 번째 요청');await text.focus();await page.keyboard.press('Tab');assert.equal(await text.evaluate(e=>e===document.activeElement),false);
 await page.route('**/feedback',async route=>{if(route.request().method()==='POST')await route.fulfill({status:409,json:{error:'최신 자료를 다시 열어 주세요.'}});else await route.continue();});await page.locator('#saveFeedbackBtn').click();await page.getByText('최신 자료를 다시 열어 주세요.',{exact:true}).waitFor();assert.equal(await text.inputValue(),'두 번째 요청');await page.unroute('**/feedback');
 await page.locator('#saveFeedbackBtn').click();await page.locator('.feedback-item').waitFor();await page.keyboard.press('Escape');const next=structuredClone(deck.state);next.order=['s1'];await app.store.save(deck.id,1,next);await page.reload();await page.waitForFunction(()=>frameReady);await openRibbonTab(page, 'file');await page.locator('#feedbackBtn').click();assert.match(await page.locator('.feedback-item').innerText(),/대상이 현재 자료에 없습니다/);assert.equal(await page.getByRole('button',{name:'대상으로 이동',exact:true}).isEnabled(),false);
}));
test('changing the selection during a pending save does not attach a request to the old target',()=>fixture(async({page,app,deck})=>{
 await page.frameLocator('#deckFrame').locator('.slide.active h1').click();
 let release,started;const gate=new Promise(r=>release=r),waiting=new Promise(r=>started=r);
 await page.route('**/save',async route=>{started();await gate;await route.continue();});
 await page.locator('#notesPanel summary').click();await page.locator('#notesValue').fill('draft notes');
 await page.locator('#requestFeedbackBtn').click();await waiting;
 await page.locator('.slide-item[data-slide-id="s1"]').click();await page.waitForFunction(()=>index===1&&!transitionBusy);
 release();await page.getByText('선택이 변경되었습니다. 현재 대상에서 수정 요청을 다시 열어 주세요.',{exact:true}).waitFor();
 assert.equal(await page.locator('#feedbackText').count(),0);
 const list=await(await fetch(app.origin+`/api/decks/${deck.id}/feedback`)).json();assert.deepEqual(list.items,[]);
 await page.waitForFunction(()=>frameReady);await page.frameLocator('#deckFrame').locator('.slide.active h1').click();await page.locator('#requestFeedbackBtn').click();
 await page.locator('#feedbackText').fill('둘째 장 제목 변경');await page.locator('#saveFeedbackBtn').click();await page.locator('.feedback-item').waitFor();
 const saved=await(await fetch(app.origin+`/api/decks/${deck.id}/feedback`)).json();assert.equal(saved.items[0].slideId,'s1');assert.equal(saved.items[0].elementId,'e1');
}));
test('pending feedback submission protects the submitted text and unlocks it on failure',()=>fixture(async({page})=>{
 await page.frameLocator('#deckFrame').locator('.slide.active h1').click();await page.locator('#requestFeedbackBtn').click();
 const text=page.locator('#feedbackText');await text.fill('보존할 요청');
 let release,started;const gate=new Promise(r=>release=r),waiting=new Promise(r=>started=r);
 await page.route('**/feedback',async route=>{if(route.request().method()!=='POST')return route.continue();started();await gate;await route.fulfill({status:409,json:{error:'변경된 자료를 확인하세요.'}});});
 await page.locator('#saveFeedbackBtn').click();await waiting;assert.equal(await text.isEditable(),false);
 await text.focus();await page.keyboard.type('lost draft');assert.equal(await text.inputValue(),'보존할 요청');
 release();await page.getByText('변경된 자료를 확인하세요.',{exact:true}).waitFor();assert.equal(await text.isEditable(),true);assert.equal(await text.inputValue(),'보존할 요청');
}));
