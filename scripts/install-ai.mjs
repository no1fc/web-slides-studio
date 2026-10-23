#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, stat, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = 'web-slides-studio';
const requireMcp = createRequire(new URL('../integrations/mcp/package.json', import.meta.url));
// npm's Windows .cmd shims need PATH/PATHEXT resolution and argument escaping.
const run = (command, args) => requireMcp('cross-spawn').sync(command, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
async function exists(path) { try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function equalTree(a, b) {
  const entries = await readdir(a, { withFileTypes: true });
  if (!await exists(b) || (await readdir(b)).length !== entries.length) return false;
  for (const entry of entries) {
    const x = join(a, entry.name), y = join(b, entry.name);
    if (!await exists(y)) return false;
    if (entry.isDirectory()) { if (!(await stat(y)).isDirectory() || !await equalTree(x, y)) return false; }
    else if (!(await stat(y)).isFile() || !(await readFile(x)).equals(await readFile(y))) return false;
  }
  return true;
}
// Passwords are entered on a real terminal, never echoed or passed in command arguments.
export async function configure(options, { home = homedir(), askPassword } = {}) {
  const directory = join(home, '.slides-studio');
  const workspace = resolve(options.workspace || join(directory, 'workspace'));
  const passwordFile = resolve(options['password-file'] || join(directory, 'password'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true });
  if (!await exists(passwordFile)) {
    if (!askPassword) {
      if (!process.stdin.isTTY) throw new Error('Run --setup in an interactive terminal, or prepare a private --password-file.');
      askPassword = async () => {
        process.stderr.write('Studio login password (hidden; Enter for a server without a password): ');
        const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
        const rl = createInterface({ input: process.stdin, output, terminal: true });
        try { return await rl.question(''); }
        finally { rl.close(); process.stderr.write('\n'); }
      };
    }
    const password = await askPassword();
    if (password) {
      await writeFile(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') await chmod(passwordFile, 0o600);
    }
  }
  return { ...options, workspace, ...(await exists(passwordFile) ? { 'password-file': passwordFile } : {}) };
}
export async function install(options, { home = homedir(), runner = run, repository = root } = {}) {
  const client = options.client || 'all';
  if (!['codex', 'claude', 'all'].includes(client)) throw new Error('--client must be codex, claude, or all.');
  const url = new URL(options.url || 'http://127.0.0.1:4310');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
    throw new Error('Use an HTTPS origin, or HTTP on loopback only.');
  const env = [`SLIDES_STUDIO_URL=${url.origin}`];
  for (const [key, variable, directory] of [['password-file', 'SLIDES_STUDIO_PASSWORD_FILE', false], ['workspace', 'SLIDES_STUDIO_WORKSPACE', true]]) {
    if (!options[key]) continue;
    const path = resolve(options[key]);
    const info = await stat(path);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(`Invalid --${key}.`);
    env.push(`${variable}=${path}`);
  }
  const server = join(repository, 'integrations/mcp/server.js');
  if (!await exists(join(repository, 'integrations/mcp/node_modules/@modelcontextprotocol/sdk'))) throw new Error('Run npm ci --prefix integrations/mcp first.');
  const source = join(repository, 'skills/web-slides-author');
  const plans = [];
  for (const target of client === 'all' ? ['codex', 'claude'] : [client]) {
    if (runner(target, ['--version']).status !== 0) {
      if (client !== 'all') throw new Error(`${target} CLI is not available.`);
      continue;
    }
    const destination = join(home, target === 'codex' ? '.agents' : '.claude', 'skills/web-slides-author');
    const same = await equalTree(source, destination);
    if (await exists(destination) && !same && !options.replace) throw new Error(`${target} skill already exists with different content. Use --replace to update it.`);
    const registered = runner(target, ['mcp', 'get', name]).status === 0;
    if (registered && !options.replace) throw new Error(`${target} MCP entry already exists. Use --replace to update this entry.`);
    plans.push({ target, destination, same, registered });
  }
  if (!plans.length) throw new Error('Install the Codex or Claude Code CLI first.');
  const completed = [];
  for (const { target, destination, same, registered } of plans) {
    if (registered) {
      const args = ['mcp', 'remove', name, ...(target === 'claude' ? ['--scope', 'user'] : [])];
      if (runner(target, args).status !== 0) throw new Error(`${target} MCP removal failed. Existing skill preserved.`);
    }
    const args = ['mcp', 'add', name, ...(target === 'claude' ? ['--transport', 'stdio', '--scope', 'user'] : []),
      ...env.flatMap(value => ['--env', value]), '--', process.execPath, server];
    if (runner(target, args).status !== 0) throw new Error(`${target} MCP registration failed. Completed clients: ${completed.join(', ') || 'none'}. Retry installation; no password was printed.`);
    if (!same) { await mkdir(dirname(destination), { recursive: true }); await cp(source, destination, { recursive: true, force: true }); }
    completed.push(target);
  }
  return completed;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { client: { type: 'string' }, url: { type: 'string' }, 'password-file': { type: 'string' }, workspace: { type: 'string' }, replace: { type: 'boolean' }, setup: { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/install-ai.mjs --client codex|claude|all --url https://slides.example.com --password-file /private/password.txt --workspace /path/to/decks [--setup] [--replace]\n--setup privately prompts for a password and creates a local ZIP workspace. Never put passwords in commands.\nRegisters a user-scope stdio MCP server and copies the authoring Skill. Keep this repository at its installed path.');
    else console.log(`Installed for: ${(await install(values.setup ? await configure(values) : values)).join(', ')}. Restart your AI client and enable the tools. Credentials are read only by the MCP server.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
