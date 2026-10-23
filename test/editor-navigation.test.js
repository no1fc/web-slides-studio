import { openRibbonTab } from './editor-ui-helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStudio} from '../src/server.js';
import {prepareDeck} from '../src/deck.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'studio-navigation-'));
  const app = await startStudio({root, port: 0, contentPort: 0});
  let browser;
  try {
    const input = prepareDeck('<html><head><title>탐색 검증</title><style>body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{display:none;position:absolute;inset:0;background:white}.slide.active{display:block}h1{font-size:70px;padding:70px}</style></head><body><main id="stage"><section class="slide"><h1>첫 장</h1></section><section class="slide"><h1>두 번째 장</h1></section><section class="slide"><h1>마지막 장</h1></section></main></body></html>');
    input.files = new Map([['index.html', Buffer.from(input.html)]]);
    const deck = await app.store.create(input);
    browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox']});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(7000);
    await page.goto(app.origin + '/#deck=' + deck.id);
    await page.waitForFunction(() => frameReady);
    await fn({page, app, deck});
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await app.close(); await rm(root, {recursive: true, force: true}); }
}

test('command search executes existing tools and respects inputs, IME, escape and tab', () => fixture(async ({page}) => {
  await page.locator('#commandSearchBtn').focus();
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#commandQuery').fill('표 삽입');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', {name: '표 데이터 편집', exact: true}).waitFor();
  await page.locator('#closeDialog').click();
  await page.locator('#commandSearchBtn').click();
  await page.locator('#commandQuery').fill('존재하지 않는 기능');
  assert.match(await page.locator('#commandResults').innerText(), /찾을 수 없습니다/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'commandSearchBtn');
  assert.equal(await page.locator('#commandSearchBtn').evaluate(node => node === document.activeElement), true);
  await page.locator('#deckTitle').focus();
  await page.keyboard.press('Control+Shift+P');
  assert.equal(await page.locator('#commandSearchDialog').isVisible(), false);
  await page.locator('#commandSearchBtn').dispatchEvent('keydown', {key: 'P', ctrlKey: true, shiftKey: true, isComposing: true});
  assert.equal(await page.locator('#commandSearchDialog').isVisible(), false);
  await page.locator('#commandSearchBtn').click();
  await page.locator('#commandQuery').focus(); await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'commandQuery');
  await page.keyboard.press('Escape');
}));

test('overview reuses thumbnail rows, flushes edits, navigates by keyboard and restores focus', () => fixture(async ({page, app, deck}) => {
  await page.locator('#notesPanel summary').click();
  await page.locator('#notesValue').fill('이동하기 전에 기록한 노트');
  await page.locator('#slideOverviewBtn').click();
  await page.locator('#slideOverviewDialog[open]').waitFor();
  assert.equal((await app.store.get(deck.id)).state.notes.s0, '이동하기 전에 기록한 노트');
  assert.equal(await page.locator('#slideList').count(), 1);
  assert.equal(await page.locator('#slideOverviewDialog iframe').count(), 3);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => index === 2 && !transitionBusy);
  assert.equal(await page.locator('#slideOverviewDialog').isVisible(), false);
  assert.equal(await page.locator('.slide-rail #slideList').count(), 1);
  await page.reload(); await page.waitForFunction(() => frameReady);
  assert.equal(await page.evaluate(() => state.notes.s0), '이동하기 전에 기록한 노트');
  await page.locator('#slideOverviewBtn').click(); await page.locator('#slideOverviewDialog[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'slideOverviewBtn');
  assert.equal(await page.locator('#slideOverviewBtn').evaluate(node => node === document.activeElement), true);
}));

test('tool popover preserves the laptop canvas and reopens through visible header menus', () => fixture(async ({page}) => {
 for (const viewport of [{width: 1366, height: 768}, {width: 1280, height: 720}]) {
  await page.setViewportSize(viewport);
  assert.equal(await page.locator('#editorRibbon').isVisible(), false);
  const before = await page.locator('#canvasViewport').boundingBox();
  await openRibbonTab(page, 'insert');
  assert.equal(await page.locator('#addTableBtn').isVisible(), true);
  await page.locator('#collapseRibbonBtn').click();
  await page.locator('#editorRibbon').waitFor({state:'hidden'});
  const after = await page.locator('#canvasViewport').boundingBox();
  assert.ok(Math.abs(after.height-before.height)<2, 'popover leaves the canvas layout unchanged');
  await page.locator('#insertToolsBtn').click();
  assert.equal(await page.locator('#addTableBtn').isVisible(), true);
  await page.locator('#collapseRibbonBtn').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path: `/tmp/slides-navigation-${viewport.width}.png`});
 }
}));

test('overview refuses navigation when saving conflicts and preserves the draft', () => fixture(async ({page, app, deck}) => {
  const current = await app.store.get(deck.id);
  await fetch(app.origin + `/api/decks/${deck.id}/save`, {method: 'POST', headers: {Origin: app.origin, 'Content-Type': 'application/json'}, body: JSON.stringify({revision: current.revision, state: current.state})});
  await page.locator('#notesPanel summary').click();
  await page.locator('#notesValue').fill('충돌해도 보존할 노트');
  await page.locator('#slideOverviewBtn').click();
  await page.locator('#conflictBackupBtn').waitFor();
  assert.equal(await page.locator('#slideOverviewDialog').isVisible(), false);
  assert.equal(await page.evaluate(() => index), 0);
  assert.equal(await page.evaluate(() => state.notes.s0), '충돌해도 보존할 노트');
}));

test('canvas command shortcut opens search but text editing and composition keep their keys', () => fixture(async ({page}) => {
  const heading = page.frameLocator('#deckFrame').locator('.slide.active h1');
  await heading.click(); await page.keyboard.press('Control+Shift+P');
  await page.locator('#commandSearchDialog[open]').waitFor();
  await page.keyboard.press('Escape');
  await heading.dblclick();
  await page.keyboard.press('Control+Shift+P');
  assert.equal(await page.locator('#commandSearchDialog').isVisible(), false);
  await page.keyboard.press('Escape');
  await heading.click();
  await heading.dispatchEvent('keydown', {key: 'P', ctrlKey: true, shiftKey: true, isComposing: true});
  assert.equal(await page.locator('#commandSearchDialog').isVisible(), false);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {source: window, origin: location.origin, data: {studio: true, type: 'command-search', editorSession}})));
  assert.equal(await page.locator('#commandSearchDialog').isVisible(), false);
}));
