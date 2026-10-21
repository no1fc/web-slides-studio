import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
import { importArchive } from "../src/archive.js";

async function fixture(fn, objects) {
  const root = await mkdtemp(join(tmpdir(), "studio-object-browser-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const zip = new JSZip();
    zip.file("index.html", `<!doctype html><html><head><title>Object fixture</title><style>html,body{margin:0}#stage{width:1920px;height:1080px;position:relative;transform-origin:0 0}.slide{position:absolute;inset:0;display:none}.slide.active{display:block}h1{position:absolute;left:40px;top:30px;width:500px;height:70px;font-size:40px;margin:0}img.original{position:absolute;left:1450px;top:40px;width:240px;height:120px;rotate:20deg}</style></head><body><main id="stage"><section class="slide"><h1>Original heading</h1><img class="original" src="assets/pixel.png"></section></main></body></html>`);
    zip.file("assets/pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1kAAAAASUVORK5CYII=", "base64"));
    let deck = await app.store.create(await importArchive(await zip.generateAsync({ type: "nodebuffer" })));
    deck.state.added.push(...(objects || [
      { id: "a-text", kind: "text", text: "Group me", x: 120, y: 230, w: 300, h: 100, fontSize: 40, color: "#123456" },
      { id: "a-shape", kind: "shape", x: 480, y: 280, w: 240, h: 150, fill: "#008877" },
    ]).map(item => ({ ...item, slide: "s0" })));
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
    page.setDefaultTimeout(6000);
    await page.goto(app.origin + "/#deck=" + deck.id);
    const frame = page.frameLocator("#deckFrame");
    await frame.locator('[data-sd-id="a-text"], [data-sd-id="a-group"]').first().waitFor();
    await page.evaluate(() => { window.objectMessages = []; window.addEventListener("message", e => { if (e.data?.studio) window.objectMessages.push(e.data); }); });
    await fn({ app, deck, page, frame });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}
const item = (frame, id) => frame.locator(`[data-sd-id="${id}"]`);
const send = (page, type, data = {}) => page.evaluate(({ type, data }) => { const f = document.querySelector("#deckFrame"); f.contentWindow.postMessage({ studio: true, type, ...data }, new URL(f.src).origin); }, { type, data });
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.2, `${a} should match ${b}`);
async function message(page, type) {
  await page.waitForFunction(type => window.objectMessages.some(m => m.type === type), type);
  return page.evaluate(type => window.objectMessages.findLast(m => m.type === type), type);
}

test("bridge groups native added objects in one structure command and preserves native duplicates", () => fixture(async ({ page, frame }) => {
  await send(page, "select-ids", { ids: ["a-shape", "a-text"] });
  await send(page, "command", { name: "copy" });
  const copied = await message(page, "objects");
  assert.deepEqual(copied.objects.map(o => o.kind), ["text", "shape"]);
  assert.equal(copied.objects[0].text, "Group me");
  await send(page, "command", { name: "group" });
  const grouped = await message(page, "object-structure");
  assert.equal(grouped.operation, "group");
  assert.deepEqual(new Set(grouped.removeIds), new Set(["a-text", "a-shape"]));
  assert.equal(grouped.objects.length, 1);
  const group = grouped.objects[0];
  assert.equal(group.kind, "group");
  assert.deepEqual(group.group.children.map(o => o.kind), ["text", "shape"]);
  assert.equal(group.group.children.some(o => o.id || o.slide), false);
  near(group.x, 120); near(group.y, 230); near(group.w, 600); near(group.h, 200);
}));

test("original local image duplicate retains the source and unrotated dimensions", () => fixture(async ({ page, frame }) => {
  const id = await frame.locator("img.original").getAttribute("data-sd-id");
  await send(page, "select-ids", { ids: [id] });
  await send(page, "command", { name: "copy" });
  const copied = (await message(page, "objects")).objects[0];
  assert.equal(copied.kind, "image");
  assert.equal(copied.src, "assets/pixel.png");
  near(copied.x, 1450); near(copied.y, 40); near(copied.w, 240); near(copied.h, 120); near(copied.rotate, 20);
  assert.equal(copied.image.mode, "stretch");
  await send(page, "select-ids", { ids: [id, "a-text"] });
  await send(page, "command", { name: "group" });
  assert.match((await message(page, "notice")).message, /추가|그룹|복제/);
  assert.equal(await page.evaluate(() => window.objectMessages.some(m => m.type === "object-structure")), false);
}));

test("image crop and Fit update the original source frame and export preserves native metadata", () => fixture(async ({ page, frame }) => {
  const image = item(frame, "a-image");
  await image.locator("img").evaluate(img => img.decode());
  await send(page, "select-ids", { ids: ["a-image"] });
  await page.waitForFunction(() => window.objectMessages.some(m => m.type === "select" && m.element?.id === "a-image"));
  const selected = await message(page, "select");
  assert.equal(selected.element.tag, "img");
  assert.equal(selected.element.kind, "image");
  assert.equal(selected.element.textEditable, false);
  await send(page, "patch", { id: "a-image", patch: { image: { mode: "fit", crop: { left: .25, right: 0, top: 0, bottom: 0 } } } });
  await frame.locator('[data-sd-id="a-image"][data-sd-image*="fit"]').waitFor();
  const view = await image.evaluate(e => ({ src: e.querySelector("img").getAttribute("src"), window: e.querySelector("[data-sd-image-window]").style.cssText, child: e.querySelector("img").style.cssText }));
  assert.equal(view.src, "assets/pixel.png");
  assert.match(view.window, /left: 93.75px/);
  assert.match(view.window, /width: 112.5px/);
  assert.match(view.child, /left: -37.5px/);
  const exported = await image.evaluate(() => window.__sd.collect().find(o => o.id === "a-image"));
  assert.equal(exported.nativeObject, true); assert.equal(exported.nativeSupported, true);
  assert.equal(exported.image.crop.left, .25); assert.equal(exported.image.mode, "fit");
  assert.equal(exported.naturalWidth, 1); assert.equal(exported.naturalHeight, 1);
  assert.equal(exported.fill, "#112233");
  near(exported.w, 300); near(exported.h, 150); near(exported.rotate, 25);
  await send(page, "patch", { id: "a-image", patch: { image: { mode: "stretch", crop: { left: 0, right: 0, top: 0, bottom: 0 } } } });
  await frame.locator('[data-sd-id="a-image"][data-sd-image*="stretch"]').waitFor();
  near(await image.locator("img").evaluate(e => parseFloat(e.style.width)), 300);
}, [
  { id: "a-text", kind: "text", text: "Anchor", x: 100, y: 150, w: 200, h: 100 },
  { id: "a-image", kind: "image", src: "assets/pixel.png", x: 500, y: 250, w: 300, h: 150, rotate: 25, fill: "#112233" },
]));

test("group selection is atomic, scale stays uniform, cancellation restores child scale and export is native", () => fixture(async ({ page, frame }) => {
  await send(page, "select-ids", { ids: ["a-group"] });
  const selected = await message(page, "select");
  assert.equal(selected.element.kind, "group");
  assert.equal(selected.element.textEditable, false);
  assert.equal(await item(frame, "a-group").locator("[data-sd-id]").count(), 0);
  const right = await frame.locator('[data-sd-handle="e"]').boundingBox();
  const ss = await frame.locator(".slide.active").evaluate(e => e.getBoundingClientRect().width / 1920);
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2); await page.mouse.down();
  await page.mouse.move(right.x + right.width / 2 + 100 * ss, right.y + right.height / 2, { steps: 3 });
  let geometry = await item(frame, "a-group").evaluate(e => ({ w: parseFloat(e.style.width), h: parseFloat(e.style.height), scale: e.querySelector("[data-sd-group-content]").style.transform }));
  near(geometry.w / geometry.h, 2);
  assert.notEqual(geometry.scale, "scale(1)");
  await page.keyboard.press("Escape"); await page.mouse.up();
  geometry = await item(frame, "a-group").evaluate(e => ({ w: parseFloat(e.style.width), h: parseFloat(e.style.height), scale: e.querySelector("[data-sd-group-content]").style.transform }));
  near(geometry.w, 400); near(geometry.h, 200); assert.equal(geometry.scale, "scale(1)");
  const collected = await item(frame, "a-group").evaluate(() => window.__sd.collect());
  const group = collected.find(o => o.id === "a-group");
  assert.equal(group.kind, "group");
  assert.equal(group.children.length, 2);
  assert.deepEqual(group.children.map(o => o.kind), ["shape", "text"]);
  assert.equal(group.children[0].shape.type, "ellipse");
  near(group.children[0].rotate, 30);
  await item(frame, "a-group").evaluate(() => window.__sd.hideNative(["a-group"]));
  assert.equal(await item(frame, "a-group").evaluate(e => getComputedStyle(e).visibility), "hidden");
  await item(frame, "a-group").evaluate(() => window.__sd.showNative());
  await send(page, "select-ids", { ids: ["a-group"] });
  await send(page, "command", { name: "ungroup" });
  const ungrouped = await message(page, "object-structure");
  assert.equal(ungrouped.objects.length, 2);
  near(ungrouped.objects[0].rotate, 30);
}, [{ id: "a-group", kind: "group", x: 300, y: 250, w: 400, h: 200, rotate: 30, group: { width: 400, height: 200, children: [
  { kind: "shape", x: 0, y: 0, w: 120, h: 120, shape: { type: "ellipse", fill: "#44aa88", stroke: "#000000", strokeWidth: 2, dash: "solid" } },
  { kind: "text", x: 150, y: 40, w: 220, h: 130, text: "Child text", fontSize: 40, color: "#111111" },
] } }]));

test("parent toolbar grouping survives save reload scale rotate ungroup and undo without shifting children", () => fixture(async ({ app, deck, page, frame }) => {
  const commandAndSave = async action => {
    const response = page.waitForResponse(r => r.url().endsWith(`/api/decks/${deck.id}/save`) && r.request().method() === "POST");
    await action();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨"));
    return (await app.store.get(deck.id)).state;
  };
  const setNumber = async (id, value) => {
    await page.locator(id).fill(String(value));
    await page.locator(id).press("Tab");
  };
  const metrics = locator => locator.evaluate(e => {
    const slide = e.closest("[data-sd-slide]"), sr = slide.getBoundingClientRect(), scale = sr.width / 1920;
    const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: (r.x - sr.x) / scale, y: (r.y - sr.y) / scale, w: r.width / scale, h: r.height / scale }; };
    return { box: box(e), marker: box(e.querySelector("[data-sd-marker]")), run: box(e.querySelector("[data-sd-run]")) };
  });
  const sameMetrics = (before, after) => {
    for (const section of ["box", "marker", "run"]) {
      if (!before[section]) { assert.equal(after[section], null); continue; }
      for (const key of ["x", "y", "w", "h"])
        assert.ok(Math.abs(before[section][key] - after[section][key]) < 1, `${section}.${key}: ${before[section][key]} vs ${after[section][key]}`);
    }
  };
  const effectiveZ = (state, object) => state.patches[object.id]?.z ?? object.z ?? 20;

  await send(page, "select-ids", { ids: ["a-text"] });
  await page.waitForFunction(() => document.querySelector("#xValue").value === "150");
  let state = await commandAndSave(() => setNumber("#xValue", 140));
  assert.equal(state.patches["a-text"].x, 140);
  await send(page, "select-ids", { ids: ["a-text", "a-shape", "a-image"] });
  state = await commandAndSave(() => page.locator("#groupObjectsBtn").click());
  let group = state.added.find(o => o.kind === "group");
  assert.ok(group);
  await item(frame, group.id).waitFor();
  assert.equal(state.added.some(o => ["a-text", "a-shape", "a-image"].includes(o.id)), false);
  for (const id of ["a-text", "a-shape", "a-image"]) assert.equal(Object.hasOwn(state.patches, id), false);
  assert.ok(effectiveZ(state, state.added.find(o => o.id === "a-back")) < effectiveZ(state, group));
  assert.ok(effectiveZ(state, group) < effectiveZ(state, state.added.find(o => o.id === "a-front")));
  assert.equal(await page.locator("#lockAspect").isChecked(), true);
  assert.equal(await page.locator("#lockAspect").isDisabled(), true);
  const ratio = group.w / group.h;
  state = await commandAndSave(() => setNumber("#wValue", group.w * 1.5));
  near(state.patches[group.id].w / state.patches[group.id].h, ratio);
  state = await commandAndSave(() => setNumber("#rotateValue", 35));
  assert.equal(state.patches[group.id].rotate, 35);

  await page.reload(); await item(frame, group.id).waitFor();
  await item(frame, group.id).locator("img").evaluate(img => img.decode());
  const children = group.group.children;
  const before = {};
  for (const [index, child] of children.entries()) before[child.kind] = await metrics(item(frame, group.id).locator(":scope > [data-sd-group-content] > [data-sd-kind]").nth(index));
  await send(page, "select-ids", { ids: [group.id] });
  state = await commandAndSave(() => page.locator("#ungroupObjectsBtn").click());
  assert.equal(state.added.some(o => o.kind === "group"), false);
  assert.equal(Object.hasOwn(state.patches, group.id), false);
  let ungrouped = state.added.filter(o => !["a-back", "a-front"].includes(o.id));
  assert.equal(ungrouped.length, 3);
  for (const child of ungrouped) {
    await item(frame, child.id).waitFor();
    if (child.kind === "image") await item(frame, child.id).locator("img").evaluate(img => img.decode());
    sameMetrics(before[child.kind], await metrics(item(frame, child.id)));
    assert.ok(effectiveZ(state, state.added.find(o => o.id === "a-back")) < effectiveZ(state, child));
    assert.ok(effectiveZ(state, child) < effectiveZ(state, state.added.find(o => o.id === "a-front")));
  }
  const richText = ungrouped.find(o => o.kind === "text");
  near(richText.textMetricsScale, 1.5);
  near(richText.richText.paragraphs[0].runs[0].fontSize, 48);
  near(richText.richText.paragraphs[0].spaceAfter, 18);
  assert.equal(richText.richText.paragraphs[0].list, "bullet");
  assert.equal(richText.richText.paragraphs[0].indent, 2);
  const image = ungrouped.find(o => o.kind === "image");
  assert.equal(image.src, "assets/pixel.png"); assert.equal(image.image.crop.left, .2);

  state = await commandAndSave(() => page.locator("#undoBtn").click());
  assert.equal(state.added.filter(o => o.kind === "group").length, 1);
  await item(frame, group.id).waitFor();
  near(state.patches[group.id].rotate, 35);
  state = await commandAndSave(() => page.locator("#redoBtn").click());
  ungrouped = state.added.filter(o => !["a-back", "a-front"].includes(o.id));
  await page.reload(); await item(frame, ungrouped[0].id).waitFor();
  await send(page, "select-ids", { ids: ungrouped.map(o => o.id) });
  state = await commandAndSave(() => page.locator("#groupObjectsBtn").click());
  group = state.added.find(o => o.kind === "group");
  await item(frame, group.id).waitFor();
  state = await commandAndSave(() => page.locator("#ungroupObjectsBtn").click());
  ungrouped = state.added.filter(o => !["a-back", "a-front"].includes(o.id));
  for (const child of ungrouped) {
    await item(frame, child.id).waitFor();
    if (child.kind === "image") await item(frame, child.id).locator("img").evaluate(img => img.decode());
    sameMetrics(before[child.kind], await metrics(item(frame, child.id)));
  }
}, [
  { id: "a-back", kind: "shape", x: 100, y: 200, w: 800, h: 300, fill: "#eeeeee", z: 2 },
  { id: "a-text", kind: "text", text: "Nested bullet", x: 150, y: 250, w: 300, h: 140, fontSize: 32, z: 3,
    richText: { paragraphs: [{ runs: [{ text: "Nested bullet", fontFamily: "Arial", fontSize: 32, color: "#123456" }], list: "bullet", indent: 2, spaceAfter: 12, lineHeight: 1.2 }] }, textBox: { vertical: "top", overflow: "visible", autoFit: "none" } },
  { id: "a-shape", kind: "shape", x: 500, y: 280, w: 200, h: 140, z: 4, shape: { type: "ellipse", fill: "#009988", stroke: "#000000", strokeWidth: 4, dash: "solid" } },
  { id: "a-image", kind: "image", x: 750, y: 260, w: 100, h: 150, z: 5, src: "assets/pixel.png", image: { mode: "fill", crop: { left: .2, top: 0, right: 0, bottom: 0 } } },
  { id: "a-front", kind: "shape", x: 1100, y: 700, w: 120, h: 80, fill: "#aa4455", z: 7 },
]));

test("native group collection uses renderer default z while preserving an explicit zero layer", () => fixture(async ({ frame }) => {
  const group = item(frame, "a-group");
  const domLayers = await group.locator(":scope > [data-sd-group-content] > [data-sd-kind]").evaluateAll(children => children.map(e => Number(getComputedStyle(e).zIndex)));
  assert.deepEqual(domLayers, [1, 20, 0]);
  const collected = await group.evaluate(() => window.__sd.collect().find(o => o.id === "a-group"));
  assert.equal(collected.nativeSupported, true);
  assert.deepEqual(collected.children.map(o => o.id), ["a-group--2", "a-group--0", "a-group--1"]);
  assert.deepEqual(collected.children.map(o => o.z), [0, 1, 20]);
}, [{ id: "a-group", kind: "group", x: 250, y: 200, w: 400, h: 200, group: { width: 400, height: 200, children: [
  { kind: "shape", x: 0, y: 0, w: 250, h: 180, fill: "#ff0000", z: 1 },
  { kind: "shape", x: 100, y: 0, w: 250, h: 180, fill: "#0000ff" },
  { kind: "text", x: 50, y: 20, w: 250, h: 100, text: "Back layer", fontSize: 24, z: 0 },
] } }]));
