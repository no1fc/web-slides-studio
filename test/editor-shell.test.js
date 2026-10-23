import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStudio} from '../src/server.js';
import {prepareDeck} from '../src/deck.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'studio-editor-shell-'));
  const app = await startStudio({root, port: 0, contentPort: 0});
  let browser;
  try {
    const input = prepareDeck('<html lang="ko"><head><title>새 편집 화면 검증</title><style>html,body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none;background:white}.slide.active{display:block}h1,p{position:absolute;margin:0;left:120px;width:1400px;line-height:1.5}h1{top:120px;font-size:76px}p{top:320px;font-size:42px}</style></head><body><main id="stage"><section class="slide"><h1>첫 번째 제목</h1><p>선택 가능한 본문</p></section><section class="slide"><h1>두 번째 제목</h1><p>다음 장 본문</p></section><section class="slide"><h1>마지막 제목</h1></section></main></body></html>');
    const deck = await app.store.create({...input, files: new Map([['index.html', Buffer.from(input.html)]])});
    browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox']});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}});
    page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.origin + '/#deck=' + deck.id);
    await page.waitForFunction(() => frameReady && !transitionBusy);
    await fn({page, app, deck});
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await app.close(); await rm(root, {recursive: true, force: true}); }
}
const ready = page => page.waitForFunction(() => frameReady && !dirty && !saving && !transitionBusy);
const heading = page => page.frameLocator('#deckFrame').locator('.slide.active h1');

// These assertions intentionally cover the default screen, before opening any tools.
test('compact editor shell gives notebook screens a single accessible header and bounded canvas', () => fixture(async ({page}) => {
  for (const viewport of [{width: 1366, height: 768}, {width: 1280, height: 720}]) {
    await page.setViewportSize(viewport);
    const dimensions = await page.evaluate(() => {
      const header = document.querySelector('.editor-toolbar').getBoundingClientRect();
      const canvas = document.querySelector('#canvasViewport').getBoundingClientRect();
      return {header: header.height, canvas: {width: canvas.width, height: canvas.height}, horizontal: document.documentElement.scrollWidth > innerWidth + 1, vertical: document.documentElement.scrollHeight > innerHeight + 1};
    });
    assert.ok(dimensions.header <= 56, JSON.stringify(dimensions));
    assert.equal(dimensions.horizontal, false); assert.equal(dimensions.vertical, false);
    assert.ok(dimensions.canvas.width > 500 && dimensions.canvas.height > 450, JSON.stringify(dimensions));
    assert.equal(await page.locator('#editorRibbon').isVisible(), false);
    for (const id of ['libraryBtn', 'previewBtn', 'exportBtn']) {
      const button = page.locator('#' + id);
      assert.equal(await button.isVisible(), true, id);
      assert.ok(await button.evaluate(el => !!(el.getAttribute('aria-label') || el.textContent || el.title).trim()), id + ' accessible name');
    }
    await page.screenshot({path: '/tmp/slides-editor-shell-' + viewport.width + '.png'});
  }
}));

test('double click Korean text editing and slide notes survive navigation and reload in the compact shell', () => fixture(async ({page, app, deck}) => {
  const textSaved = page.waitForResponse(response => response.url().endsWith('/save') && response.request().method() === 'POST');
  await heading(page).dblclick(); await page.keyboard.press('Control+a'); await page.keyboard.insertText('한국어 제목 저장 확인');
  await page.locator('#deckTitle').click(); await textSaved; await ready(page);
  assert.equal((await app.store.get(deck.id)).state.patches.e0.text, '한국어 제목 저장 확인');
  await page.locator('#notesPanel summary').click();
  await page.locator('#notesValue').fill('첫 장에만 남길 발표자 메모');
  await page.locator('#slideList .slide-item').nth(1).click();
  try { await page.waitForFunction(() => index === 1 && frameReady && !transitionBusy); } catch(error) { throw new Error(error.message + ' ' + JSON.stringify(await page.evaluate(() => ({index,frameReady,transitionBusy,dirty,saving,blocked,status:document.querySelector("#saveStatus").textContent,notes:state.notes}))), {cause:error}); }
  assert.equal(await page.locator('#notesValue').inputValue(), '');
  await page.locator('#notesValue').fill('둘째 장의 별도 메모');
  await page.locator('#slideList .slide-item').nth(0).click(); await ready(page);
  assert.equal(await page.locator('#notesValue').inputValue(), '첫 장에만 남길 발표자 메모');
  await page.reload(); await ready(page);
  assert.equal(await heading(page).innerText(), '한국어 제목 저장 확인');
  const saved = await app.store.get(deck.id);
  assert.equal(saved.state.notes.s0, '첫 장에만 남길 발표자 메모');
  assert.equal(saved.state.notes.s1, '둘째 장의 별도 메모');
}));

test('compact shell preserves normal input Tab, Escape and in-progress Korean composition', () => fixture(async ({page, app, deck}) => {
  await page.locator('#deckTitle').focus(); await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'deckTitle');
  await page.locator('#notesPanel summary').click(); await page.locator('#notesValue').focus(); await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'notesValue');
  await heading(page).dblclick();
  await heading(page).dispatchEvent('compositionstart');
  await heading(page).evaluate(el => { el.textContent = '조합 중'; el.dispatchEvent(new InputEvent('input', {bubbles: true, isComposing: true})); });
  await heading(page).dispatchEvent('keydown', {key: 'P', ctrlKey: true, shiftKey: true, isComposing: true});
  assert.equal(await page.locator('#commandSearchDialog').isVisible(), false);
  const compositionSaved = page.waitForResponse(response => response.url().endsWith('/save') && response.request().method() === 'POST');
  await heading(page).evaluate(el => { el.textContent = '조합 완료'; el.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '료'})); });
  await page.keyboard.press('Escape');
  await page.locator('#deckTitle').click(); await compositionSaved; await ready(page);
  assert.equal((await app.store.get(deck.id)).state.patches.e0.text, '조합 완료');
  await page.reload(); await ready(page); assert.equal(await heading(page).innerText(), '조합 완료');
}));

test('format panel toggle returns canvas space and exposes keyboard reachable object controls', () => fixture(async ({page}) => {
  await heading(page).click();
  assert.equal(await page.locator('.inspector').isVisible(), true);
  for (const viewport of [{width: 1366, height: 768}, {width: 1280, height: 720}]) {
    await page.setViewportSize(viewport);
    const before = await page.locator('#canvasViewport').boundingBox();
    await page.locator('#inspectorToggleBtn').click();
    await page.waitForFunction(() => document.querySelector('.inspector').hidden);
    const after = await page.locator('#canvasViewport').boundingBox();
    assert.ok(after.width - before.width >= 300, JSON.stringify({before,after}));
    assert.equal(await page.locator('#inspectorToggleBtn').getAttribute('aria-expanded'), 'false');
    await page.locator('#inspectorToggleBtn').click();
    assert.equal(await page.locator('#inspectorToggleBtn').getAttribute('aria-expanded'), 'true');
    await page.locator('#inspector-format-tab').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#inspector-arrange-tab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#xValue').isVisible(), true);
    await page.keyboard.press('End');
    assert.equal(await page.locator('#inspector-layers-tab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#layerList').isVisible(), true);
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#boldTextBtn').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1), true);
  }
}));

test('compact menus keep insert, advanced files, formatting, download and AI request flows reachable', () => fixture(async ({page, app, deck}) => {
  for (const [id, tab] of [['slideToolsBtn','ribbon-format-tab'], ['insertToolsBtn','ribbon-insert-tab'], ['designToolsBtn','ribbon-slide-tab'], ['fileToolsBtn','ribbon-file-tab']]) {
    const button = page.locator('#' + id);
    assert.ok((await button.getAttribute('aria-label'))?.trim(), id);
    await button.click();
    assert.equal(await page.locator('#' + tab).getAttribute('aria-selected'), 'true');
    await page.waitForFunction(id => document.getElementById(id).getAttribute('aria-expanded') === 'true', id);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#editorRibbon').matches(':popover-open'));
    assert.equal(await button.evaluate(el => el === document.activeElement), true, id + ' focus restored');
  }
  for (const [id, title] of [['addTableBtn','표 데이터 편집'], ['addChartBtn','차트 데이터 편집']]) {
    await page.locator('#insertToolsBtn').click(); await page.locator('#' + id).click();
    await page.getByRole('heading', {name:title, exact:true}).waitFor();
    await page.locator('#closeDialog').click();
  }
  await page.locator('#fileToolsBtn').click();
  await page.locator('#advancedTools summary').click();
  assert.equal(await page.locator('#jsonBtn').isVisible(), true);
  await page.locator('#codeBtn').click(); await page.locator('#codeHtml').waitFor();
  await page.locator('#closeDialog').click();
  await heading(page).click(); await page.locator('#inspector-format-tab').click();
  const formattingSaved = page.waitForResponse(response => response.url().endsWith('/save') && response.request().method() === 'POST');
  await page.locator('#italicTextBtn').click(); await formattingSaved; await ready(page);
  assert.equal((await app.store.get(deck.id)).state.patches.e0.richText.paragraphs[0].runs[0].italic, true);
  await page.locator('#exportBtn').click(); await page.locator('#exportIncludeNotes').waitFor();
  assert.equal(await page.locator('#exportIncludeNotes').isChecked(), false); await page.locator('#closeDialog').click();
  await page.locator('#feedbackBtn').click(); await page.getByRole('heading', {name:'수정 요청 목록', exact:true}).waitFor();
  await page.locator('#newFeedbackBtn').click(); await page.getByRole('heading', {name:'AI 수정 요청', exact:true}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal((await app.store.get(deck.id)).state.added.length, 0, 'cancelled insert dialogs do not create objects');
}));

test('shell close controls restore focus and mobile tools expose their open state', () => fixture(async ({page}) => {
  await page.locator('#closeInspectorBtn').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'inspectorToggleBtn');
  await page.locator('#saveStatus').click();
  assert.equal(await page.locator('#notesPanel').evaluate(el => el.open), false);
  await page.setViewportSize({width: 390, height: 844});
  const tools = page.locator('#editorToolsBtn');
  assert.equal(await tools.getAttribute('aria-expanded'), 'false');
  await tools.click();
  await page.waitForFunction(() => document.querySelector('#editorToolsBtn').getAttribute('aria-expanded') === 'true');
  assert.equal(await page.locator('#collapseRibbonBtn svg').count(), 1);
  await page.locator('#ribbon-file-tab').click();
  assert.equal(await page.locator('#collapseRibbonBtn svg').count(), 1);
  await page.locator('#collapseRibbonBtn').click();
  await page.waitForFunction(() => document.querySelector('#editorToolsBtn').getAttribute('aria-expanded') === 'false');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'editorToolsBtn');
}));

test('slide list resize is bounded, keyboard accessible and preserved on reload', () => fixture(async ({page}) => {
  const resize = page.locator('#slideRailResize');
  await resize.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await resize.getAttribute('aria-valuenow'), '272');
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await resize.getAttribute('aria-valuenow'), '304');
  await page.reload(); await ready(page);
  assert.equal(await resize.getAttribute('aria-valuenow'), '304');
  const box = await resize.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20); await page.mouse.down();
  await page.mouse.move(900, box.y + 20); await page.mouse.up();
  assert.equal(await resize.getAttribute('aria-valuenow'), '480');
  await resize.focus(); await page.keyboard.press('Home');
  assert.equal(await resize.getAttribute('aria-valuenow'), '264');
}));
