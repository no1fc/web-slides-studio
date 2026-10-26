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
 const root=await mkdtemp(join(tmpdir(),'studio-workflow-ui-'));const app=await startStudio({root,port:0,contentPort:0});let browser;
 try{browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1366,height:768}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const input=prepareDeck('<html><head><title>검증 자료</title><style>body{margin:0}main{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{display:none;position:absolute;inset:0;width:1920px;height:1080px;background:white;padding:100px}.slide.active{display:block}h1{font-size:70px}p{font-size:40px}</style></head><body><main id="stage"><section class="slide"><h1>첫 제목</h1><p>첫 본문</p><aside class="notes">PRIVATE-NOTES-123</aside></section><section class="slide"><h1>두 번째</h1></section></main></body></html>');input.files=new Map([['index.html',Buffer.from(input.html)]]);const d=await app.store.create(input);
 await page.goto(app.origin+'/#deck='+d.id);await page.waitForFunction(()=>frameReady);await fn({page,app,deck:d});assert.deepEqual(errors,[]);
 }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
}
const ready=page=>page.waitForFunction(()=>frameReady&&!dirty&&!saving&&!transitionBusy);
test('per-deck iframe sites can be saved, reopened and cleared in the sharing dialog',()=>fixture(async({page,app,deck})=>{
 await page.locator('#shareBtn').click();
 const sites=page.getByLabel('iframe 허용 사이트 (한 줄에 하나)');
 await sites.fill('https://PORTAL.example/\nhttps://school.example');
 await page.locator('#publishShareBtn').click();await page.locator('#stopShareBtn').waitFor();
 assert.equal(await sites.inputValue(),'https://portal.example\nhttps://school.example');
 await page.locator('#closeDialog').click();await page.reload();await ready(page);await page.locator('#shareBtn').click();
 assert.equal(await sites.inputValue(),'https://portal.example\nhttps://school.example');
 await sites.fill('https://school.example/path');
 const rejected=page.waitForResponse(r=>r.url().endsWith('/publish')&&r.request().method()==='POST');
 await page.locator('#publishShareBtn').click();assert.equal((await rejected).status(),400);
 assert.equal(await sites.inputValue(),'https://school.example/path');
 await sites.fill('');
 const saved=page.waitForResponse(r=>r.url().endsWith('/publish')&&r.request().method()==='POST');
 await page.locator('#publishShareBtn').click();assert.equal((await saved).status(),200);
 await page.waitForFunction(()=>document.querySelector('#shareEmbedOrigins')?.value==='');
 assert.deepEqual((await app.store.meta(deck.id)).shareEmbedOrigins,[]);
}));
test('everyday editor settings, exact times, named history, independent template and brand workflow',()=>fixture(async({page,app,deck})=>{
 await page.locator('#editorSettingsBtn').click();await page.locator('#aiConnectionBtn').click();await page.getByRole('heading',{name:'AI 연결'}).waitFor();await page.keyboard.press('Escape');
 await openRibbonTab(page, 'file');assert.equal(await page.locator('#codeBtn').isVisible(),false);await clickEditorTool(page, 'deckInfoBtn');assert.match(await page.locator('#dialogBody').innerText(),/최초 업로드: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(KST\)/);await page.locator('#closeDialog').click();
 await clickEditorTool(page, 'versionsBtn');await page.getByRole('textbox',{name:'v1 이름'}).fill('원본 보존');await page.locator('#nameRevision1').click();await page.locator('#closeDialog').click();assert.equal((await app.store.revisions(deck.id))[0].name,'원본 보존');
 await openRibbonTab(page, 'slide');await clickEditorTool(page, 'saveTemplateBtn');await page.locator('#confirmSaveTemplateBtn').click();await page.locator('#dialog').waitFor({state:'hidden'});await clickEditorTool(page, 'templatesBtn');await page.getByRole('button',{name:'검증 자료',exact:true}).click();await page.locator('#createFromTemplateBtn').click();await page.locator('#dialog').waitFor({state:'hidden'});await ready(page);const copiedId=await page.evaluate(()=>deck.id);assert.notEqual(copiedId,deck.id);assert.equal((await app.store.get(copiedId)).state.order.length,2);
 await clickEditorTool(page, 'brandsBtn');await page.getByLabel('브랜드 이름',{exact:true}).fill('팀 브랜드');await page.locator('#dialog').getByLabel('강조색',{exact:true}).fill('#cc3300');await page.locator('#saveBrandBtn').click();await page.locator('#dialog').waitFor({state:'hidden'});await clickEditorTool(page, 'brandsBtn');await page.getByRole('button',{name:'팀 브랜드 적용'}).click();await page.locator('#dialog').waitFor({state:'hidden'});await ready(page);assert.equal((await app.store.get(copiedId)).state.theme.colors.accent,'#cc3300');assert.notEqual((await app.store.get(deck.id)).state.theme.colors.accent,'#cc3300');
 await openRibbonTab(page, 'format');await page.frameLocator('#deckFrame').locator('.slide.active h1').click();await page.screenshot({path:'/tmp/slides-everyday-editor-1366.png'});
}));
test('AI UI previews without saving, applies selected slide, restores and refuses stale proposal',()=>fixture(async({page,app,deck})=>{
 const request=async(path,body)=>{const r=await fetch(app.origin+'/api'+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
 const next=structuredClone(deck.state);next.patches.e0={text:'AI 새 제목'};const proposal=await request(`/decks/${deck.id}/proposals`,{revision:1,state:next,summary:'제목 개선'});
 await openRibbonTab(page, 'file');await clickEditorTool(page, 'aiChangesBtn');await page.locator('#proposal-'+proposal.id).click();await page.frameLocator('.comparison iframe').nth(0).locator('.slide.active h1').waitFor();await page.frameLocator('.comparison iframe').nth(1).locator('.slide.active h1').filter({hasText:'AI 새 제목'}).waitFor();assert.equal((await app.store.get(deck.id)).revision,1);await page.screenshot({path:'/tmp/slides-ai-comparison.png'});await page.locator('#applyAIChangesBtn').click();await page.locator('#dialog').waitFor({state:'hidden'});await ready(page);assert.equal((await app.store.get(deck.id)).state.patches.e0.text,'AI 새 제목');
 await clickEditorTool(page, 'versionsBtn');await page.locator('#restoreRevision1').click();await page.locator('#dialog').waitFor({state:'hidden'});await ready(page);assert.equal((await app.store.get(deck.id)).revision,3);assert.equal((await app.store.get(deck.id)).state.patches.e0,undefined);
 const stale=await request(`/decks/${deck.id}/proposals`,{revision:3,state:next,summary:'충돌 검사'});await clickEditorTool(page, 'aiChangesBtn');await page.locator('#proposal-'+stale.id).click();await request(`/decks/${deck.id}/save`,{revision:3,state:(await app.store.get(deck.id)).state});await page.locator('#applyAIChangesBtn').click();await page.waitForFunction(()=>document.querySelector('#applyAIChangesBtn').disabled);assert.match(await page.locator('#dialogBody').innerText(),/최신 저장본이 바뀌었습니다/);await page.locator('#rejectAIChangesBtn').click();await page.locator('#dialog').waitFor({state:'hidden'});assert.equal((await app.store.get(deck.id)).revision,4);
}));
test('sharing and export UI default notes off, exact published time, expires and revokes',()=>fixture(async({page,app,deck})=>{
 await page.locator('#shareBtn').click();assert.equal(await page.getByLabel('발표자 노트도 공유하기',{exact:false}).isChecked(),false);await page.getByLabel('접근 암호 (선택)').fill('audience-password-123');await page.locator('#publishShareBtn').click();await page.locator('#stopShareBtn').waitFor();assert.match(await page.locator('#dialogBody').innerText(),/게시 v1 · .*\(KST\)/);const meta=await app.store.meta(deck.id);assert.equal(meta.shareIncludeNotes,false);assert.ok(meta.sharePassword);await page.locator('#stopShareBtn').click();await page.locator('#dialog').waitFor({state:'hidden'});const response=await fetch(`${app.contentOrigin}/v/${deck.id}/${meta.shareToken}/index.html`);assert.equal(response.status,404);
 await page.locator('#exportBtn').click();assert.equal(await page.locator('#exportIncludeNotes').isChecked(),false);await page.locator('#closeDialog').click();await page.locator('#libraryBtn').click();assert.match(await page.locator('.deck-meta').innerText(),/업로드 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);assert.match(await page.locator('.deck-meta').innerText(),/수정 /);
}));
test('late AI response preserves newer local edits instead of silently replacing them',()=>fixture(async({page,app,deck})=>{
 const next=structuredClone(deck.state);next.patches.e0={text:'AI first'};
 const response=await fetch(app.origin+`/api/decks/${deck.id}/proposals`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({revision:1,state:next})});const proposal=await response.json();
 await openRibbonTab(page, 'file');await clickEditorTool(page, 'aiChangesBtn');await page.locator('#proposal-'+proposal.id).click();
 let release,started;const waiting=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 await page.route('**/proposals/*/apply',async route=>{const result=await route.fetch();started();await gate;await route.fulfill({response:result});});
 await page.locator('#applyAIChangesBtn').click();await waiting;await page.locator('#closeDialog').click();await page.locator('#notesPanel summary').click();await page.locator('#notesValue').fill('응답 중 추가한 내 메모');release();
 await page.locator('#conflictBackupBtn').waitFor();assert.equal(await page.evaluate(()=>state.notes.s0),'응답 중 추가한 내 메모');assert.equal(await page.evaluate(()=>dirty&&blocked),true);
}));
test('comparison resolves each side by slide identity after reorder',()=>fixture(async({page,app,deck})=>{
 const next=structuredClone(deck.state);next.order.reverse();next.patches.e0={text:'AI first'};
 const response=await fetch(app.origin+`/api/decks/${deck.id}/proposals`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({revision:1,state:next})});const proposal=await response.json();
 await openRibbonTab(page, 'file');await clickEditorTool(page, 'aiChangesBtn');await page.locator('#proposal-'+proposal.id).click();await page.frameLocator('.comparison iframe').nth(1).locator('.slide.active h1').filter({hasText:'두 번째'}).waitFor();await page.locator('.change-row').filter({has:page.locator('input[data-slide="s0"]')}).getByRole('button',{name:'이 장 비교'}).click();
 await page.frameLocator('.comparison iframe').nth(0).locator('.slide.active h1').filter({hasText:'첫 제목'}).waitFor();await page.frameLocator('.comparison iframe').nth(1).locator('.slide.active h1').filter({hasText:'AI first'}).waitFor();
}));

test('share note opt-in persists across publish, reopen and reload, and recipients can read it',()=>fixture(async({page,app,deck})=>{
 await page.locator('#shareBtn').click();
 const option=page.getByLabel('발표자 노트도 공유하기',{exact:false});
 await option.check();await page.locator('#publishShareBtn').click();await page.locator('#stopShareBtn').waitFor();
 assert.equal(await option.isChecked(),true,'published note inclusion remains selected');
 await page.locator('#closeDialog').click();await page.reload();await ready(page);await page.locator('#shareBtn').click();
 assert.equal(await option.isChecked(),true,'saved note setting survives reload');
 const shared=(await fetch(app.origin+`/api/decks/${deck.id}`).then(r=>r.json())).shareUrl;
 const recipient=await page.context().browser().newPage();await recipient.goto(shared);
 await recipient.getByRole('button',{name:'발표자 노트 보기',exact:true}).click();
 assert.match(await recipient.locator('#sd-shared-notes').innerText(),/PRIVATE-NOTES-123/);
 await recipient.getByRole('button',{name:'다음 슬라이드',exact:true}).click();
 assert.match(await recipient.locator('#sd-shared-notes').innerText(),/이 슬라이드에는 노트가 없습니다/);
 await option.uncheck();const published=page.waitForResponse(r=>r.url().endsWith('/publish')&&r.request().method()==='POST');await page.locator('#publishShareBtn').click();assert.equal((await (await published).json()).shareIncludeNotes,false);await page.locator('#stopShareBtn').waitFor();
 await recipient.reload();assert.equal(await recipient.locator('#sd-shared-notes').count(),0);
 assert.ok(!(await recipient.content()).includes('PRIVATE-NOTES-123'));
 assert.equal(await option.isChecked(),false);
 await recipient.close();
}));
