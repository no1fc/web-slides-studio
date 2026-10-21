import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { initialState, prepareDeck, renderDeck, validateState } from "../src/deck.js";
import { Store } from "../src/store.js";
import { startStudio } from "../src/server.js";
import { authoringSource } from "../src/authoring.js";
import { exportDeck } from "../src/export.js";
import { inventory } from "../src/files.js";
import JSZip from "jszip";

const input = prepareDeck('<html><head><title>Authoring</title></head><body><main id="stage"><section class="slide"><h1>Original</h1></section><section class="slide"><p>Second</p></section></main></body></html>');
const create = (store) => store.create({ ...input, files: new Map([["index.html", Buffer.from(input.html)]]) });

test("legacy migration is explicit and unknown/future state is rejected", () => {
  const legacy = { order: ["s0", "s1"], patches: {}, added: [], background: true };
  const next = validateState(legacy, input);
  assert.equal(next.schemaVersion, 1);
  assert.deepEqual(next.slideCode, {});
  assert.deepEqual(next.masters, {});
  assert.deepEqual(next.slideMasters, {});
  assert.equal(legacy.schemaVersion, undefined);
  assert.throws(() => validateState({ ...next, schemaVersion: 2 }, input), /버전/);
  assert.throws(() => validateState({ ...next, themeTypo: {} }, input), /항목/);
  assert.throws(() => validateState({ ...next, clones: [] }, input));
  assert.throws(() => validateState({ ...next, masters: [] }, input));
});

test("partial patch retains added geometry and can unhide an element", () => {
  const state = initialState(input);
  state.added.push({ id: "a-example", slide: "s0", kind: "text", text: "Added", x: 150, y: 160, hidden: true });
  state.patches["a-example"] = { y: 220, hidden: false };
  const { document } = parseHTML(renderDeck(input.html, validateState(state, input)));
  const element = document.querySelector('[data-sd-id="a-example"]');
  assert.equal(element.style.translate, "150px 220px");
  assert.notEqual(element.style.display, "none");
});

test("HTML and master normalize stable editable IDs and render shared changes", () => {
  const state = initialState(input);
  state.slideCode = { s0: { html: '<h1 data-sd-id="e0">Changed</h1><p>New</p>', css: "h1 { color: red }" } };
  state.masters = { "m-brand": { name: "Brand", html: '<div class="brand">Shared</div>', css: ".brand { color: blue }" } };
  state.slideMasters = { s0: "m-brand", s1: "m-brand" };
  const normalized = validateState(state, input);
  assert.match(normalized.slideCode.s0.html, /data-sd-id="c-s0--e0"/);
  assert.deepEqual(validateState(normalized, input), normalized);
  normalized.patches["c-s0--e0"] = { text: "Edited new" };
  const { document } = parseHTML(renderDeck(input.html, validateState(normalized, input)));
  assert.equal(document.querySelector('[data-sd-id="e0"]').textContent, "Changed");
  assert.equal(document.querySelector('[data-sd-id="c-s0--e0"]').textContent, "Edited new");
  assert.equal(document.querySelectorAll('[data-sd-master="m-brand"]').length, 2);
  assert.equal(document.querySelectorAll('[data-sd-master] [data-sd-id]').length, 0);
  assert.match(document.toString(), /@scope/);
  normalized.masters["m-brand"].html = '<div class="brand">Updated</div>';
  assert.equal(parseHTML(renderDeck(input.html, normalized)).document.querySelectorAll(".brand")[1].textContent, "Updated");
});

test("new source rejects execution, reserved markup and cross-slide IDs", () => {
  const state = initialState(input);
  for (const html of ['<script>alert(1)</script>', '<img src="assets/a.png" onerror="alert(1)">', '<iframe></iframe>', '<div id="sd-config">x</div>', '<div data-sd-slide="s1">x</div>', '<h1 data-sd-id="e1">foreign</h1>', '<div class="slide">x</div>', '<img src="../outside.png">']) {
    assert.throws(() => validateState({ ...state, slideCode: { s0: { html, css: "" } } }, input), undefined, html);
  }
  for (const css of ['</style><script>alert(1)</script>', '@import "https://example.com/a.css";', 'p{background:url(https://example.com/a.png)}']) {
    assert.throws(() => validateState({ ...state, slideCode: { s0: { html: "<p>safe</p>", css } } }, input), undefined, css);
  }
  assert.throws(() => validateState({ ...state, slideMasters: { s0: "m-missing" } }, input));
});

test("revision read migration and authoring snapshots preserve source and history", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "studio-authoring-")));
  await store.init();
  const deck = await create(store);
  const file = store.path(deck.id, "revisions/1.json");
  const old = JSON.parse(await readFile(file, "utf8"));
  for (const key of ["schemaVersion", "slideCode", "masters", "slideMasters"]) delete old.state[key];
  await writeFile(file, JSON.stringify(old));
  const before = await readFile(file, "utf8");
  const legacy = await store.get(deck.id);
  assert.equal(legacy.state.schemaVersion, 1);
  assert.equal(await readFile(file, "utf8"), before);
  legacy.state.slideCode.s0 = { html: "<h1>New source</h1>", css: "h1{color:red}" };
  legacy.state.masters["m-brand"] = { name: "Brand", html: "<p>Master</p>", css: "" };
  legacy.state.slideMasters.s0 = "m-brand";
  const saved = await store.save(deck.id, 1, legacy.state);
  assert.equal(saved.revision, 2);
  assert.match(saved.state.slideCode.s0.html, /New source/);
  const copy = await store.duplicate(deck.id);
  assert.deepEqual(copy.state, saved.state);
  await store.save(deck.id, 2, (await store.get(deck.id, 1)).state);
  assert.deepEqual((await store.get(deck.id)).state.slideCode, {});
  assert.match((await store.get(deck.id, 2)).state.slideCode.s0.html, /New source/);
  assert.equal(await readFile(store.path(deck.id, "assets/index.html"), "utf8"), input.html);
});

test("authoring endpoints validate without saving and preserve revision isolation", async () => {
  const app = await startStudio({ port: 0, contentPort: 0, root: await mkdtemp(join(tmpdir(), "studio-authoring-api-")) });
  try {
    const deck = await create(app.store);
    const base = app.origin + "/api/decks/" + deck.id;
    const source = await (await fetch(base + "/authoring?slide=s0")).json();
    assert.equal(source.slide, "s0");
    assert.match(source.html, /Original/);
    assert.equal(source.css, "");
    const state = deck.state;
    state.slideCode.s0 = { html: "<p>Preview</p>", css: "p{color:red}" };
    const response = await fetch(base + "/validate", { method: "POST", headers: { "Content-Type": "application/json", Origin: app.origin }, body: JSON.stringify({ state }) });
    assert.equal(response.status, 200);
    assert.match((await response.json()).state.slideCode.s0.html, /data-sd-id/);
    assert.equal((await app.store.get(deck.id)).revision, 1);
    assert.deepEqual((await app.store.get(deck.id)).state.slideCode, {});
    assert.equal((await fetch(base + "/authoring?slide=missing")).status, 400);
    assert.equal((await fetch(base + "/validate", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid" }, body: JSON.stringify({ state }) })).status, 403);
  } finally { await app.close(); }
});

test("blank and copied slide sources keep IDs local to their owning slide", () => {
  const state = initialState(input);
  state.clones = { "s-blank": null, "s-copy": "s0" };
  state.order.push("s-blank", "s-copy");
  assert.deepEqual(authoringSource(input.html, state, "s-blank"), { slide: "s-blank", html: "", css: "" });
  const copied = authoringSource(input.html, state, "s-copy");
  assert.match(copied.html, /data-sd-id="s-copy--e0"/);
  state.slideCode["s-copy"] = { html: copied.html + "<p>New clone element</p>", css: "" };
  const normalized = validateState(state, input);
  assert.match(normalized.slideCode["s-copy"].html, /c-s-copy--e0/);
  normalized.patches["c-s-copy--e0"] = { text: "Clone edit" };
  const { document } = parseHTML(renderDeck(input.html, validateState(normalized, input)));
  assert.equal(document.querySelector('[data-sd-id="e0"]').textContent, "Original");
  assert.equal(document.querySelector('[data-sd-id="c-s-copy--e0"]').textContent, "Clone edit");
});

test("authoring assets must exist, stay revision-protected and export with code/master", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "studio-authoring-assets-")));
  await store.init();
  const deck = await create(store);
  const state = deck.state;
  state.slideCode.s0 = { html: '<h1>Export source</h1><img src="image.png">', css: "h1{color:blue}" };
  state.masters["m-brand"] = { name: "Brand", html: "<p>Master export</p>", css: ':scope{background-image:url("image.png")}' };
  state.slideMasters.s0 = "m-brand";
  await assert.rejects(store.save(deck.id, 1, state), /파일이 없습니다/);
  assert.equal((await store.get(deck.id)).revision, 1);
  await writeFile(store.path(deck.id, "assets/image.png"), "image fixture");
  const meta = await store.meta(deck.id);
  await store.atomic(store.path(deck.id, "meta.json"), { ...meta, uploadedFiles: ["image.png"] });
  const saved = await store.save(deck.id, 1, state);
  const image = (await inventory(store, deck.id)).files.find((file) => file.path === "image.png");
  assert.equal(image.canDelete, false);
  const output = await exportDeck({ store, deck: saved, format: "html" });
  const zip = await JSZip.loadAsync(output.buffer);
  const html = await zip.file("index.html").async("string");
  assert.match(html, /Export source/);
  assert.match(html, /Master export/);
  assert.ok(zip.file("image.png"));
});

test("CSS scope cannot be closed by unbalanced fragments or escaped tokens", () => {
  const state = initialState(input);
  for (const css of ["}body{display:none}{", "/* unfinished", 'p{color:"red}', "p{color:red", "p{background:u\\72l(https://outside.invalid/x)}"]) {
    assert.throws(() => validateState({ ...state, slideCode: { s0: { html: "<p>Safe</p>", css } } }, input), undefined, css);
  }
});

test("code CSS accepts child combinators used by two-column templates", () => {
  const state = initialState(input);
  state.slideCode.s0 = { html: '<div class="columns"><div>Left</div><div>Right</div></div>', css: ".columns>div { padding: 12px; }" };
  assert.equal(validateState(state, input).slideCode.s0.css, state.slideCode.s0.css);
});
