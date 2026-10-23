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
