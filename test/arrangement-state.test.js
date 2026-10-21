import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import JSZip from "jszip";
import { initialState, prepareDeck, renderDeck, validateState } from "../src/deck.js";
import { Store } from "../src/store.js";
import { inventory } from "../src/files.js";
import { exportDeck } from "../src/export.js";

const input = prepareDeck('<html><head><title>Arrangement</title></head><body><main><section class="slide"><h1 style="top:13px;right:7px">Original</h1></section><section class="slide"><p>Second</p></section></main></body></html>');
const snapshot = (overrides = {}) => ({
  id: "a-copy", slide: "s0", kind: "html",
  html: '<div style="color:#123456;padding:8px"><strong>Snapshot</strong><span> body</span></div>',
  x: 124, y: 224, w: 320, h: 160, rotate: 15, ...overrides,
});
const parsed = (state) => parseHTML(renderDeck(input.html, validateState(state, input))).document;

test("arrangement fields retain boolean locks and bounded integer stacking order", () => {
  const state = initialState(input);
  state.patches.e0 = { locked: true, z: -100000, layerPosition: "relative" };
  state.patches.e1 = { locked: false, z: 100000 };
  const normalized = validateState(state, input);
  assert.deepEqual(normalized.patches, state.patches);
  assert.deepEqual(validateState(normalized, input), normalized);
  for (const patch of [{ locked: 1 }, { locked: "false" }, { z: -100001 }, { z: 100001 }, { z: 1.5 }, { z: "2" }, { layerPosition: "absolute" }, { layerPosition: null }]) {
    assert.throws(() => validateState({ ...state, patches: { e0: patch } }, input), undefined, JSON.stringify(patch));
  }
});

test("stacking promotion keeps document flow and neutralizes formerly inactive offsets", () => {
  const state = initialState(input);
  state.patches.e0 = { z: 5, layerPosition: "relative", locked: true };
  const element = parsed(state).querySelector('[data-sd-id="e0"]');
  assert.equal(element.style.position, "relative");
  assert.equal(element.style.zIndex, "5");
  for (const property of ["inset", "left", "top", "right", "bottom"])
    assert.equal(element.style[property], "auto", property);
  assert.equal(element.textContent, "Original");
});

test("HTML snapshots retain their root styling on one editable element with effective geometry", () => {
  const state = initialState(input);
  state.added.push(snapshot());
  state.patches["a-copy"] = { y: 280, w: 360, rotate: -20, z: 7, locked: true };
  const element = parsed(state).querySelector('[data-sd-id="a-copy"]');
  assert.equal(element.querySelector("strong").textContent, "Snapshot");
  assert.equal(element.style.padding, "8px");
  assert.equal(element.querySelectorAll("[data-sd-id],[id]").length, 0);
  assert.equal(element.style.position, "absolute");
  assert.equal(element.style.left, "0px");
  assert.equal(element.style.top, "0px");
  assert.equal(element.style.margin, "0px");
  assert.equal(element.style.boxSizing, "border-box");
  assert.equal(element.style.translate, "124px 280px");
  assert.equal(element.style.width, "360px");
  assert.equal(element.style.height, "160px");
  assert.equal(element.style.rotate, "-20deg");
  assert.equal(element.style.zIndex, "7");
});

test("snapshot patches and original edits remain independent across copies", () => {
  const state = initialState(input);
  state.added.push(snapshot(), snapshot({ id: "a-copy-two", slide: "s1", x: 148 }));
  state.patches.e0 = { text: "Changed original" };
  state.patches["a-copy"] = { text: "Changed first copy", x: 400, hidden: true };
  const document = parsed(state);
  assert.equal(document.querySelector('[data-sd-id="e0"]').textContent, "Changed original");
  assert.equal(document.querySelector('[data-sd-id="a-copy"]').textContent, "Changed first copy");
  const second = document.querySelector('[data-sd-id="a-copy-two"]');
  assert.equal(second.querySelector("strong").textContent, "Snapshot");
  assert.equal(second.style.translate, "148px 224px");
  assert.notEqual(second.style.display, "none");
  assert.equal(state.added[0].html, state.added[1].html);
});

test("snapshots reject nested identities, execution, unsafe CSS and remote assets", () => {
  for (const html of [
    '<span id="original">Text</span>', '<span ID="original">Text</span>',
    '<span data-sd-id="e0">Text</span>', '<span DATA-SD-ID="e0">Text</span>',
    '<script>alert(1)</script>', '<img src="photo.png" onerror="alert(1)">',
    '<img src="https://example.com/photo.png">', '<img src="../photo.png">',
    '<span style="background:url(https://example.com/photo.png)">Text</span>',
    '<span style="color:red;{position:fixed}">Text</span>', '<iframe></iframe>',
  ]) {
    const state = initialState(input);
    state.added.push(snapshot({ html }));
    assert.throws(() => validateState(state, input), undefined, html);
  }
});

test("HTML belongs only to snapshot records and cannot enter ordinary patches", () => {
  for (const added of [snapshot({ html: null }), snapshot({ html: 4 }), snapshot({ kind: "text" }), snapshot({ kind: "image" }), snapshot({ kind: "shape" })]) {
    assert.throws(() => validateState({ ...initialState(input), added: [added] }, input));
  }
  const missing = snapshot();
  delete missing.html;
  assert.throws(() => validateState({ ...initialState(input), added: [missing] }, input));
  assert.throws(() => validateState({ ...initialState(input), patches: { e0: { html: "<b>Replace</b>" } } }, input));
  assert.throws(() => validateState({ ...initialState(input), added: [snapshot()], patches: { "a-copy": { html: "<b>Replace</b>" } } }, input));
});

test("malformed or inherited added objects and patches are rejected before cloning", () => {
  const inheritedAdded = Object.assign(Object.create({ html: "<b>Inherited</b>" }), { id: "a-inherited", slide: "s0", kind: "text", text: "Text" });
  const inheritedPatch = Object.assign(Object.create({ hidden: true }), { text: "Text" });
  for (const added of [null, [], "text", inheritedAdded]) {
    assert.throws(() => validateState({ ...initialState(input), added: [added] }, input));
  }
  assert.throws(() => validateState({ ...initialState(input), patches: { e0: inheritedPatch } }, input));
  assert.throws(() => validateState({ ...initialState(input), patches: Object.create({ e0: { text: "Inherited" } }) }, input));
});

test("legacy version-one decks render without arrangement defaults or forced positioning", () => {
  const legacy = { order: ["s0", "s1"], patches: { e0: { text: "Legacy" } }, added: [{ id: "a-old", slide: "s0", kind: "text", text: "Added", x: 20, y: 30 }], background: true };
  const state = validateState(legacy, input);
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.patches.e0, { text: "Legacy" });
  const document = parseHTML(renderDeck(input.html, state)).document;
  assert.equal(document.querySelector('[data-sd-id="e0"]').textContent, "Legacy");
  assert.equal(document.querySelector('[data-sd-id="e0"]').style.position, undefined);
  assert.equal(document.querySelector('[data-sd-id="a-old"]').style.translate, "20px 30px");
});

test("snapshot assets validate atomically, survive revisions and protect exported copies", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "studio-arrangement-assets-")));
  await store.init();
  const deck = await store.create({ ...input, files: new Map([["index.html", Buffer.from(input.html)]]) });
  const state = deck.state;
  state.added.push(snapshot({ html: '<div style="background-image:url(texture.png)"><img src="photo.png"></div>' }));
  state.patches.e0 = { z: 6, layerPosition: "relative", locked: true };
  await assert.rejects(store.save(deck.id, 1, state), /파일이 없습니다/);
  assert.equal((await store.get(deck.id)).revision, 1);
  await writeFile(store.path(deck.id, "assets/photo.png"), "photo fixture");
  await assert.rejects(store.save(deck.id, 1, state), /texture\.png/);
  assert.equal((await store.get(deck.id)).revision, 1);
  await writeFile(store.path(deck.id, "assets/texture.png"), "texture fixture");
  const meta = await store.meta(deck.id);
  await store.atomic(store.path(deck.id, "meta.json"), { ...meta, uploadedFiles: ["photo.png", "texture.png"] });
  const saved = await store.save(deck.id, 1, state);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.state.patches.e0, { z: 6, layerPosition: "relative", locked: true });
  const copy = await store.duplicate(deck.id);
  assert.deepEqual(copy.state, saved.state);
  const next = structuredClone(saved.state);
  next.added = [];
  await store.save(deck.id, 2, next);
  for (const file of (await inventory(store, deck.id)).files.filter((file) => ["photo.png", "texture.png"].includes(file.path))) {
    assert.equal(file.canDelete, false, file.path);
    assert.match(file.reason, /버전/);
  }
  const output = await exportDeck({ store, deck: await store.get(deck.id, 2), format: "html" });
  const zip = await JSZip.loadAsync(output.buffer);
  const document = parseHTML(await zip.file("index.html").async("string")).document;
  assert.ok(document.querySelector('[data-sd-id="a-copy"] img[src="photo.png"]'));
  assert.equal(document.querySelector('[data-sd-id="e0"]').style.zIndex, "6");
  assert.ok(zip.file("photo.png"));
  assert.ok(zip.file("texture.png"));
});

test("snapshot asset checks cannot be bypassed with mixed-case HTML attributes", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "studio-arrangement-case-")));
  await store.init();
  const deck = await store.create({ ...input, files: new Map([["index.html", Buffer.from(input.html)]]) });
  for (const html of ['<img SRC="missing.png">', '<div STYLE="background:url(missing.png)">Text</div>']) {
    await assert.rejects(store.save(deck.id, 1, { ...deck.state, added: [snapshot({ html })] }), /파일이 없습니다/, html);
    assert.equal((await store.get(deck.id)).revision, 1);
  }
});
