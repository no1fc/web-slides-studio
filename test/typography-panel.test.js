import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import pptxgen from 'pptxgenjs';
import { parseHTML } from 'linkedom';
import '../public/text-model.js';
import { pptxText, finalizeTextPptx, canExportNativeText } from '../src/text-export.js';
const T = globalThis.SDText;

test('numeric weight and fractional spacing affect only selected letters; bold explicitly resets weight', () => {
  const original = { paragraphs: [{ runs: [{ text: '한글 Alpha 끝', bold: true }] }] };
  const rich = T.formatRichText(original, { start: 3, end: 8 }, 'character', { fontWeight: 500, letterSpacing: -1.2 });
  assert.deepEqual(rich.paragraphs[0].runs.map(r => [r.text, r.fontWeight, r.letterSpacing, r.bold]), [
    ['한글 ', undefined, undefined, true], ['Alpha', 500, -1.2, false], [' 끝', undefined, undefined, true],
  ]);
  const toggled = T.formatRichText(rich, { start: 3, end: 8 }, 'character', { bold: true });
  assert.equal(toggled.paragraphs[0].runs[1].fontWeight, undefined);
  assert.equal(toggled.paragraphs[0].runs[1].bold, true);
  assert.equal(toggled.paragraphs[0].runs[1].letterSpacing, -1.2);
  const heavy = T.formatRichText(original, null, 'character', { fontWeight: 800 });
  assert.equal(heavy.paragraphs[0].runs[0].bold, true);
  const off = T.formatRichText(heavy, null, 'character', { bold: false });
  assert.equal(off.paragraphs[0].runs[0].fontWeight, undefined);
  assert.equal(off.paragraphs[0].runs[0].bold, false);
});

test('typography validates bounded numeric inputs and renders exact CSS including line height five', () => {
  const rich = { paragraphs: [{ lineHeight: 5, runs: [{ text: '서식', fontWeight: 600, letterSpacing: 0.1 }] }] };
  const normalized = T.normalizeRichText(rich);
  const { document } = parseHTML('<html><body><div></div></body></html>');
  const el = document.querySelector('div');
  T.renderRichText(el, normalized);
  assert.equal(el.querySelector('[data-sd-run]').style.fontWeight, '600');
  assert.equal(el.querySelector('[data-sd-run]').style.letterSpacing, '0.1px');
  assert.equal(el.querySelector('[data-sd-paragraph]').style.lineHeight, '5');
  for (const patch of [{ fontWeight: 299 }, { fontWeight: 801 }, { fontWeight: 500.5 }, { letterSpacing: -20.1 }, { letterSpacing: 50.1 }, { letterSpacing: NaN }])
    assert.throws(() => T.formatRichText(normalized, null, 'character', patch));
  assert.throws(() => T.formatRichText(normalized, null, 'paragraph', { lineHeight: 5.01 }));
  for (const letterSpacing of [-20, 50]) assert.equal(T.formatRichText(normalized, null, 'character', { letterSpacing }).paragraphs[0].runs[0].letterSpacing, letterSpacing);
});

test('native PPTX stores scaled positive and negative letter spacing; nonstandard weights retain raster fidelity', async () => {
  const element = { x: 0, y: 0, w: 1000, h: 600, fontSize: 40, fontScale: 0.5,
    richText: { paragraphs: [{ lineHeight: 5, runs: [{ text: '넓게', fontWeight: 700, letterSpacing: 4 }, { text: '좁게', fontWeight: 400, letterSpacing: -1.2 }] }] } };
  const mapped = pptxText(element, 'typography');
  const ppt = new pptxgen(); ppt.layout = 'LAYOUT_WIDE'; ppt.addSlide().addText(mapped.runs, mapped.options);
  const zip = await JSZip.loadAsync(await finalizeTextPptx(await ppt.write({ outputType: 'nodebuffer' }), [[mapped]]));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(xml, /spc="100"/); assert.match(xml, /spc="-30"/);
  assert.match(xml, /<a:spcPct val="500000"/);
  assert.equal(mapped.runs[0].options.bold, true); assert.equal(mapped.runs[1].options.bold, false);
  assert.equal(canExportNativeText(element), true);
  for (const fontWeight of [300, 500, 600, 800]) assert.equal(canExportNativeText({ ...element, richText: { paragraphs: [{ runs: [{ text: '보존', fontWeight }] }] } }), false);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStudio } from '../src/server.js';
import { importArchive } from '../src/archive.js';
import { exportDeck } from '../src/export.js';
import { showEditorControl, clickEditorTool } from './editor-ui-helpers.js';

test('typography panel preserves selected Korean text, undo/redo, reload, revision restore and HTML output', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-typography-'));
  const app = await startStudio({ port: 0, contentPort: 0, root }); let browser;
  try {
    const archive = new JSZip();
    archive.file('index.html', '<html><head><title>글자 서식</title><style>body{margin:0}#stage{width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;width:1920px;height:1080px}h1{position:absolute;left:100px;top:100px;width:1300px;height:700px;font:48px Arial;margin:0}</style></head><body><main id="stage"><section class="slide"><h1>한글 Alpha 끝</h1></section></main></body></html>');
    const deck = await app.store.create(await importArchive(await archive.generateAsync({ type: 'nodebuffer' })));
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } }); page.setDefaultTimeout(7000);
    await page.goto(app.origin + '/#deck=' + deck.id);
    const text = page.frameLocator('#deckFrame').locator('[data-sd-id="e0"]'); await text.waitFor(); await text.dblclick();
    await text.evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); walker.nextNode();
      const node = walker.currentNode, range = document.createRange(); range.setStart(node, 3); range.setEnd(node, 8);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    const saveAfter = async action => {
      const saved = page.waitForResponse(r => r.url().endsWith('/save') && r.request().method() === 'POST');
      await action(); assert.equal((await saved).status(), 200);
      await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.startsWith('저장됨'));
    };
    const change = async (id, value) => {
      const control = page.locator('#' + id), dialog = await control.evaluate(el => el.closest('dialog')?.id);
      if (dialog) await clickEditorTool(page, dialog + 'Btn'); else await showEditorControl(page, id);
      const collapsed = control.locator('xpath=ancestor::details[not(@open)]');
      if (await collapsed.count()) await collapsed.locator('summary').click();
      await saveAfter(async () => { await control.fill(value); await control.dispatchEvent('change'); });
      if (dialog) await page.locator('#' + dialog + ' .dialog-head button').click();
    };
    await change('fontWeightValue', '500'); await change('letterSpacingValue', '-1.2');
    let current = await app.store.get(deck.id);
    let runs = current.state.patches.e0.richText.paragraphs[0].runs;
    assert.deepEqual(runs.map(r => [r.text, r.fontWeight, r.letterSpacing]), [['한글 ', undefined, 0], ['Alpha', 500, -1.2], [' 끝', undefined, 0]]);
    await saveAfter(() => page.locator('#undoBtn').click());
    assert.equal((await app.store.get(deck.id)).state.patches.e0.richText.paragraphs[0].runs[1].letterSpacing, 0);
    await saveAfter(() => page.locator('#redoBtn').click());
    assert.equal((await app.store.get(deck.id)).state.patches.e0.richText.paragraphs[0].runs[1].letterSpacing, -1.2);
    await text.click(); await change('lineHeightValue', '5');
    current = await app.store.get(deck.id); const styledRevision = current.revision;
    assert.equal(current.state.patches.e0.richText.paragraphs[0].lineHeight, 5);
    await page.reload(); await text.waitFor();
    const computed = await text.locator('[data-sd-run]').nth(1).evaluate(el => ({ weight: getComputedStyle(el).fontWeight, spacing: getComputedStyle(el).letterSpacing }));
    assert.deepEqual(computed, { weight: '500', spacing: '-1.2px' });
    const zip = await JSZip.loadAsync((await exportDeck({ store: app.store, deck: current, format: 'html' })).buffer);
    const html = parseHTML(await zip.file('index.html').async('string')).document;
    assert.equal(html.querySelectorAll('[data-sd-run]')[1].style.fontWeight, '500');
    assert.equal(html.querySelectorAll('[data-sd-run]')[1].style.letterSpacing, '-1.2px');
    assert.equal(html.querySelector('[data-sd-paragraph]').style.lineHeight, '5');
    // The real editor runs on the user's PC, outside the export container's PID budget.
    await browser.close(); browser = null;
    const pptxArgs = value => ({ store: app.store, deck: value, format: 'pptx-editable', url: `${app.contentOrigin}/v/${value.id}/${value.previewToken}/index.html?rev=${value.revision}`, contentOrigin: app.contentOrigin });
    const fallback = await JSZip.loadAsync((await exportDeck(pptxArgs(current))).buffer);
    const fallbackXml = await fallback.file('ppt/slides/slide1.xml').async('string');
    assert.doesNotMatch(fallbackXml, /<a:t>Alpha<\/a:t>/, '500 weight must not silently become native 400');
    assert.match(fallbackXml, /<p:pic>/, 'the original rendered text remains in the slide background');
    const nativeState = structuredClone(current.state);
    nativeState.patches.e0.richText.paragraphs[0].runs[1].fontWeight = 700;
    current = await app.store.save(deck.id, current.revision, nativeState);
    const native = await JSZip.loadAsync((await exportDeck(pptxArgs(current))).buffer);
    const nativeXml = await native.file('ppt/slides/slide1.xml').async('string');
    assert.match(nativeXml, /<a:t>Alpha<\/a:t>/);
    assert.match(nativeXml, /spc="-60"/);
    await app.store.save(deck.id, current.revision, deck.state);
    current = await app.store.get(deck.id);
    const restored = await app.store.save(deck.id, current.revision, (await app.store.get(deck.id, styledRevision)).state, { source: 'restore' });
    assert.equal(restored.state.patches.e0.richText.paragraphs[0].runs[1].letterSpacing, -1.2);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const restoredPage = await browser.newPage(); await restoredPage.goto(app.origin + '/#deck=' + deck.id);
    const restoredText = restoredPage.frameLocator('#deckFrame').locator('[data-sd-id="e0"]'); await restoredText.waitFor();
    assert.equal(await restoredText.locator('[data-sd-run]').nth(1).evaluate(el => getComputedStyle(el).fontWeight), '500');
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('shrink and DOM edits retain logical letter spacing and numeric font weights', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="text" style="width:150px;height:80px;font:48px Arial"></div>');
    await page.addScriptTag({ path: new URL('../public/text-model.js', import.meta.url).pathname });
    await page.addScriptTag({ path: new URL('../public/text-editor.js', import.meta.url).pathname });
    const result = await page.evaluate(() => {
      const el = document.querySelector('#text');
      const rich = { paragraphs: [{ lineHeight: 1.2, runs: [{ text: '한글 Alpha Beta', fontSize: 48, fontWeight: 600, letterSpacing: 4.4 }] }] };
      SDTextEditor.render(el, rich, { autoFit: 'shrink' });
      const scale = Number(el.dataset.sdFontScale), rendered = parseFloat(getComputedStyle(el.querySelector('[data-sd-run]')).letterSpacing);
      const read = SDTextEditor.read(el), snapshot = SDTextEditor.snapshot(el);
      el.contentEditable = 'true'; el.querySelector('[data-sd-run]').textContent += ' 입력';
      return { scale, rendered, read, snapshot, edited: SDTextEditor.read(el) };
    });
    assert.ok(result.scale < 1); assert.ok(Math.abs(result.rendered - 4.4 * result.scale) < 0.001);
    for (const rich of [result.read, result.snapshot, result.edited]) {
      assert.equal(rich.paragraphs[0].runs[0].fontWeight, 600); assert.equal(rich.paragraphs[0].runs[0].letterSpacing, 4.4);
    }
    assert.match(T.plainText(result.edited), /입력$/);
  } finally { await browser.close(); }
});

test('theme preview sizes survive fit and no-op editing while cancellation and individual formatting preserve logical sizes', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<section data-sd-slide="s0"><h1 data-sd-id="a-title" style="width:1500px;height:700px;font:76px Arial;margin:0"></h1></section>');
    for (const path of ['text-model.js', 'text-editor.js', 'slide-model.js']) await page.addScriptTag({ path: new URL('../public/' + path, import.meta.url).pathname });
    const result = await page.evaluate(() => {
      const el = document.querySelector('h1'), rich = { paragraphs: [{ lineHeight: 1.2, runs: [{ text: '제목', fontTheme: 'heading', fontSize: 76, fontWeight: 500, letterSpacing: 1.2 }] }] };
      const original = SDSlides.normalizeTheme(), themed = { ...original, sizes: { heading: 120 } }, state = { patches: {}, slideLayouts: {} };
      const snapshot = () => ({ rendered: getComputedStyle(el.querySelector('[data-sd-run]')).fontSize, model: SDTextEditor.model(el).paragraphs[0].runs[0].fontSize, original: JSON.parse(el.dataset.sdRichText).paragraphs[0].runs[0].fontSize });
      SDTextEditor.render(el, rich);
      SDSlides.applyDesignPreview(document, themed, state); SDTextEditor.fit(el); const applied = snapshot();
      SDTextEditor.render(el, SDTextEditor.model(el)); const noop = snapshot();
      SDSlides.applyDesignPreview(document, original, state); SDTextEditor.fit(el); const canceled = snapshot();
      SDSlides.applyDesignPreview(document, themed, state); SDTextEditor.fit(el);
      const formatted = SDText.formatRichText(SDTextEditor.model(el), null, 'character', { fontWeight: 600 });
      SDTextEditor.render(el, formatted); const changed = snapshot();
      const custom = SDText.formatRichText(SDTextEditor.model(el), null, 'character', { fontSize: 60 });
      SDTextEditor.render(el, custom); state.patches['a-title'] = { richText: custom };
      SDSlides.applyDesignPreview(document, { ...original, sizes: { heading: 140 } }, state); SDTextEditor.fit(el); const individual = snapshot();
      return { applied, noop, canceled, changed, individual, run: SDTextEditor.resolve(el).paragraphs[0].runs[0] };
    });
    assert.deepEqual(result.applied, { rendered: '120px', model: 120, original: 76 });
    assert.deepEqual(result.noop, result.applied);
    assert.deepEqual(result.canceled, { rendered: '76px', model: 76, original: 76 });
    assert.deepEqual(result.changed, { rendered: '120px', model: 120, original: 120 });
    assert.deepEqual(result.individual, { rendered: '60px', model: 60, original: 60 });
    assert.equal(result.run.fontWeight, 600); assert.equal(result.run.letterSpacing, 1.2);
  } finally { await browser.close(); }
});

test('layout theme sizes remain equal in preview, saved frame, HTML, native PPTX and later typography edits', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-theme-layout-'));
  const app = await startStudio({ root, port: 0, contentPort: 0 }); let browser;
  try {
    const archive = new JSZip();
    archive.file('index.html', '<html><head><title>테마 자리표시자</title><style>body{margin:0}#stage{width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;width:1920px;height:1080px}</style></head><body><main id="stage"><section class="slide"><p>원본</p></section></main></body></html>');
    let deck = await app.store.create(await importArchive(await archive.generateAsync({ type: 'nodebuffer' })));
    let serial = 0; deck = await app.store.save(deck.id, deck.revision, globalThis.SDSlides.applyLayout(deck.state, 's0', 'title-body', () => 'a-theme-' + ++serial));
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } }); page.setDefaultTimeout(7000);
    await page.goto(app.origin + '/#deck=' + deck.id); await page.waitForFunction(() => frameReady && !transitionBusy);
    const heading = page.frameLocator('#deckFrame').locator('[data-sd-id="a-theme-1"]');
    const size = () => heading.locator('[data-sd-run]').evaluate(el => getComputedStyle(el).fontSize);
    assert.equal(await size(), '76px');
    await page.locator('#designPanelBtn').click(); await page.locator('#designHeadingSize').fill('120'); await page.locator('#designHeadingSize').press('Tab');
    await heading.locator('[data-sd-run]').evaluate(el => new Promise(resolve => { const ready = () => getComputedStyle(el).fontSize === '120px' ? resolve() : requestAnimationFrame(ready); ready(); }));
    assert.equal((await app.store.get(deck.id)).revision, 2);
    await page.locator('#applyDesignBtn').click(); await page.waitForFunction(() => frameReady && !dirty && !saving && deck.revision === 3);
    assert.equal(await size(), '120px'); await page.reload(); await page.waitForFunction(() => frameReady); assert.equal(await size(), '120px');
    await page.locator('#designPanelBtn').click(); await page.locator('#designHeadingSize').fill('100'); await page.locator('#designHeadingSize').press('Tab');
    await page.locator('#discardDesignBtn').click(); assert.equal(await size(), '120px'); assert.equal((await app.store.get(deck.id)).revision, 3);
    deck = await app.store.get(deck.id);
    const html = await JSZip.loadAsync((await exportDeck({ store: app.store, deck, format: 'html' })).buffer);
    const doc = parseHTML(await html.file('index.html').async('string')).document;
    assert.equal(doc.querySelector('[data-sd-id="a-theme-1"] [data-sd-run]').style.fontSize, '120px');
    assert.equal(JSON.parse(doc.querySelector('[data-sd-id="a-theme-1"]').getAttribute('data-sd-rich-text')).paragraphs[0].runs[0].fontSize, 76);
    await page.locator('#closeInspectorBtn').click(); await heading.click();
    await showEditorControl(page, 'fontWeightValue');
    const saved = page.waitForResponse(r => r.url().endsWith('/save') && r.request().method() === 'POST');
    await page.locator('#fontWeightValue').fill('500'); await page.locator('#fontWeightValue').dispatchEvent('change'); assert.equal((await saved).status(), 200);
    assert.equal((await app.store.get(deck.id)).state.patches['a-theme-1'].richText.paragraphs[0].runs[0].fontSize, 120);
    assert.equal(await size(), '120px');
    await browser.close(); browser = null;
    const pptx = await JSZip.loadAsync((await exportDeck({ store: app.store, deck, format: 'pptx-editable', url: `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html?rev=${deck.revision}`, contentOrigin: app.contentOrigin })).buffer);
    const xml = await pptx.file('ppt/slides/slide1.xml').async('string');
    const title = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(m => m[0]).find(shape => shape.includes('제목을 입력하세요'));
    assert.ok(title); assert.match(title, /sz="6000"/);
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
