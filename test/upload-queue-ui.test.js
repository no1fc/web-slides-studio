import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { chromium } from 'playwright';
import { startStudio } from '../src/server.js';

async function zip(title, content = '<section class="slide"><h1>Editable presentation</h1></section>') {
  const archive = new JSZip();
  archive.file('index.html', `<!doctype html><html><head><title>${title}</title></head><body>${content}</body></html>`);
  return archive.generateAsync({ type: 'nodebuffer' });
}
const file = (name, buffer) => ({ name, buffer, mimeType: name.endsWith('.pptx') ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/zip' });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-upload-ui-'));
  const app = await startStudio({ root, port: 0, contentPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(app.origin); await page.waitForSelector('#library:not([hidden])');
  const row = name => page.locator('.upload-row').filter({ has: page.getByText(name, { exact: true }) });
  const state = async (name, status) => page.waitForFunction(({ name, status }) => [...document.querySelectorAll('.upload-row')].some(row => row.querySelector('strong')?.textContent === name && row.dataset.status === status), { name, status }, { timeout: 7000 }).catch(async error => { throw new Error(`${name} expected ${status}: ${await page.locator('#uploadQueue').innerText()}`, { cause: error }); });
  return { app, page, row, state };
}

test('multiple ZIP/PPTX uploads isolate failure, retry only failure, review PPTX and reuse identical successful content', { timeout: 45000 }, async t => {
  const { app, page, row, state } = await fixture(t);
  const good = await zip('Good ZIP'), retry = await zip('Retry ZIP');
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE'; pptx.addSlide().addText('PPTX imported text', { x: 1, y: 1, w: 6, h: 1 });
  const ppt = await pptx.write({ outputType: 'nodebuffer' });
  const goodKey = createHash('sha256').update(good).digest('hex'), retryKey = createHash('sha256').update(retry).digest('hex');
  const calls = new Map();
  await page.route('**/api/decks', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const key = route.request().headers()['x-import-key']; calls.set(key, (calls.get(key) || 0) + 1);
    if (key === retryKey && calls.get(key) === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '일시적인 서버 오류입니다. 이 파일만 다시 시도하세요.' }) });
    return route.continue();
  });
  await page.locator('#zipInput').setInputFiles([file('good.zip', good), file('retry.zip', retry), file('slides.pptx', ppt)]);
  await state('good.zip', 'done'); await state('retry.zip', 'error'); await state('slides.pptx', 'review');
  assert.equal((await app.store.list()).length, 1);
  assert.match(await row('retry.zip').innerText(), /이 파일만 다시 시도/);
  assert.equal(calls.get(goodKey), 1);
  await row('retry.zip').getByRole('button', { name: '이 파일 다시 시도' }).click(); await state('retry.zip', 'done');
  assert.equal(calls.get(retryKey), 2); assert.equal(calls.get(goodKey), 1);
  await row('slides.pptx').getByRole('button', { name: '변환 결과 가져오기' }).click(); await state('slides.pptx', 'done');
  assert.equal((await app.store.list()).length, 3);
  await page.locator('#zipInput').setInputFiles(file('same-renamed.zip', good)); await state('same-renamed.zip', 'duplicate');
  assert.match(await row('same-renamed.zip').innerText(), /같은 내용의 파일/);
  assert.equal(calls.get(goodKey), 1);
  await row('same-renamed.zip').getByRole('button', { name: '중복 확인 후 계속' }).click(); await state('same-renamed.zip', 'done');
  assert.equal(calls.get(goodKey), 2); assert.equal((await app.store.list()).length, 3, 'server hash idempotency must reuse the existing deck');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await row('slides.pptx').getByRole('button', { name: '자료 열기' }).click();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForFunction(() => state?.added?.some(item => item.text?.includes('PPTX imported text')));
  await page.goto(app.origin);await page.locator('.deck-card').first().waitFor();
  await page.locator('#zipInput').setInputFiles(file('existing-after-reload.zip',good));await state('existing-after-reload.zip','duplicate');
  assert.equal((await app.store.list()).length,3);
});

test('drop during final library refresh stays queued and malformed packages fail before upload', { timeout: 45000 }, async t => {
  const { app, page, row, state } = await fixture(t);
  const first = await zip('First'), dropped = await zip('Dropped');
  let hold = false, entered; const refreshing = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  await page.route('**/api/decks', async route => {
    if (route.request().method() === 'POST') { writes++; hold = true; return route.continue(); }
    if (hold) { hold = false; entered(); await gate; }
    return route.continue();
  });
  await page.locator('#zipInput').setInputFiles(file('first.zip', first)); await state('first.zip', 'done'); await refreshing;
  const transfer = await page.evaluateHandle(bytes => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], 'dropped.zip', { type: 'application/zip' })); return dt; }, [...dropped]);
  await page.locator('#library').dispatchEvent('dragover', { dataTransfer: transfer });
  assert.match(await page.locator('#library').getAttribute('class') || '', /drop-active/);
  await page.locator('#library').dispatchEvent('drop', { dataTransfer: transfer }); release();
  await state('dropped.zip', 'done'); assert.equal((await app.store.list()).length, 2);
  await page.unroute('**/api/decks');
  let badWrites = 0; await page.route('**/api/decks', async route => { if (route.request().method() === 'POST') badWrites++; return route.continue(); });
  const empty = await zip('No slides', '<main>No slide elements</main>');
  const missing = await zip('Missing image', '<section class="slide"><img src="missing.png"></section>');
  const nested = await zip('Different parents', '<main><section class="slide">A</section></main><aside><section class="slide">B</section></aside>');
  await page.locator('#zipInput').setInputFiles([file('empty.zip', empty), file('missing.zip', missing), file('structure.zip', nested), file('not-pptx.pptx', first), file('unsupported.txt', Buffer.from('not a deck'))]);
  for (const name of ['empty.zip', 'missing.zip', 'structure.zip', 'not-pptx.pptx', 'unsupported.txt']) await state(name, 'error');
  assert.match(await row('empty.zip').innerText(), /슬라이드/); assert.match(await row('missing.zip').innerText(), /missing.png/);
  assert.match(await row('structure.zip').innerText(), /같은 부모/);
  assert.match(await row('not-pptx.pptx').innerText(), /PowerPoint/);
  assert.match(await row('unsupported.txt').innerText(), /지원하지 않는 파일/);
  assert.equal(badWrites, 0); assert.equal(writes, 2); assert.equal((await app.store.list()).length, 2);
});
