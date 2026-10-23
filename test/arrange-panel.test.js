import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { startStudio } from '../src/server.js';
import { importArchive } from '../src/archive.js';
import { openInspector, clickEditorTool } from './editor-ui-helpers.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'slides-arrange-panel-'));
  const app = await startStudio({ root, port: 0, contentPort: 0 });
  let browser;
  try {
    const zip = new JSZip();
    zip.file('index.html', '<html><head><title>배치와 자르기</title><style>html,body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none;background:white}.slide.active{display:block}blockquote{position:absolute;left:100px;top:60px;width:500px;height:100px;margin:0}p{margin:0;font-size:36px}</style></head><body><main id="stage"><section class="slide"><blockquote><p>상위 개체 선택</p></blockquote></section><section class="slide"><h1>둘째</h1></section></main></body></html>');
    zip.file('assets/picture.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC', 'base64'));
    let deck = await app.store.create(await importArchive(await zip.generateAsync({ type: 'nodebuffer' })));
    deck.state.added.push(
      { id: 'a-one', slide: 's0', kind: 'shape', x: 100, y: 240, w: 120, h: 80, fill: '#2255aa' },
      { id: 'a-two', slide: 's0', kind: 'shape', x: 440, y: 350, w: 200, h: 100, fill: '#33aa77' },
      { id: 'a-image', slide: 's0', kind: 'image', x: 1100, y: 240, w: 400, h: 400, src: 'assets/picture.png' },
    );
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.origin + '/#deck=' + deck.id);
    await page.waitForFunction(() => frameReady && !objectBusy);
    const frame = page.frameLocator('#deckFrame');
    await fn({ page, frame, app, deck });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}
const item = (frame, id) => frame.locator(`[data-sd-id="${id}"]`);
const near = (a, b, epsilon = .15) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≈ ${b}`);
async function coord(page, id, key, value) { await page.waitForFunction(({id,key,value}) => Math.abs((state.patches[id]?.[key] ?? state.added.find(a => a.id === id)?.[key]) - value) < .15, {id,key,value}); }
async function saved(page) { await page.waitForFunction(() => !dirty && !saving && !objectBusy); }

test('single alignment uses slide, multiple alignment switches bounds, and parent selection preserves history', () => fixture(async ({page, frame, app, deck}) => {
  await item(frame, 'a-one').click(); await openInspector(page, 'arrange');
  assert.equal(await page.locator('#alignTargetValue').inputValue(), 'slide');
  assert.equal(await page.locator('#alignTargetValue').isDisabled(), true);
  await page.locator('#alignCenterBtn').click(); await coord(page, 'a-one', 'x', 900);
  await page.locator('#undoBtn').click(); await coord(page, 'a-one', 'x', 100);
  await item(frame, 'a-one').click(); await item(frame, 'a-two').click({ modifiers: ['Shift'] });
  await openInspector(page, 'arrange');
  assert.equal(await page.locator('#alignTargetValue').inputValue(), 'selection');
  await page.locator('#alignLeftBtn').click(); await coord(page, 'a-two', 'x', 100);
  await page.locator('#alignTargetValue').selectOption('slide');
  await page.locator('#alignRightBtn').click(); await coord(page, 'a-one', 'x', 1800); await coord(page, 'a-two', 'x', 1720);
  await saved(page); await page.reload(); await page.waitForFunction(() => frameReady);
  assert.equal((await app.store.get(deck.id)).state.patches['a-one'].x, 1800);
  await frame.locator('blockquote p').click(); await openInspector(page, 'arrange');
  await page.locator('#selectParentBtn').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => selected?.tag === 'blockquote');
  assert.equal(await page.locator('#selectParentBtn').isDisabled(), true);
}));

test('smart guides snap slide center and clear on cancel, support Alt bypass and persistent toggle', () => fixture(async ({page, frame}) => {
  await item(frame, 'a-one').click(); await openInspector(page, 'arrange');
  const dragTo = async x => {
    const box = await item(frame, 'a-one').boundingBox();
    const stage = await frame.locator('.slide.active').boundingBox(), ss = stage.width / 1920;
    const currentX = await page.evaluate(() => state.patches['a-one']?.x ?? 100);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + (x - currentX) * ss, box.y + box.height / 2, { steps: 4 });
  };
  await dragTo(905);
  assert.ok(await frame.locator('#sd-snap-guides > div').count() > 0);
  await page.mouse.up(); await coord(page, 'a-one', 'x', 900);
  assert.equal(await frame.locator('#sd-snap-guides > div').count(), 0);
  await page.locator('#undoBtn').click(); await coord(page, 'a-one', 'x', 100);
  await item(frame, 'a-one').click();
  await page.keyboard.down('Alt'); await dragTo(905); await page.mouse.up(); await page.keyboard.up('Alt');
  await coord(page, 'a-one', 'x', 905);
  await openInspector(page, 'arrange'); await page.locator('#smartGuidesValue').uncheck();
  await dragTo(910); assert.equal(await frame.locator('#sd-snap-guides > div').count(), 0);
  await page.keyboard.press('Escape'); await page.mouse.up(); await coord(page, 'a-one', 'x', 905);
  await saved(page); await page.reload(); await page.waitForFunction(() => frameReady);
  assert.equal(await page.locator('#smartGuidesValue').isChecked(), false);
}));

test('visual image crop previews without saving, keeps ratio with pointer and keyboard, applies one undoable edit', () => fixture(async ({page, frame, app, deck}) => {
  await item(frame, 'a-image').click(); await clickEditorTool(page, 'visualCropBtn');
  await page.locator('#applyVisualCropBtn').waitFor();
  await page.waitForFunction(() => document.querySelector('#applyVisualCropBtn')?.disabled === false);
  const region = page.locator('#visualCropRegion');
  let box = await region.boundingBox(); near(box.width / box.height, 1, .02);
  const handle = region.locator('[data-corner=se]'), corner = await handle.boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down();
  await page.mouse.move(corner.x - 35, corner.y - 35, { steps: 3 }); await page.mouse.up();
  box = await region.boundingBox(); near(box.width / box.height, 1, .02);
  await region.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => state.patches['a-image']), undefined);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'visualCropBtn');
  assert.equal(await page.evaluate(() => state.patches['a-image']), undefined);
  await page.locator('#visualCropBtn').click(); await page.waitForFunction(() => document.querySelector('#applyVisualCropBtn')?.disabled === false);
  await page.locator('#visualCropSize').focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await region.focus(); await page.keyboard.press('Shift+ArrowRight');
  await page.locator('#applyVisualCropBtn').click(); await page.waitForFunction(() => !document.querySelector('#dialog').open);
  await saved(page);
  const persisted = (await app.store.get(deck.id)).state.patches['a-image'].image;
  near(800 * (1 - persisted.crop.left - persisted.crop.right) / (400 * (1 - persisted.crop.top - persisted.crop.bottom)), 1, .001);
  assert.equal(persisted.mode, 'fill');
  await page.locator('#undoBtn').click(); await page.waitForFunction(() => !state.patches['a-image']); await saved(page);
  assert.equal((await app.store.get(deck.id)).state.patches['a-image'], undefined);
  await page.locator('#redoBtn').click(); await page.waitForFunction(() => !!state.patches['a-image']?.image); await saved(page);
  assert.deepEqual((await app.store.get(deck.id)).state.patches['a-image'].image, persisted);
  await page.reload(); await item(frame, 'a-image').click(); await clickEditorTool(page, 'visualCropBtn');
  await page.waitForFunction(() => document.querySelector('#applyVisualCropBtn')?.disabled === false);
  await page.locator('#visualCropMode').selectOption('fit'); await page.locator('#applyVisualCropBtn').click(); await saved(page);
  assert.deepEqual((await app.store.get(deck.id)).state.patches['a-image'].image, { mode: 'fit', crop: {left: 0, right: 0, top: 0, bottom: 0} });
}));
