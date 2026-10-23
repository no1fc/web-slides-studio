import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { startStudio } from '../src/server.js';
import { prepareDeck } from '../src/deck.js';
import { exportDeck } from '../src/export.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-feedback-'));
  const app = await startStudio({root, port: 0, contentPort: 0, password: 'feedback-test-password'});
  t.after(async () => { await app.close(); await rm(root, {recursive: true, force: true}); });
  const input = prepareDeck('<html><head><style>body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none}.slide.active{display:block}</style></head><body><main id="stage"><section class="slide"><h1>First</h1><p>Body</p></section><section class="slide"><h1>Second</h1></section></main></body></html>');
  input.files = new Map([['index.html', Buffer.from(input.html)]]);
  const created = await app.store.create(input);
  const login = await fetch(app.origin + '/api/login', {method: 'POST', headers: {Origin: app.origin, 'Content-Type': 'application/json'}, body: JSON.stringify({password: 'feedback-test-password'})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(app.origin + '/api' + path, {method, headers: {Origin: app.origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, data: await response.json()};
  };
  const deck = (await request('/decks/' + created.id)).data;
  return {app, deck, root, request, path: '/decks/' + deck.id + '/feedback'};
}

test('feedback authenticates, validates origin and targets, stores only private data without changing content timestamps', async t => {
  const {app, deck, request, path} = await fixture(t);
  assert.equal((await request(path, 'GET', undefined, {Cookie: ''})).status, 401);
  assert.equal((await request(path, 'POST', {revision: 1, slideId: 's0', text: 'edit'}, {Origin: 'https://other.invalid'})).status, 403);
  const before = await readFile(app.store.path(deck.id, 'meta.json'), 'utf8');
  for (const body of [null, [], {revision: 1, slideId: 's0', text: ' '}, {revision: 1, slideId: 's0', text: 'a'.repeat(2001)}, {revision: '1', slideId: 's0', text: 'x'}, {revision: 1, slideId: 's9', text: 'x'}, {revision: 1, slideId: 's0', elementId: 'e2', text: 'wrong slide'}, {revision: 1, slideId: 's0', elementId: 'e999', text: 'missing'}, {revision: 1, slideId: 's0', elementId: {}, text: 'bad type'}, {revision: 1, slideId: 's0', text: 'x', password: 'never store'}]) {
    assert.equal((await request(path, 'POST', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await request(path, 'POST', {revision: 2, slideId: 's0', text: 'stale'})).status, 409);
  const result = await request(path, 'POST', {revision: 1, slideId: 's0', elementId: 'e0', text: '  First title needs more detail  '});
  assert.equal(result.status, 201); const item = result.data;
  assert.equal(item.text, 'First title needs more detail');assert.equal(item.status, 'open');assert.equal(item.version, 1);assert.equal(item.createdAt, item.updatedAt);assert.ok(item.createdAt.endsWith('Z'));
  assert.equal(await readFile(app.store.path(deck.id, 'meta.json'), 'utf8'), before);
  const second = (await request(path, 'POST', {revision: 1, slideId: 's1', text: 'Slide request'})).data;
  assert.equal(second.elementId, null);
  const list = (await request(path)).data;assert.equal(list.revision, 1);assert.deepEqual(list.items.map(i => i.id), [second.id, item.id]);assert.ok(list.items.every(i => !i.stale && i.targetExists));
  assert.equal((await app.store.get(deck.id)).revision, 1);assert.equal((await app.store.revisions(deck.id)).length, 1);
});

test('feedback resolves actual clone, authored, added and group object ownership', async t => {
  const {app, deck, request, path} = await fixture(t);
  const state = structuredClone(deck.state);state.clones['s-copy'] = 's0';state.order.push('s-copy');state.slideCode.s1 = {html: '<h1>Authored object</h1>', css: ''};
  state.added.push({id: 'a-text', slide: 's0', kind: 'text', text: 'Added', x: 10, y: 10, w: 200, h: 100});
  const children = [0,100].map(x => ({kind: 'text', x, y: 0, w: 100, h: 100, text: 'Grouped'}));
  state.added.push({id: 'a-group', slide: 's1', kind: 'group', x: 10, y: 10, w: 200, h: 100, group: {width: 200, height: 100, children}});
  const saved = await app.store.save(deck.id, 1, state);
  const codeId = /data-sd-id="([^"]+)"/.exec(saved.state.slideCode.s1.html)[1];
  for (const [slideId, elementId] of [['s-copy', 's-copy--e0'], ['s1', codeId], ['s0', 'a-text'], ['s1', 'a-group']]) {
    assert.equal((await request(path, 'POST', {revision: 2, slideId, elementId, text: 'Targeted request'})).status, 201, elementId);
    const wrong = slideId === 's0' ? 's1' : 's0';assert.equal((await request(path, 'POST', {revision: 2, slideId: wrong, elementId, text: 'Wrong owner'})).status, 400);
  }
  assert.equal((await request(path, 'POST', {revision: 2, slideId: 's1', elementId: 'e2', text: 'Replaced original'})).status, 400);
});

test('feedback status uses independent CAS and survives content saves, missing targets, restoration and trash', async t => {
  const {app, deck, request, path} = await fixture(t);
  const item = (await request(path, 'POST', {revision: 1, slideId: 's0', elementId: 'e0', text: 'Keep this request'})).data;
  const changes = await Promise.all(['resolved', 'open'].map(status => request(path + '/' + item.id, 'PATCH', {version: 1, status})));
  assert.deepEqual(changes.map(r => r.status).sort(), [200,409]);
  const changed = changes.find(r => r.status === 200).data;assert.equal(changed.version, 2);assert.equal(changed.createdAt, item.createdAt);
  assert.equal((await request(path + '/' + item.id, 'PATCH', {version: 2, status: 'deleted'})).status, 400);
  assert.equal((await request(path + '/' + item.id, 'PATCH', {version: 2, status: 'resolved', text: 'overwrite'})).status, 400);
  assert.equal((await request(path + '/' + randomUUID(), 'PATCH', {version: 1, status: 'resolved'})).status, 404);
  assert.equal((await request(path + '/' + '-'.repeat(36), 'PATCH', {version: 1, status: 'resolved'})).status, 400);
  assert.equal((await request(path + '/' + item.id, 'DELETE')).status, 405);
  const state = structuredClone(deck.state);state.order = ['s1'];await app.store.save(deck.id, 1, state);
  let list = (await request(path)).data;assert.equal(list.revision, 2);assert.equal(list.items[0].stale, true);assert.equal(list.items[0].targetExists, false);
  const resolved = await request(path + '/' + item.id, 'PATCH', {version: 2, status: 'resolved'});assert.equal(resolved.status, 200);assert.equal(resolved.data.version, 3);
  const restored = await request('/decks/' + deck.id + '/restore', 'POST', {revision: 2, target: 1});assert.equal(restored.status, 200);
  list = (await request(path)).data;assert.equal(list.revision, 3);assert.equal(list.items[0].targetExists, true);assert.equal(list.items[0].stale, true);assert.equal(list.items[0].status, 'resolved');
  await app.store.update(deck.id, {deleted: true});
  for (const [url, method, body] of [[path, 'GET', undefined], [path, 'POST', {revision: 3, slideId: 's0', text: 'x'}], [path + '/' + item.id, 'PATCH', {version: 3, status: 'open'}]]) assert.equal((await request(url, method, body)).status, 409);
  await app.store.update(deck.id, {deleted: false});assert.equal((await request(path)).data.items[0].id, item.id);
});

test('feedback caps all retained requests at 500 and never leaks into sharing, exports, copies or templates', async t => {
  const {app, deck, request, path} = await fixture(t);const secret = 'PRIVATE-FEEDBACK-ONLY-9164';
  const item = (await request(path, 'POST', {revision: 1, slideId: 's0', text: secret})).data;
  await app.store.atomic(app.store.path(deck.id, 'feedback.json'), Array.from({length: 499}, (_, index) => ({...item, id: index === 0 ? item.id : randomUUID(), status: 'resolved'})));
  const finalSlots = await Promise.all(['Last request', 'Over limit'].map(text => request(path, 'POST', {revision: 1, slideId: 's0', text})));
  assert.deepEqual(finalSlots.map(result => result.status).sort(), [201, 409]);
  assert.equal((await request(path)).data.items.length, 500);
  const shared = (await request('/decks/' + deck.id + '/publish', 'POST', {enabled: true})).data;
  for (const url of [deck.previewUrl, deck.audienceUrl, shared.shareUrl]) {const response = await fetch(url);assert.equal(response.status, 200);assert.ok(!(await response.text()).includes(secret));assert.equal((await fetch(new URL('feedback.json', url))).status, 404);}
  const current = await app.store.get(deck.id);assert.ok(!JSON.stringify(current).includes(secret));assert.ok(!JSON.stringify(await app.store.revisions(deck.id)).includes(secret));
  for (const format of ['html', 'pptx']) {
    const output = await exportDeck({store: app.store, deck: current, format, url: deck.previewUrl, contentOrigin: app.contentOrigin, includeNotes: false});
    const zip = await JSZip.loadAsync(output.buffer);assert.equal(zip.file('feedback.json'), null);
    for (const entry of Object.values(zip.files)) if (!entry.dir && /\.(?:html|js|json|xml)$/.test(entry.name)) assert.ok(!(await entry.async('string')).includes(secret), entry.name);
  }
  const copy = await app.store.duplicate(deck.id);assert.deepEqual((await request('/decks/' + copy.id + '/feedback')).data.items, []);
  const template = (await request('/templates', 'POST', {deckId: deck.id, name: 'Clean template'})).data;
  const fromTemplate = (await request('/templates/' + template.id + '/create', 'POST', {})).data;assert.deepEqual((await request('/decks/' + fromTemplate.id + '/feedback')).data.items, []);
});
