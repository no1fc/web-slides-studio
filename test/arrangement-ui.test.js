import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
import { importArchive } from "../src/archive.js";

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "studio-arrangement-ui-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const zip = new JSZip();
    zip.file("index.html", '<html><head><title>Arrangement</title><style>html,body{margin:0}main{position:relative;width:1920px;height:1080px}.slide{position:absolute;inset:0;display:none}.slide.active{display:block}h1{position:absolute;left:100px;top:100px;width:300px;height:100px}p{position:absolute;left:500px;top:300px;width:300px;height:100px}</style></head><body><main id="stage"><section class="slide"><h1>제목</h1><p>본문</p></section><section class="slide"><h1>다음</h1></section></main></body></html>');
    const deck = await app.store.create(await importArchive(await zip.generateAsync({ type: "nodebuffer" })));
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(5000);
    await page.goto(app.origin + "/#deck=" + deck.id);
    await page.frameLocator("#deckFrame").locator('[data-sd-slide="s0"].active').waitFor();
    await page.waitForTimeout(100);
    const send = async data => {
      const frame = await (await page.$("#deckFrame")).contentFrame();
      await frame.evaluate(data => parent.postMessage({ studio: true, editorSession: new URLSearchParams(location.search).get("editorSession"), ...data }, "*"), data);
      await page.waitForTimeout(40);
    };
    const save = () => page.waitForResponse(r => r.url().endsWith("/save") && r.request().method() === "POST");
    await fn({ app, deck, page, send, save });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}
const info = id => ({ id, tag: "h1", text: id, x: 0, y: 0, w: 300, h: 100, rotate: 0, color: "#ffffff", fill: "#000000", fontSize: 40 });
const snapshot = text => ({ kind: "text", text, x: 100, y: 120, w: 300, h: 100, fontSize: 40 });

test("parent batches selected objects into one undo transaction", () => fixture(async ({ app, deck, page, send, save }) => {
  await send({ type: "select", slide: "s0", element: null, elements: [info("e0"), info("e1")] });
  assert.equal(await page.locator("#properties").isHidden(), true);
  const saved = save();
  await send({ type: "batch-change", slide: "s0", changes: [{ id: "e0", patch: { x: 45 } }, { id: "e1", patch: { x: 85 } }] });
  await saved;
  let state = (await app.store.get(deck.id)).state;
  assert.equal(state.patches.e0.x, 45); assert.equal(state.patches.e1.x, 85);
  assert.match(await page.locator("#selectionCount").textContent(), /2/);
  assert.equal(await page.locator("#alignLeftBtn").isEnabled(), true);
  assert.equal(await page.locator("#distributeXBtn").isEnabled(), false);
  const undone = save(); await page.locator("#undoBtn").click(); await undone;
  state = (await app.store.get(deck.id)).state;
  assert.equal(state.patches.e0, undefined); assert.equal(state.patches.e1, undefined);
}));

test("parent duplicates all snapshots independently and pastes across slides within the same deck", () => fixture(async ({ app, deck, page, send, save }) => {
  const objects = [snapshot("사본 하나"), snapshot("사본 둘")];
  let saved = save();
  await send({ type: "objects", operation: "duplicate", slide: "s0", objects }); await saved;
  let state = (await app.store.get(deck.id)).state;
  assert.equal(state.added.length, 2);
  assert.equal(new Set(state.added.map(a => a.id)).size, 2);
  assert.ok(state.added.every(a => a.id.startsWith("a-") && a.x === 124 && a.y === 144 && a.slide === "s0"));
  await page.frameLocator("#deckFrame").locator('[data-sd-slide="s0"].active').waitFor();
  await send({ type: "objects", operation: "copy", slide: "s0", objects });
  await page.waitForFunction(() => !document.querySelector("#pasteObjectsBtn").disabled);
  await page.locator("#slideList .slide-item").nth(1).click();
  await page.frameLocator("#deckFrame").locator('[data-sd-slide="s1"].active').waitFor();
  saved = save(); await page.locator("#pasteObjectsBtn").click(); await saved;
  state = (await app.store.get(deck.id)).state;
  assert.equal(state.added.length, 4);
  assert.equal(state.added.filter(a => a.slide === "s1").length, 2);
  assert.equal(new Set(state.added.map(a => a.id)).size, 4);
  await page.locator("#libraryBtn").click(); await page.locator("#newBtn").click();
  await page.frameLocator("#deckFrame").locator('[data-sd-slide="s0"].active').waitFor();
  assert.equal(await page.locator("#pasteObjectsBtn").isEnabled(), false);
}));

test("invalid and stale object groups never partially mutate state or undo history", () => fixture(async ({ app, deck, page, send }) => {
  await send({ type: "objects", operation: "duplicate", slide: "s0", objects: [snapshot("유효"), { ...snapshot("범위 초과"), x: 6000 }] });
  await page.waitForFunction(() => !document.querySelector("#toast").hidden);
  let saved = await app.store.get(deck.id);
  assert.equal(saved.state.added.length, 0); assert.equal(saved.revision, deck.revision);
  await page.locator("#undoBtn").click();
  await page.locator("#slideList .slide-item").nth(1).click();
  await page.frameLocator("#deckFrame").locator('[data-sd-slide="s1"].active').waitFor();
  await send({ type: "objects", operation: "duplicate", slide: "s0", objects: [snapshot("오래된 슬라이드")] });
  await send({ type: "batch-change", slide: "s0", changes: [{ id: "e0", patch: { x: 333 } }] });
  await page.waitForTimeout(750);
  saved = await app.store.get(deck.id);
  assert.equal(saved.state.added.length, 0); assert.equal(saved.state.patches.e0, undefined); assert.equal(saved.revision, deck.revision);
}));

test("locked selection disables the inspector and rejects a synthetic inspector edit", () => fixture(async ({ app, deck, page, send }) => {
  const locked = { ...info("e0"), locked: true };
  await send({ type: "layers", slide: "s0", items: [{ id: "e0", tag: "h1", label: "제목", locked: true, hidden: false, z: 0, group: "g0", layerable: true, selected: true }] });
  await send({ type: "select", slide: "s0", element: locked, elements: [locked] });
  assert.equal(await page.locator("#xValue").isDisabled(), true);
  await page.locator("#xValue").evaluate(e => { e.value = "999"; e.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(750);
  assert.equal((await app.store.get(deck.id)).state.patches.e0, undefined);
  assert.equal(await page.locator('#layerList [data-layer-id="e0"] [data-layer-action="locked"]').getAttribute("aria-pressed"), "true");
}));

test("a validation response from the previous slide cannot apply a duplicate group", () => fixture(async ({ app, deck, page, send }) => {
  let release, validated;
  const waiting = new Promise(resolve => { validated = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/validate", async route => {
    const response = await route.fetch();
    validated(); await gate; await route.fulfill({ response });
  });
  await send({ type: "objects", operation: "duplicate", slide: "s0", objects: [snapshot("지연된 사본")] });
  await waiting;
  await send({ type: "navigate", index: 1 });
  release();
  await page.waitForTimeout(750);
  const saved = await app.store.get(deck.id);
  assert.equal(saved.state.added.length, 0); assert.equal(saved.revision, deck.revision);
}));

test("batch validation failure rejects the whole change without an undo entry", () => fixture(async ({ app, deck, page, send }) => {
  await send({ type: "batch-change", slide: "s0", changes: [{ id: "e0", patch: { x: 45 } }, { id: "e1", patch: { x: 6000 } }] });
  await page.waitForFunction(() => !document.querySelector("#toast").hidden);
  await page.frameLocator("#deckFrame").locator('[data-sd-slide="s0"].active').waitFor();
  await page.locator("#undoBtn").click();
  await page.waitForTimeout(750);
  const saved = await app.store.get(deck.id);
  assert.equal(saved.state.patches.e0, undefined); assert.equal(saved.state.patches.e1, undefined); assert.equal(saved.revision, deck.revision);
}));

test("selecting through the layer panel hands keyboard movement to the frame", () => fixture(async ({ app, deck, page, save }) => {
  await page.locator('#layerList [data-layer-id="e0"] [data-layer-action="select"]').click();
  await page.waitForFunction(() => document.querySelector("#selectionCount").textContent === "1개 선택");
  const saved = save();
  await page.keyboard.press("ArrowRight"); await saved;
  assert.equal((await app.store.get(deck.id)).state.patches.e0.x, 1);
}));

test("failed batch validation restores the latest single-object edit to the frame", () => fixture(async ({ app, deck, page, save }) => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  await page.route("**/validate", async route => {
    const response = await route.fetch();
    started(); await gate; await route.fulfill({ response });
  });
  const frame = page.frameLocator("#deckFrame");
  await frame.locator('[data-sd-id="e0"]').click();
  await frame.locator('[data-sd-id="e1"]').click({ modifiers: ["Shift"] });
  await page.keyboard.press("ArrowRight");
  await pending;
  const oldSource = await page.locator("#deckFrame").getAttribute("src");
  const saved = save();
  try {
    await frame.locator('[data-sd-id="e1"]').click({ modifiers: ["Shift"] });
    await page.keyboard.press("ArrowRight");
  } finally { release(); }
  await saved;
  await page.waitForFunction(source => document.querySelector("#deckFrame").src !== source, oldSource);
  const content = await (await page.$("#deckFrame")).contentFrame();
  await content.waitForFunction(() => {
    const element = document.querySelector('[data-sd-id="e0"]');
    return element && parseFloat(element.style.translate) === 2;
  });
  const state = (await app.store.get(deck.id)).state;
  assert.equal(state.patches.e0.x, 2);
  assert.equal(state.patches.e1, undefined);
  assert.equal(await frame.locator('[data-sd-id="e1"]').evaluate(element => element.style.translate), "");
}));
