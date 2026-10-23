import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, extname } from 'node:path';

const ZIP_LIMIT = 40 * 1024 * 1024;
const REQUEST_TIMEOUT = 30000;

export class StudioError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new StudioError(code, message); };

export function studioOrigin(raw = 'http://127.0.0.1:4310') {
  let url;
  try { url = new URL(raw); } catch { fail('configuration', 'SLIDES_STUDIO_URL must be an HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    fail('configuration', 'SLIDES_STUDIO_URL must be an HTTP(S) origin without credentials, paths, queries, or fragments.');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    fail('configuration', 'Remote Studio connections require HTTPS. HTTP is allowed only on loopback.');
  return url.origin;
}

async function boundedFile(path, limit, noFollow = false) {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0);
  const handle = await open(path, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail('file_rejected', 'The file must be a regular file within the size limit.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset > limit || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      fail('file_rejected', 'The file changed while being read or exceeded its size limit.');
    if (noFollow) {
      // Windows path stats and handle stats may report different device IDs.
      // Keep the original handle open and compare identity using two handles.
      const check = await open(path, flags);
      try {
        const current = await check.stat();
        if (current.dev !== stat.dev || current.ino !== stat.ino ||
            current.size !== after.size || current.mtimeMs !== after.mtimeMs)
          fail('file_rejected', 'The ZIP path changed while being read.');
      } finally { await check.close(); }
    }
    return { bytes: buffer.subarray(0, offset) };
  } finally { await handle.close(); }
}

const inside = (root, file) => {
  const path = relative(root, file);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
};

export async function readBundle(workspace, input) {
  if (!workspace) fail('workspace_required', 'Set SLIDES_STUDIO_WORKSPACE to explicitly allow local ZIP imports.');
  try {
    const root = await realpath(workspace);
    const requested = resolve(root, input);
    if (!inside(root, requested) || extname(requested).toLowerCase() !== '.zip')
      fail('file_rejected', 'Choose a ZIP file inside SLIDES_STUDIO_WORKSPACE.');
    let current = root, before;
    for (const part of relative(root, requested).split(sep)) {
      current = resolve(current, part);
      before = await lstat(current);
      if (before.isSymbolicLink()) fail('file_rejected', 'ZIP paths must not contain symbolic links.');
    }
    const actual = await realpath(requested);
    if (!inside(root, actual) || actual !== requested) fail('file_rejected', 'ZIP paths must stay inside SLIDES_STUDIO_WORKSPACE.');
    const { bytes } = await boundedFile(actual, ZIP_LIMIT, true);
    const after = await lstat(requested);
    if (await realpath(requested) !== actual || after.dev !== before.dev || after.ino !== before.ino || !after.isFile() || after.isSymbolicLink())
      fail('file_rejected', 'The ZIP path changed while being read.');
    return bytes;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    fail('file_rejected', 'Cannot read the ZIP. Use a regular file of at most 40 MiB inside SLIDES_STUDIO_WORKSPACE.');
  }
}

export class StudioClient {
  #cookie = '';
  #login;
  #env;
  constructor(env = process.env) {
    this.origin = studioOrigin(env.SLIDES_STUDIO_URL);
    this.#env = env;
  }
  async #password() {
    if (this.#env.SLIDES_STUDIO_PASSWORD_FILE) {
      try {
        const { bytes } = await boundedFile(this.#env.SLIDES_STUDIO_PASSWORD_FILE, 16384);
        return bytes.toString('utf8').replace(/\r?\n$/, '');
      } catch { fail('authentication', 'Cannot read the password file. It must be a regular file of at most 16 KiB.'); }
    }
    return this.#env.SLIDES_STUDIO_PASSWORD || '';
  }
  async #fetch(path, method, body, raw = false) {
    try {
      return await fetch(this.origin + '/api' + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: { Origin: this.origin, ...(this.#cookie ? { Cookie: this.#cookie } : {}), ...(body !== undefined ? { 'Content-Type': raw ? 'application/zip' : 'application/json' } : {}) },
        ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
      });
    } catch { fail('connection', 'Studio request failed or timed out. Check its address and availability; redirects are not followed. Reload before retrying a write.'); }
  }
  async #authenticate() {
    const password = await this.#password();
    if (!password) fail('authentication', 'Studio requires authentication. Configure SLIDES_STUDIO_PASSWORD_FILE or SLIDES_STUDIO_PASSWORD.');
    const response = await this.#fetch('/login', 'POST', { password });
    await response.body?.cancel();
    const cookie = /(?:^|;\s*)studio_session=([a-f0-9]+)/.exec(response.headers.get('set-cookie') || '');
    if (!response.ok || !cookie) fail('authentication', 'Studio authentication failed. Check the configured password or retry later.');
    this.#cookie = 'studio_session=' + cookie[1];
  }
  async request(path, method = 'GET', body, raw = false) {
    let response = await this.#fetch(path, method, body, raw);
    if (response.status === 401) {
      await response.body?.cancel();
      this.#login ??= this.#authenticate().finally(() => { this.#login = undefined; });
      await this.#login;
      response = await this.#fetch(path, method, body, raw);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409) fail('revision_conflict', 'HTTP 409: the deck changed. Reload it, merge your intended edits, and use its latest revision. The save was not retried.');
      if (response.status === 401 || response.status === 403) fail('authentication', 'Studio refused authentication or the configured origin.');
      if (response.status === 404) fail('not_found', 'The requested deck or slide was not found.');
      fail('request_rejected', `Studio rejected the request (HTTP ${response.status}). Check the state, slide source, local assets, or ZIP format. No automatic retry was made.`);
    }
    try { return await response.json(); }
    catch { fail('connection', 'Studio returned an unreadable response or timed out. Reload before retrying a write.'); }
  }
  summary(deck) {
    return { id: deck.id, title: deck.title, revision: deck.revision, ...(deck.state ? { slideCount: deck.state.order.length } : {}), editUrl: `${this.origin}/#deck=${deck.id}` };
  }
  async save(deckId, revision, state) {
    const validated = await this.request(`/decks/${deckId}/validate`, 'POST', { state });
    return this.summary(await this.request(`/decks/${deckId}/save`, 'POST', { revision, state: validated.state, source: "ai", summary: "AI 직접 저장" }));
  }
}
