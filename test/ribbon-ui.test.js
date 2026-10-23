import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { startStudio } from '../src/server.js';
import { importArchive } from '../src/archive.js';
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'studio-ribbon-'));
  const app = await startStudio({ port: 0, contentPort: 0, root }); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const zip = new JSZip();
    zip.file('index.html', '<html><head><title>리본</title><style>html,body{margin:0}main{position:relative;width:1920px;height:1080px}.slide{position:absolute;inset:0}h1{position:absolute;left:100px;top:100px;width:700px;height:100px}</style></head><body><main><section class="slide"><h1>리본에서 편집</h1></section></main></body></html>');
    const deck = await app.store.create(await importArchive(await zip.generateAsync({ type: 'nodebuffer' })));
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } }); page.setDefaultTimeout(5000);
    await page.goto(app.origin + '/#deck=' + deck.id);
    await page.frameLocator('#deckFrame').locator('h1').click(); await page.locator('#italicTextBtn').waitFor();
    await fn({ app, deck, page });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}
test('ribbon fits laptop and desktop without page or inspector overflow', () => fixture(async ({ page }) => {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1600, height: 1000 }]) {
    await page.setViewportSize(viewport);
    for (const name of ['format', 'arrange', 'slide', 'file', 'insert']) {
      await page.locator(`#ribbon-${name}-tab`).click(); await page.waitForTimeout(50);
      const sizes = await page.evaluate(() => {
        const inspector = document.querySelector('.inspector'), ribbon = document.querySelector('#editorRibbon').getBoundingClientRect(), canvas = document.querySelector('#canvasViewport').getBoundingClientRect();
        const controls = [...document.querySelectorAll('#editorRibbon button, #editorRibbon input, #editorRibbon select')].filter(el => el.checkVisibility());
        return { overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight + 1, inspectorOverflow: inspector.scrollHeight > inspector.clientHeight, bottom: ribbon.bottom, canvasTop: canvas.top, canvasHeight: canvas.height, clipped: controls.filter(el => { const b = el.getBoundingClientRect(); return b.left < 0 || b.right > innerWidth; }).map(el => el.id) };
      });
      assert.equal(sizes.overflow, false, JSON.stringify({ viewport, name, sizes })); assert.equal(sizes.inspectorOverflow, false);
      assert.ok(sizes.bottom <= sizes.canvasTop); assert.ok(sizes.canvasHeight > 250); assert.deepEqual(sizes.clipped, []);
      assert.equal(await page.locator('#addTableBtn').isVisible(), true); assert.equal(await page.locator('#linkBtn').isVisible(), true);
    }
  }
}));
test('keyboard tabs, top formatting, and property dialogs edit the real slide', () => fixture(async ({ app, deck, page }) => {
  await page.locator('#ribbon-format-tab').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#ribbon-arrange-tab').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End'); assert.equal(await page.locator('#ribbon-file-tab').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Home'); assert.equal(await page.locator('#ribbon-insert-tab').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight'); await page.locator('#italicTextBtn').click();
  await page.waitForFunction(() => document.querySelector('#italicTextBtn').getAttribute('aria-pressed') === 'true');
  await page.locator('#paragraphSettingsBtn').click(); await page.locator('#textAlignValue').selectOption('center'); await page.waitForFunction(() => !document.querySelector('#paragraphSettingsBtn').disabled); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#paragraphSettings').evaluate(el => el.open), false);
  assert.equal(await page.locator('#paragraphSettingsBtn').evaluate(el => el === document.activeElement), true);
  await page.locator('#textContentSettingsBtn').click(); await page.locator('#textValue').fill('상단 리본에서 고친 내용'); await page.locator('#textValue').dispatchEvent('change');
  await page.locator('#textContentSettings .dialog-head button').click();
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.startsWith('저장됨'));
  const state = (await app.store.get(deck.id)).state;
  assert.equal(state.patches.e0.text, '상단 리본에서 고친 내용'); assert.equal(state.patches.e0.richText.paragraphs[0].align, 'center'); assert.equal(state.patches.e0.richText.paragraphs[0].runs[0].italic, true);
}));

test('insert tab reuses working insertion commands and returns them to quick access', () => fixture(async ({ app, deck, page }) => {
  await page.locator('#ribbon-insert-tab').click();
  assert.equal(await page.locator('#ribbon-insert #addTextBtn').count(), 1);
  await page.locator('#addTextBtn').click();
  await page.frameLocator('#deckFrame').locator('[data-sd-added="true"]').waitFor();
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.startsWith('저장됨'));
  assert.equal((await app.store.get(deck.id)).state.added.at(-1).kind, 'text');
  await page.locator('#ribbon-format-tab').click();
  assert.equal(await page.locator('.ribbon-tabs #addTextBtn').isVisible(), true);
  assert.equal(await page.locator('#addTextBtn').count(), 1);
}));
