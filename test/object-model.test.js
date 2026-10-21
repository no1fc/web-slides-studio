import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { chromium } from "playwright";
import "../public/text-model.js";
import "../public/object-model.js";
import { prepareDeck, initialState, validateState, renderDeck } from "../src/deck.js";
import { Store } from "../src/store.js";

const O = globalThis.SDObjects;
const input = prepareDeck('<html><head></head><body><main><section class="slide"><h1>Original</h1></section></main></body></html>');
const shape = (extra = {}) => ({ kind: "shape", x: 100, y: 100, w: 200, h: 100, shape: { type: "rect", fill: "#123456", stroke: "#654321", strokeWidth: 2, dash: "solid" }, ...extra });
const image = (extra = {}) => ({ kind: "image", src: "photo.png", x: 500, y: 200, w: 300, h: 100, image: { mode: "fill", crop: { left: .1, right: .2, top: .05, bottom: .15 } }, ...extra });
const stateWith = (...objects) => ({ ...initialState(input), added: objects.map((o, n) => ({ ...o, id: `a-${n}`, slide: "s0" })) });
const near = (a, b) => assert.ok(Math.abs(a - b) < .001, `${a} ~= ${b}`);

test("image crop normalization preserves local sources and rejects unsafe or malformed data", () => {
  assert.deepEqual(O.normalizeImage(), { mode: "stretch", crop: { left: 0, top: 0, right: 0, bottom: 0 } });
  assert.equal(O.safeImageSource("pictures/한글 사진.png"), "pictures/한글 사진.png");
  for (const value of [null, [], { mode: "cover" }, { mode: null }, { crop: { left: .7, right: .3 } }, { crop: { top: -1 } }, { crop: { left: "0.1" } }, { src: "x" }, { crop: { x: .1 } }, Object.create({ mode: "fill" }), { get mode() { throw new Error("must not call"); } }]) assert.throws(() => O.normalizeImage(value));
  for (const value of ["../photo.png", "images/../photo.png", "https://x/a.png", "/photo.png", "C:/photo.png", "a%2fb.png", "a\\b.png", "a.png#x", "a.svg", "a/./b.png", "a/.hidden.png", "a.png ", "a.png\n"]) assert.throws(() => O.safeImageSource(value), undefined, value);
});

test("image layout computes full source placement and effective Fill/Fit source rectangles", () => {
  const fill = O.imageLayout(200, 200, 400, 200, { mode: "fill" });
  assert.deepEqual(fill.frame, { x: 0, y: 0, w: 200, h: 200 });
  assert.deepEqual(fill.crop, { left: .25, top: 0, right: .25, bottom: 0 });
  assert.equal(fill.x, -100); assert.equal(fill.w, 400);
  const fit = O.imageLayout(200, 200, 400, 200, { mode: "fit", crop: { left: .25, top: .25 } });
  near(fit.frame.w, 200); near(fit.frame.h, 100); near(fit.frame.y, 50);
  assert.deepEqual(fit.crop, { left: .25, top: .25, right: 0, bottom: 0 });
  const stretch = O.imageLayout(300, 100, 400, 200, { mode: "stretch", crop: { left: .25, bottom: .5 } });
  assert.deepEqual(stretch.frame, { x: 0, y: 0, w: 300, h: 100 });
  near(stretch.x, -100); near(stretch.w, 400); near(stretch.h, 200);
});

test("native shape validation keeps legacy rectangles and rejects untrusted geometry", () => {
  assert.equal(O.normalizeShape(undefined, "#ABCDEF").fill, "#abcdef");
  assert.equal(O.normalizeShape().type, "rect");
  for (const s of [null, [], { type: "svg" }, { fill: "url(x)" }, { fill: null }, { strokeWidth: null }, { strokeWidth: 41 }, { strokeWidth: NaN }, { dash: "long" }, { path: "M0,0" }]) assert.throws(() => O.normalizeShape(s));
  for (const type of ["rect", "ellipse", "line", "arrow"]) assert.equal(O.normalizeShape({ type }).type, type);
});

test("group/ungroup preserves rotated child centers and scales typography and borders", () => {
  const original = [shape({ rotate: 30 }), { kind: "text", x: 500, y: 300, w: 200, h: 80, text: "한글", fontSize: 30, richText: { paragraphs: [{ spaceAfter: 10, runs: [{ text: "한글", fontSize: 30 }] }] } }];
  const grouped = O.groupObjects(original);
  const ungrouped = O.ungroup(grouped);
  original.forEach((item, i) => { for (const key of ["x", "y", "w", "h"]) near(ungrouped[i][key], item[key]); near(ungrouped[i].rotate || 0, item.rotate || 0); });
  const moved = { ...grouped, x: 50, y: 60, w: grouped.w * 2, h: grouped.h * 2, rotate: 90 };
  const result = O.ungroup(moved);
  near(result[0].shape.strokeWidth, 4); near(result[0].rotate, 120);
  near(result[1].fontSize, 60); near(result[1].richText.paragraphs[0].runs[0].fontSize, 60); near(result[1].richText.paragraphs[0].spaceAfter, 20);
  near(result[1].textMetricsScale, 2);
  const child = grouped.group.children[0], cx = moved.x + moved.w / 2, cy = moved.y + moved.h / 2;
  near(result[0].x + result[0].w / 2, cx - 2 * (child.y + child.h / 2 - grouped.group.height / 2));
  near(result[0].y + result[0].h / 2, cy + 2 * (child.x + child.w / 2 - grouped.group.width / 2));
  assert.deepEqual(original[0], shape({ rotate: 30 }));
});

test("nested group transforms round trip and enforce uniform scale and content limits", () => {
  const group = O.groupObjects([shape(), image()]);
  const nested = O.groupObjects([group, shape({ x: 1000 })]);
  const again = O.ungroup(nested)[0];
  near(again.x, group.x); near(again.y, group.y);
  assert.equal(again.group.children[1].src, "photo.png");
  assert.throws(() => O.ungroup({ ...group, h: group.h * 2 }));
  assert.throws(() => O.groupObjects([shape(), { kind: "html", html: "<b>Text</b>", x: 1, y: 1, w: 20, h: 20 }]));
  const invalid = structuredClone(group); invalid.group.children[0].id = "e0";
  assert.throws(() => O.normalizeGroup(invalid.group));
  assert.throws(() => O.normalizeGroup({ width: 100, height: 100, children: Array(2) }));
  let deep = shape(); for (let i = 0; i < 5; i++) deep = { kind: "group", x: 0, y: 0, w: 100, h: 100, group: { width: 100, height: 100, children: [deep, shape()] } };
  assert.throws(() => O.normalizeGroup(deep.group));
  const huge = { width: 100, height: 100, children: Array.from({ length: 500 }, () => shape()) };
  assert.throws(() => O.normalizeGroup(huge));
});

test("state validates effective group geometry and fields cannot mutate unrelated original HTML", () => {
  const group = O.groupObjects([shape(), image()]);
  const state = stateWith(group);
  assert.deepEqual(validateState(validateState(state, input), input), validateState(state, input));
  state.patches["a-0"] = { w: group.w * 2, h: group.h * 2 };
  assert.doesNotThrow(() => validateState(state, input));
  state.patches["a-0"].h += 50;
  assert.throws(() => validateState(state, input));
  for (const p of [{ group: group.group }, { shape: { type: "ellipse" } }, { image: { mode: "fill" } }]) assert.throws(() => validateState({ ...initialState(input), patches: { e0: p } }, input));
  assert.throws(() => validateState(stateWith(shape({ group: group.group })), input));
  const bigGroup = { kind: "group", x: 0, y: 0, w: 100, h: 100, group: { width: 100, height: 100, children: Array.from({ length: 250 }, () => shape()) } };
  assert.throws(() => validateState(stateWith(bigGroup, bigGroup), input), /500/);
  assert.throws(() => O.ungroup({ ...group, group: { ...group.group, children: [shape(), { kind: "text", x: 0, y: 0, w: 10, h: 10, fontSize: 400 }] }, w: group.w * 2, h: group.h * 2 }), /글꼴/);
});

test("native image state requires an effective source before save and accepts a patched source", async () => {
  const object = image(); delete object.src;
  const state = stateWith(object);
  assert.throws(() => validateState(state, input), /이미지 경로/);
  const root = await mkdtemp(join(tmpdir(), "studio-image-source-"));
  try {
    const store = new Store(root); await store.init();
    const deck = await store.create({ ...input, files: new Map([["index.html", Buffer.from(input.html)], ["photo.png", Buffer.from("fixture")]]) });
    await assert.rejects(store.save(deck.id, deck.revision, state), /이미지 경로/);
    assert.equal((await store.get(deck.id)).revision, 1);
    state.patches["a-0"] = { src: "photo.png" };
    const validated = validateState(state, input);
    const document = parseHTML(renderDeck(input.html, validated)).document;
    assert.equal(document.querySelector('[data-sd-id="a-0"] img').getAttribute("src"), "photo.png");
    const saved = await store.save(deck.id, 1, state);
    assert.equal(saved.revision, 2);
    assert.equal(saved.state.patches["a-0"].src, "photo.png");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy rectangle labels migrate into editable text boxes without losing base or patched rich text", () => {
  const richText = { paragraphs: [{ runs: [{ text: "이전 도형 라벨", fontSize: 32, bold: true }], align: "center" }] };
  for (const [base, patch] of [
    [{ text: "기본 라벨", fontSize: 28 }, {}],
    [{}, { text: "수정 라벨", fontSize: 30 }],
    [{ richText, textBox: { vertical: "middle" } }, {}],
    [{}, { richText, textBox: { vertical: "bottom" } }],
    [{ text: "" }, {}],
    [{}, { textBox: { vertical: "middle" } }],
  ]) {
    const state = stateWith({ kind: "shape", x: 20, y: 40, w: 300, h: 120, fill: "#aabbcc", ...base });
    state.patches["a-0"] = patch;
    const before = structuredClone(state), validated = validateState(state, input);
    assert.equal(validated.added[0].kind, "text");
    assert.equal(validated.added[0].fill, "#aabbcc");
    assert.deepEqual(state, before);
    assert.deepEqual(validateState(validated, input), validated);
    const element = parseHTML(renderDeck(input.html, validated)).document.querySelector('[data-sd-id="a-0"]');
    assert.equal(element.querySelector("svg"), null);
    assert.equal(element.style.background, "#aabbcc");
    assert.equal(element.textContent, patch.richText || base.richText ? "이전 도형 라벨" : patch.text ?? base.text ?? "");
  }
  assert.equal(validateState(stateWith({ kind: "shape", x: 0, y: 0, w: 20, h: 30, fill: "#aabbcc" }), input).added[0].kind, "shape");
});

test("structured shapes reject unsupported text instead of silently discarding it", () => {
  for (const fields of [{ text: "label" }, { text: "" }, { richText: { paragraphs: [{ runs: [{ text: "label" }] }] } }, { textBox: { vertical: "middle" } }]) {
    assert.throws(() => validateState(stateWith(shape(fields)), input), /도형/);
    const state = stateWith(shape()); state.patches["a-0"] = fields;
    assert.throws(() => validateState(state, input), /도형/);
    assert.throws(() => O.normalizeObject(shape(fields)), /도형/);
  }
});

test("loading an immutable older revision migrates rectangle labels without rewriting its stored state", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-shape-label-"));
  try {
    const store = new Store(root); await store.init();
    const deck = await store.create({ ...input, files: new Map([["index.html", Buffer.from(input.html)]]) });
    const state = stateWith({ kind: "shape", text: "보존할 라벨", x: 10, y: 20, w: 200, h: 100, fill: "#aabbcc" });
    const file = store.path(deck.id, "revisions", "1.json");
    await store.atomic(file, { state, savedAt: new Date().toISOString() });
    const original = await readFile(file, "utf8");
    const loaded = await store.get(deck.id, 1);
    assert.equal(loaded.state.added[0].kind, "text");
    assert.equal(loaded.state.added[0].text, "보존할 라벨");
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy rectangle labels retain their inherited CSS font size while explicit fonts still win", async () => {
  const state = stateWith(
    { kind: "shape", text: "상속", x: 0, y: 0, w: 300, h: 100, fill: "#aabbcc" },
    { kind: "shape", text: "명시", x: 0, y: 120, w: 300, h: 100, fill: "#aabbcc", fontSize: 42 },
  );
  const normalized = validateState(state, input);
  assert.equal(normalized.added[0].inheritFontSize, true);
  assert.equal(normalized.added[1].inheritFontSize, undefined);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(renderDeck(input.html, normalized));
    await page.addStyleTag({ content: ".slide {font-size:31px}" });
    assert.equal(await page.locator('[data-sd-id="a-0"]').evaluate(el => getComputedStyle(el).fontSize), "31px");
    assert.equal(await page.locator('[data-sd-id="a-1"]').evaluate(el => getComputedStyle(el).fontSize), "42px");
  } finally { await browser.close(); }
  assert.throws(() => validateState(stateWith({ kind: "text", text: "bad", inheritFontSize: "true" }), input));
  assert.throws(() => O.normalizeObject({ kind: "text", text: "unresolved", inheritFontSize: true, x: 0, y: 0, w: 100, h: 100 }));
});

test("rendered groups have one editable identity and preserve generated sources and shapes", () => {
  const group = O.groupObjects([shape({ shape: { type: "ellipse", fill: "none", stroke: "#123456", strokeWidth: 3, dash: "dash" } }), image()]);
  const document = parseHTML(renderDeck(input.html, validateState(stateWith(group), input))).document;
  const root = document.querySelector('[data-sd-id="a-0"]');
  assert.equal(root.dataset.sdKind, "group");
  assert.equal(root.querySelectorAll("[data-sd-id],[id]").length, 0);
  assert.equal(root.querySelector('[data-sd-kind="image"] img').getAttribute("src"), "photo.png");
  assert.ok(root.querySelector("svg ellipse"));
  assert.equal(root.querySelector("ellipse").getAttribute("fill"), "none");
  const legacy = parseHTML(renderDeck(input.html, validateState(stateWith({ kind: "shape", x: 0, y: 0, w: 20, h: 30, fill: "#aabbcc" }), input))).document;
  assert.equal(legacy.querySelector("rect").getAttribute("fill"), "#aabbcc");
});

test("missing nested image assets reject the save atomically and valid sources survive round trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-objects-"));
  try {
    const store = new Store(root); await store.init();
    const deck = await store.create({ ...input, files: new Map([["index.html", Buffer.from(input.html)]]) });
    const group = O.groupObjects([shape(), image()]);
    const state = stateWith(group);
    await assert.rejects(store.save(deck.id, deck.revision, state), /이미지 파일/);
    assert.equal((await store.get(deck.id)).revision, 1);
    await writeFile(store.path(deck.id, "assets", "photo.png"), "fixture");
    const saved = await store.save(deck.id, 1, state);
    assert.equal(saved.state.added[0].group.children[1].src, "photo.png");
    assert.equal(saved.revision, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
