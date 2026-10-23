import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBundle } from '../client.js';

async function fixture(t) {
  // Windows TEMP may use a short-name alias; use the canonical workspace path.
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'slides ZIP 한글 ')));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'deck.zip'), bytes = Buffer.from('test ZIP bytes');
  await fs.writeFile(path, bytes);
  return { root, path, bytes };
}

test('normal bundle accepts absolute and workspace-relative paths', async t => {
  const { root, path, bytes } = await fixture(t);
  const handle = await fs.open(path, 'r');
  try {
    t.diagnostic(`platform=${process.platform}, lstat.dev=${(await fs.lstat(path)).dev}, handle.stat.dev=${(await handle.stat()).dev}`);
  } finally { await handle.close(); }
  assert.deepEqual(await readBundle(root, path), bytes);
  assert.deepEqual(await readBundle(root, 'deck.zip'), bytes);
});

test('path stats may report dev zero while open file handles report the real device', async t => {
  const { root, path, bytes } = await fixture(t);
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args) => {
    const info = await original(...args);
    info.dev = 0;
    return info;
  });
  syncBuiltinESMExports();
  assert.deepEqual(await readBundle(root, path), bytes);
});

test('replacing the ZIP with a same-sized file during the read is rejected', async t => {
  const { root, path, bytes } = await fixture(t);
  const original = fs.open;
  let replaced = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args);
    if (args[0] === path && !replaced) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!replaced) {
          replaced = true;
          await fs.rename(path, join(root, 'previous.zip'));
          await fs.writeFile(path, bytes);
        }
        return result;
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(readBundle(root, path), error => error.code === 'file_rejected');
  assert.ok(replaced);
});

for (const field of ['dev', 'ino']) {
  test(`reopened handle with a different ${field} is rejected even if path metadata is unchanged`, async t => {
    const { root, path } = await fixture(t);
    const original = fs.open;
    let opens = 0;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await original(...args);
      if (args[0] === path && ++opens === 2) {
        const stat = handle.stat.bind(handle);
        handle.stat = async (...statArgs) => {
          const info = await stat(...statArgs);
          info[field] += 1024;
          return info;
        };
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(readBundle(root, path), error => error.code === 'file_rejected');
    assert.equal(opens, 2);
  });
}
