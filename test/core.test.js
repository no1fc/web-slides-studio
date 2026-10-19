import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importArchive, safePath } from "../src/archive.js";
import { prepareDeck, renderDeck, validateState } from "../src/deck.js";
import { Store } from "../src/store.js";
const html =
  '<html><head><title>테스트</title></head><body><main><section class="slide"><h1>원래 제목</h1><img src="assets/a.png"></section><section class="slide"><p>두 번째</p></section></main></body></html>';
test("reject traversal and platform-specific paths", () => {
  for (const p of [
    "../a",
    "a/../../b",
    "C:/a",
    "a\\b",
    "/etc/passwd",
    ".env",
    "a//b",
  ])
    assert.throws(() => safePath(p));
  assert.equal(safePath("assets/한글.png"), "assets/한글.png");
});
test("import common root and validate assets", async () => {
  const z = new JSZip();
  z.file("deck/index.html", html);
  z.file("deck/assets/a.png", Buffer.from("png"));
  const d = await importArchive(await z.generateAsync({ type: "nodebuffer" }));
  assert.equal(d.title, "테스트");
  assert.equal(d.slides.length, 2);
  assert.ok(d.files.has("assets/a.png"));
});
test("missing local assets reported", async () => {
  const z = new JSZip();
  z.file("index.html", html);
  await assert.rejects(
    importArchive(await z.generateAsync({ type: "nodebuffer" })),
    /누락/,
  );
});
test("patch prevents markup and external images", () => {
  const d = prepareDeck(html);
  const id = d.elements.find((e) => e.tag === "h1").id;
  const state = {
    order: d.slides.map((s) => s.id),
    patches: { [id]: { text: "<script>bad()</script>", x: 32, y: 20 } },
    added: [],
    background: true,
  };
  const out = renderDeck(d.html, validateState(state, d));
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /translate:32px 20px/);
  assert.throws(() =>
    validateState(
      { ...state, patches: { [id]: { src: "https://evil.invalid/x" } } },
      d,
    ),
  );
  assert.throws(() =>
    validateState(
      { ...state, patches: { [id]: { css: "position:fixed" } } },
      d,
    ),
  );
});
test("immutable revisions, stale writes and published snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-store-"));
  const store = new Store(dir);
  await store.init();
  const d = prepareDeck(html);
  const deck = await store.create({
    ...d,
    files: new Map([["index.html", Buffer.from(d.html)]]),
  });
  const original = await store.get(deck.id);
  const state = {
    ...original.state,
    patches: { [d.elements[0].id]: { text: "수정 제목" } },
  };
  const saved = await store.save(deck.id, 1, state);
  assert.equal(saved.revision, 2);
  await assert.rejects(store.save(deck.id, 1, state), /다른/);
  await store.publish(deck.id);
  await store.save(deck.id, 2, { ...state, background: false });
  assert.equal((await store.get(deck.id)).publishedRevision, 2);
  assert.equal((await store.get(deck.id, 1)).state.background, true);
});
test("reject duplicate raw ZIP paths before JSZip normalizes them", async () => {
  const z = new JSZip();
  z.file("index.html", html);
  z.file("other.html", html);
  z.file("assets/a.png", "png");
  let b = await z.generateAsync({ type: "nodebuffer", compression: "STORE" });
  b = Buffer.from(
    b.toString("latin1").replaceAll("other.html", "index.html"),
    "latin1",
  );
  await assert.rejects(importArchive(b), /중복/);
});
test("duplicate waits for the source write lock", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "studio-copy-")));
  await store.init();
  const d = prepareDeck(html);
  const original = await store.create({
    ...d,
    files: new Map([["index.html", Buffer.from(d.html)]]),
  });
  let release;
  const gate = new Promise((r) => (release = r));
  const hold = store.locked(original.id, () => gate);
  let finished = false;
  const copy = store.duplicate(original.id).then((d) => {
    finished = true;
    return d;
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(finished, false);
  } finally {
    release();
    await hold;
    await copy;
  }
});
