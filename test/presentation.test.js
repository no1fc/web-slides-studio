import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { startStudio } from '../src/server.js';
import { prepareDeck } from '../src/deck.js';
import { exportDeck } from '../src/export.js';

async function fixture(run, legacy = false, bare = false) {
  const root = await mkdtemp(join(tmpdir(), 'studio-presentation-'));
  const app = await startStudio({ root, port: 0, contentPort: 0 });
  let browser;
  try {
    const source = prepareDeck(`<html><head><style>body{margin:8px}section{padding:40px;background:white}h1,p{width:500px;height:80px} ${legacy ? '.slide{display:none}.slide.active{display:flex;flex-direction:column}' : ''}</style></head><body>${bare ? '' : '<main id="stage">'}${[1,2,3].map(n => `<section class="slide"><h1>Page ${n}</h1><p>Body ${n}</p><a href="#native">Native link</a><input aria-label="Value" value="text"></section>`).join('')}${bare ? '' : '</main>'}${legacy ? '<script>window.goSlide=n=>{window.legacyCalls=(window.legacyCalls||0)+1;document.querySelectorAll(".slide").forEach((s,i)=>s.classList.toggle("active",i===n));};addEventListener("keydown",e=>{if(e.key==="ArrowRight"){window.legacyKeys=(window.legacyKeys||0)+1;goSlide(2);}},true);</script>' : ''}</body></html>`);
    let deck = await app.store.create({ ...source, files: new Map([['index.html', Buffer.from(source.html)]]) });
    const first = deck.elements.filter(e => e.slide === 's0');
    deck.state.patches[first[1].id] = { locked: true };
    deck.state.added.push({id:'a-tab',slide:'s0',kind:'text',text:'Last object',x:600,y:400,w:400,h:100});
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.setDefaultTimeout(5000);
    const url = `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html`;
    await page.goto(url); await page.waitForFunction(() => !!window.__sd);
    await run({ page, app, deck, url, first });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}
const current = page => page.evaluate(() => __sd.current);
async function oneSlide(page) {
  assert.equal(await page.locator('[data-sd-slide]:visible').count(), 1);
  const box = await page.locator('[data-sd-slide]:visible').boundingBox();
  assert.ok(Math.abs(box.width / box.height - 16 / 9) < .001);
  assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= 1001 && box.y + box.height <= 801);
}

test('presentation fits one slide, navigates by controls and keyboard, and cleans capture overlays', () => fixture(async ({ page }) => {
  await oneSlide(page);
  assert.equal(await page.getByRole('button', { name: '이전 슬라이드' }).isDisabled(), true);
  await page.getByRole('button', { name: '다음 슬라이드' }).click(); assert.equal(await current(page), 1);
  await page.keyboard.press('End'); assert.equal(await current(page), 2);
  await page.locator('body').click({position:{x:2,y:2}});
  for (const [key, expected] of [['End',2],['Home',0],['ArrowDown',1],['ArrowUp',0],['PageDown',1],['PageUp',0],['Space',1],['Shift+Space',0]]) {
    await page.keyboard.press(key); assert.equal(await current(page), expected, key); await oneSlide(page);
  }
  const input = page.getByRole('textbox', {name:'Value'}).filter({visible:true});
  await input.focus(); await page.keyboard.press('Space'); assert.equal(await current(page), 0);
  await page.keyboard.press('Tab'); assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'INPUT');
  await page.getByRole('button',{name:'전체 화면'}).click();
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
  await page.evaluate(() => document.exitFullscreen());
  await page.evaluate(() => __sd.clean());
  assert.equal(await page.locator('#sd-presentation-controls:visible').count(), 0);
  await page.evaluate(() => __sd.go(2)); await oneSlide(page);
}));

test('legacy navigation advances once and preserves active flex layout', () => fixture(async ({page}) => {
  await page.keyboard.press('ArrowRight'); assert.equal(await current(page), 1);
  assert.equal(await page.evaluate(() => window.legacyKeys || 0), 0);
  assert.equal(await page.locator('[data-sd-slide]:visible').evaluate(e=>getComputedStyle(e).display), 'flex');
  await page.evaluate(() => goSlide(0)); assert.equal(await current(page), 0); await oneSlide(page);
}, true));

test('HTML export uses the same presentation navigation', () => fixture(async ({page,app,deck}) => {
  const zip = await JSZip.loadAsync((await exportDeck({store:app.store,deck,format:'html'})).buffer);
  await page.route('http://offline.test/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(1), file = zip.file(path);
    await route.fulfill(file ? {contentType:path.endsWith('.js')?'text/javascript':'text/html',body:await file.async('nodebuffer')} : {status:404,body:''});
  });
  await page.goto('http://offline.test/index.html'); await page.waitForFunction(() => !!window.__sd);
  await oneSlide(page); await page.keyboard.press('ArrowRight'); assert.equal(await current(page), 1);
  await page.getByRole('button',{name:'이전 슬라이드'}).click(); assert.equal(await current(page), 0);
}));

test('editor Tab selects unlocked visible objects and leaves canvas at its ends', () => fixture(async ({page,app,deck,first}) => {
  await page.setViewportSize({width:1600,height:1000}); await page.goto(app.origin+'/#deck='+deck.id);
  await page.waitForFunction(() => frameReady && !transitionBusy);
  const frame = page.frameLocator('#deckFrame');
  await frame.locator(`[data-sd-id="${first[0].id}"]`).click();
  await page.keyboard.press('Tab');
  assert.equal(await frame.locator('.sd-selected').getAttribute('data-sd-id'), 'a-tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await frame.locator('.sd-selected').getAttribute('data-sd-id'), first[0].id);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await frame.locator('.sd-selected').count(), 0);
  await frame.getByRole('textbox',{name:'Value'}).first().focus(); await page.keyboard.press('Tab');
  assert.equal(await frame.locator('.sd-selected').count(), 0);
}));


test('native input and contenteditable keys do not trigger legacy slide navigation', () => fixture(async ({page}) => {
  const input = page.getByRole('textbox', {name:'Value'}).filter({visible:true});
  await input.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await current(page), 0);
  const text = page.locator('[data-sd-slide="s0"] h1');
  await text.evaluate(e => e.contentEditable = 'true'); await text.focus();
  await page.keyboard.press('ArrowRight'); assert.equal(await current(page), 0);
  await page.keyboard.press('Space'); assert.equal(await current(page), 0);
}, true));

test('slides directly under body fit and native Tab reaches slide links and controls', () => fixture(async ({page}) => {
  await oneSlide(page);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'A');
  await page.keyboard.press('Enter'); assert.equal(await current(page), 0);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '다음 슬라이드');
  await page.keyboard.press('Space'); assert.equal(await current(page), 1);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '전체 화면');
}, false, true));
