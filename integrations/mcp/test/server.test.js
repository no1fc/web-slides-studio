import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, truncate, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import JSZip from '../../../node_modules/jszip/lib/index.js';
import { startStudio } from '../../../src/server.js';
import { StudioClient, studioOrigin } from '../client.js';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });
  const ok = async (name, args) => {
    const result = await call(name, args);
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result.structuredContent;
  };
  return { client, call, ok, stderr: () => stderr };
}

test('real stdio SDK authenticates, edits, reloads, rejects conflicts and imports within the workspace', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'slides-mcp-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const password = 'test-only-MCP-secret-82!';
  const passwordFile = join(root, 'password');
  await writeFile(passwordFile, password + '\n', { mode: 0o600 });
  const app = await startStudio({ root: join(root, 'data'), port: 0, contentPort: 0, password });
  t.after(() => app.close());
  const { client, call, ok, stderr } = await connect(t, {
    SLIDES_STUDIO_URL: app.origin,
    SLIDES_STUDIO_PASSWORD_FILE: passwordFile,
    SLIDES_STUDIO_PASSWORD: 'ignored-fallback',
    SLIDES_STUDIO_WORKSPACE: workspace,
  });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 10);
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.ok(!tools.some(tool => /delete|publish|password/.test(tool.name)));
  assert.deepEqual(await ok('slides_list_decks'), { decks: [] });
  const created = await ok('slides_create_deck', { title: 'MCP round trip' });
  assert.equal(created.title, 'MCP round trip');
  assert.equal(created.editUrl, `${app.origin}/#deck=${created.id}`);
  let deck = await ok('slides_get_deck', { deckId: created.id });
  const stored = await app.store.get(created.id);
  for (const secret of [password, stored.previewToken]) assert.ok(!JSON.stringify(deck).includes(secret));
  assert.equal(deck.previewToken, undefined);
  assert.equal(deck.previewUrl, undefined);
  const slideId = deck.state.order[0];
  const source = await ok('slides_get_slide_source', { deckId: deck.id, slideId });
  assert.match(source.html, /h1/);
  assert.equal(source.revision, deck.revision);
  assert.equal(source.editUrl, deck.editUrl);
  deck.state.notes[slideId] = 'Keep speaker notes';
  deck.state.clones['s-copy'] = slideId;
  deck.state.order.push('s-copy');
  deck.state.added.push({ id: 'a-extra', slide: slideId, kind: 'text', text: 'Keep addition', x: 40, y: 40 });
  deck.state.patches['a-extra'] = { text: 'Keep patched addition' };
  deck.state.patches[deck.elements[0].id] = { text: 'Replace stale source' };
  deck.state.patches['s-copy--' + deck.elements[0].id] = { text: 'Keep clone patch' };
  const saved = await ok('slides_update_state', { deckId: deck.id, revision: deck.revision, state: deck.state });
  assert.equal(saved.revision, 2);
  const edited = await ok('slides_update_slide', { deckId: deck.id, revision: saved.revision, slideId, html: '<h1>Changed by MCP</h1>', css: 'h1{color:red}' });
  assert.equal(edited.revision, 3);
  deck = await ok('slides_get_deck', { deckId: deck.id });
  assert.match(deck.state.slideCode[slideId].html, /Changed by MCP/);
  assert.equal(deck.state.notes[slideId], 'Keep speaker notes');
  assert.equal(deck.state.added[0].text, 'Keep addition');
  assert.equal(deck.state.patches['a-extra'].text, 'Keep patched addition');
  assert.equal(deck.state.patches[deck.elements[0].id], undefined);
  assert.equal(deck.state.patches['s-copy--' + deck.elements[0].id].text, 'Keep clone patch');
  const conflict = await call('slides_update_state', { deckId: deck.id, revision: 1, state: deck.state });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /revision_conflict/);
  const invalid = await call('slides_update_state', { deckId: deck.id, revision: 3, state: { ...deck.state, unknown: true } });
  assert.equal(invalid.isError, true);
  assert.equal((await app.store.get(deck.id)).revision, 3);
  const unsafe = await call('slides_update_slide', { deckId: deck.id, revision: 3, slideId, html: '<script>window.x=1</script>', css: '' });
  assert.equal(unsafe.isError, true);
  assert.equal((await app.store.get(deck.id)).revision, 3);
  assert.equal((await call('slides_get_deck', { deckId: deck.id, unexpected: true })).isError, true);
  const codeElementId = /data-sd-id="([^"]+)"/.exec(deck.state.slideCode[slideId].html)[1];
  deck.state.patches[codeElementId] = { text: 'Stale generated patch' };
  const patched = await ok('slides_update_state', { deckId: deck.id, revision: 3, state: deck.state });
  const replaced = await ok('slides_update_slide', { deckId: deck.id, revision: patched.revision, slideId, html: '<p>Replacement source</p>', css: '' });
  deck = await ok('slides_get_deck', { deckId: deck.id });
  assert.equal(deck.state.patches[codeElementId], undefined);
  await ok('slides_update_slide', { deckId: deck.id, revision: replaced.revision, slideId: 's-copy', html: '<h2>Clone source</h2>', css: '' });
  deck = await ok('slides_get_deck', { deckId: deck.id });
  assert.equal(deck.state.patches['s-copy--' + deck.elements[0].id], undefined);
  assert.match(deck.state.slideCode[slideId].html, /Replacement source/);
  assert.equal(deck.state.patches['a-extra'].text, 'Keep patched addition');
  const zip = new JSZip();
  zip.file('index.html', '<!doctype html><html><head><title>Bundle</title></head><body><section class="slide"><h1>Imported</h1></section></body></html>');
  const zipPath = join(workspace, 'bundle.zip');
  await writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
  const imported = await ok('slides_import_bundle', { path: zipPath });
  assert.equal(imported.title, 'Bundle');
  assert.equal((await ok('slides_list_decks')).decks.length, 2);
  const outsidePath = join(root, 'outside.zip');
  await writeFile(outsidePath, await readFile(zipPath));
  await symlink(outsidePath, join(workspace, 'link.zip'));
  await symlink(root, join(workspace, 'linked-dir'));
  await writeFile(join(workspace, 'oversize.zip'), '');
  await truncate(join(workspace, 'oversize.zip'), 40 * 1024 * 1024 + 1);
  for (const path of [outsidePath, '../outside.zip', 'link.zip', 'linked-dir/outside.zip', 'oversize.zip', passwordFile, workspace]) {
    const result = await call('slides_import_bundle', { path });
    assert.equal(result.isError, true, path);
    assert.ok(!JSON.stringify(result).includes(password));
  }
  const prompt = await client.getPrompt({ name: 'slides_create_presentation', arguments: { brief: 'Build three slides about astronomy' } });
  assert.match(prompt.messages[0].content.text, /astronomy/);
  assert.match(prompt.messages[0].content.text, /409|revision_conflict/);
  assert.equal(stderr(), '');

  const wrong = await connect(t, { SLIDES_STUDIO_URL: app.origin, SLIDES_STUDIO_PASSWORD: 'incorrect-private-secret' });
  const authError = await wrong.call('slides_list_decks');
  assert.equal(authError.isError, true);
  assert.match(authError.content[0].text, /authentication/);
  assert.ok(!JSON.stringify(authError).includes('incorrect-private-secret'));
  const noWorkspace = await connect(t, { SLIDES_STUDIO_URL: app.origin, SLIDES_STUDIO_PASSWORD_FILE: passwordFile });
  assert.equal((await noWorkspace.call('slides_import_bundle', { path: zipPath })).isError, true);
});

test('URL configuration rejects credentials, remote HTTP, paths and alternate protocols', () => {
  assert.equal(studioOrigin(), 'http://127.0.0.1:4310');
  assert.equal(studioOrigin('https://slides.example.test/'), 'https://slides.example.test');
  assert.equal(studioOrigin('http://[::1]:4310'), 'http://[::1]:4310');
  for (const raw of ['not a URL', 'file:///etc/passwd', 'ftp://localhost', 'http://example.test', 'http://localhost.example.test', 'https://secret:password@example.test', 'https://example.test/path', 'https://example.test?password=secret', 'https://example.test/#secret'])
    assert.throws(() => studioOrigin(raw), error => error.code === 'configuration' && !error.message.includes('password=secret'));
});

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('credentials stay private, redirects are never followed and login happens only after 401', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'slides-mcp-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let logins = 0, escaped = 0, calls = 0;
  const secret = 'response-secret-must-not-escape';
  const other = await endpoint(t, (req, res) => { escaped++; res.end('{}'); });
  const origin = await endpoint(t, (req, res) => {
    calls++;
    if (req.url === '/api/login') { logins++; res.writeHead(401); res.end(JSON.stringify({ error: secret })); return; }
    if (req.url === '/api/redirect') { res.writeHead(302, { Location: other }); res.end(); return; }
    if (req.url === '/api/needs-auth') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/api/failure') { res.writeHead(400); res.end(JSON.stringify({ error: secret })); return; }
    assert.equal(req.headers.origin, origin);
    assert.equal(req.headers.cookie, undefined);
    res.setHeader('Content-Type', 'application/json');
    res.end('[]');
  });
  const client = new StudioClient({ SLIDES_STUDIO_URL: origin, SLIDES_STUDIO_PASSWORD: secret });
  assert.deepEqual(await client.request('/decks'), []);
  assert.equal(logins, 0);
  await assert.rejects(client.request('/redirect'), error => error.code === 'connection');
  assert.equal(escaped, 0);
  await assert.rejects(client.request('/failure'), error => !error.message.includes(secret) && error.code === 'request_rejected');
  await assert.rejects(client.request('/needs-auth'), error => !error.message.includes(secret) && error.code === 'authentication');
  assert.equal(logins, 1);
  const giant = join(root, 'too-big');
  await writeFile(giant, Buffer.alloc(16385));
  for (const passwordFile of [root, giant, join(root, 'absent')]) {
    const badFile = new StudioClient({ SLIDES_STUDIO_URL: origin, SLIDES_STUDIO_PASSWORD_FILE: passwordFile, SLIDES_STUDIO_PASSWORD: secret });
    await assert.rejects(badFile.request('/needs-auth'), error => error.code === 'authentication');
  }
  assert.equal(logins, 1, 'bad password files must not fall back or send credentials');
  const noPassword = new StudioClient({ SLIDES_STUDIO_URL: origin });
  await assert.rejects(noPassword.request('/needs-auth'), error => error.code === 'authentication');
  assert.equal(logins, 1);
  assert.ok(calls >= 8);
});


test('AI proposals and diagnostics preserve the saved deck and report only observed safe status', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'slides-mcp-proposals-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const password = 'diagnostic-secret-never-output';
  const app = await startStudio({ root: join(root, 'data'), port: 0, contentPort: 0, password });
  t.after(() => app.close());
  const { ok, call, client } = await connect(t, { SLIDES_STUDIO_URL: app.origin, SLIDES_STUDIO_PASSWORD: password, SLIDES_STUDIO_WORKSPACE: workspace });
  const diagnosis = await ok('slides_diagnose_connection');
  assert.ok(!JSON.stringify(diagnosis).includes(password));
  assert.ok(!JSON.stringify(diagnosis).includes(workspace));
  const http = new StudioClient({ SLIDES_STUDIO_URL: app.origin, SLIDES_STUDIO_PASSWORD: password });
  const { report } = await http.request('/ai-connection');
  assert.equal(report.version, '0.3.0');
  assert.deepEqual(report.checks, { server: 'ok', authentication: 'ok', tools: 'ok', workspace: 'ok' });
  assert.ok(Number.isFinite(Date.parse(report.reportedAt)));
  const created = await ok('slides_create_deck');
  const deck = await ok('slides_get_deck', { deckId: created.id });
  const slideId = deck.state.order[0];
  const before = structuredClone(deck.state);
  await ok('slides_propose_slide', { deckId: deck.id, revision: deck.revision, slideId, html: '<h1>Review first</h1>', css: '' });
  assert.deepEqual((await ok('slides_get_deck', { deckId: deck.id })).state, before);
  assert.equal((await app.store.get(deck.id)).revision, deck.revision);
  deck.state.notes[slideId] = 'Proposed notes';
  await ok('slides_propose_state', { deckId: deck.id, revision: deck.revision, state: deck.state, summary: 'Review notes' });
  assert.deepEqual((await ok('slides_get_deck', { deckId: deck.id })).state, before);
  await ok('slides_update_state', { deckId: deck.id, revision: deck.revision, state: before });
  assert.equal((await call('slides_propose_state', { deckId: deck.id, revision: deck.revision, state: deck.state })).isError, true);
  const prompt = await client.getPrompt({ name: 'slides_create_presentation', arguments: { brief: 'A reviewable edit' } });
  assert.match(prompt.messages[0].content.text, /slides_propose_slide/);
  const wrong = await connect(t, { SLIDES_STUDIO_URL: app.origin, SLIDES_STUDIO_PASSWORD: 'wrong' });
  const failed = await wrong.ok('slides_diagnose_connection');
  assert.equal(failed.report.checks.authentication, 'error');
  assert.equal(failed.report.checks.server, 'ok');
  assert.equal(failed.reportSaved, false);
  assert.equal((await http.request('/ai-connection')).report.reportedAt, report.reportedAt, 'failed authentication must not replace an authenticated report');
  const missing = await connect(t, { SLIDES_STUDIO_URL: app.origin, SLIDES_STUDIO_PASSWORD: password, SLIDES_STUDIO_WORKSPACE: join(root, 'missing') });
  const missingReport = await missing.ok('slides_diagnose_connection');
  assert.equal((missingReport.report || missingReport).checks.workspace, 'error');
});
