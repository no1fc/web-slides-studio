import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../scripts/install-ai.mjs';

test('AI installer registers user clients without password values and protects existing config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'slides-install-'));
  try {
    const repository = join(home, 'repo');
    await mkdir(join(repository, 'integrations/mcp/node_modules/@modelcontextprotocol/sdk'), { recursive: true });
    await mkdir(join(repository, 'skills/web-slides-author'), { recursive: true });
    await writeFile(join(repository, 'skills/web-slides-author/SKILL.md'), 'skill');
    const secret = join(home, 'password'); await writeFile(secret, 'never-print-this');
    const calls = [], registered = new Set();
    const runner = (command, args) => {
      calls.push([command, args]);
      if (args[1] === 'get') return { status: registered.has(command) ? 0 : 1 };
      if (args[1] === 'add') registered.add(command);
      if (args[1] === 'remove') registered.delete(command);
      return { status: 0 };
    };
    const config = { client: 'all', url: 'https://slides.example.com', 'password-file': secret, workspace: home };
    assert.deepEqual(await install(config, { home, repository, runner }), ['codex', 'claude']);
    assert.equal(await readFile(join(home, '.agents/skills/web-slides-author/SKILL.md'), 'utf8'), 'skill');
    assert.equal(await readFile(join(home, '.claude/skills/web-slides-author/SKILL.md'), 'utf8'), 'skill');
    assert.ok(!JSON.stringify(calls).includes('never-print-this'));
    assert.ok(calls.find(([c, a]) => c === 'claude' && a.includes('--scope') && a.includes('user')));
    await assert.rejects(install(config, { home, repository, runner }), /already exists/);
    await install({ ...config, replace: true }, { home, repository, runner });
    assert.equal(calls.filter(([, a]) => a[1] === 'remove').length, 2);
    await assert.rejects(install({ url: 'http://remote.example.com' }, { home, repository, runner }), /HTTPS/);
    await assert.rejects(install({ client: 'unknown' }, { home, repository, runner }), /client/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('default runner discovers CLI shims and preserves MCP arguments with spaces and metacharacters', async () => {
  const home = await mkdtemp(join(tmpdir(), 'slides 설치 (PC) & '));
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const originalPath = process.env[pathKey];
  try {
    const repository = join(home, 'repo'), bin = join(home, 'bin');
    await mkdir(bin);
    await mkdir(join(repository, 'integrations/mcp/node_modules/@modelcontextprotocol/sdk'), { recursive: true });
    await mkdir(join(repository, 'skills/web-slides-author'), { recursive: true });
    await writeFile(join(repository, 'skills/web-slides-author/SKILL.md'), 'skill');
    const secret = join(home, 'private & password.txt');
    await writeFile(secret, 'never-print-this');
    const log = join(home, 'calls.jsonl');
    const program = `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nprocess.exit(args[1] === 'get' ? 1 : 0);\n`;
    for (const client of ['claude', 'codex']) {
      await writeFile(join(bin, client + '.cjs'), program);
      if (process.platform === 'win32') {
        await writeFile(join(bin, client + '.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0${client}.cjs" %*\r\n`);
      } else {
        await writeFile(join(bin, client), program, { mode: 0o755 });
      }
    }
    process.env[pathKey] = bin + (process.platform === 'win32' ? ';' : ':') + (originalPath || '');
    assert.deepEqual(await install({ client: 'all', url: 'https://slides.example.com', 'password-file': secret, workspace: home }, { home, repository }), ['codex', 'claude']);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(args => args[0] === '--version').length, 2);
    const additions = calls.filter(args => args[1] === 'add');
    assert.equal(additions.length, 2);
    for (const args of additions) {
      assert.ok(args.includes('SLIDES_STUDIO_PASSWORD_FILE=' + secret));
      assert.ok(args.includes('SLIDES_STUDIO_WORKSPACE=' + home));
      assert.deepEqual(args.slice(-3), ['--', process.execPath, join(repository, 'integrations/mcp/server.js')]);
      assert.ok(!JSON.stringify(args).includes('never-print-this'));
    }
  } finally {
    if (originalPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = originalPath;
    await rm(home, { recursive: true, force: true });
  }
});
