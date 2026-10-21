import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import JSZip from "jszip";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import "../public/text-model.js";
import { initialState, prepareDeck, renderDeck, validateState, applyPatch } from "../src/deck.js";
import { Store } from "../src/store.js";
import { exportDeck } from "../src/export.js";

const { normalizeRichText, normalizeTextBox, plainText, formatRichText, renderRichText } = globalThis.SDText;
const rich = { paragraphs: [
  { runs: [{ text: "한글😀", fontFamily: '"Noto Sans KR", sans-serif', fontSize: 30, color: "#123ABC", bold: true }, { text: " <script>x</script>", italic: true }], align: "center", lineHeight: 1.5, spaceAfter: 8, indent: 2, list: "number" },
  { runs: [{ text: "둘째", underline: true }], list: "number" },
  { runs: [{ text: "" }], list: "bullet" },
] };
const input = prepareDeck('<html><head><title>Text</title></head><body><main><section class="slide"><h1 style="font-size:40px;color:#111111">Original</h1><p>Second</p><span>Inline</span></section></main></body></html>');
const parsed = (state) => parseHTML(renderDeck(input.html, validateState(state, input))).document;

test("normalization keeps optional inheritance, canonicalizes colors and merges identical adjacent runs", () => {
  const value = { paragraphs: [{ runs: [{ text: "한", color: "#AABBCC" }, { text: "글", color: "#aabbcc" }, { text: "😀" }] }, { runs: [] }] };
  const before = structuredClone(value);
  assert.deepEqual(normalizeRichText(value), { paragraphs: [{ runs: [{ text: "한글", color: "#aabbcc" }, { text: "😀" }] }, { runs: [{ text: "" }] }] });
  assert.deepEqual(value, before);
  assert.equal(plainText(value), "한글😀\n");
  assert.deepEqual(normalizeTextBox({ vertical: "middle", overflow: "clip", autoFit: "shrink" }), { vertical: "middle", overflow: "clip", autoFit: "shrink" });
  assert.deepEqual(normalizeTextBox({}), {});
});

test("normalization rejects unknown, inherited, accessor and incorrectly typed text properties", () => {
  const run = (value) => ({ paragraphs: [{ runs: [value] }] });
  const inheritedRun = Object.assign(Object.create({ bold: true }), { text: "unsafe" });
  const accessorRun = { get text() { throw new Error("must not invoke getter"); } };
  const symbolRun = { text: "unsafe", [Symbol("hidden")]: 1 };
  const nonenumerableRun = Object.defineProperty({ text: "unsafe" }, "html", { value: "<b>x</b>" });
  for (const value of [null, [], "plain", {}, { paragraphs: "wrong" }, { paragraphs: [], html: "x" },
    run(null), run([]), run({ text: 1 }), run({ text: "x", html: "<b>" }), run(inheritedRun), run(accessorRun), run(symbolRun), run(nonenumerableRun),
    run({ text: "x", bold: "true" }), run({ text: "x", italic: 1 }), run({ text: "x", underline: null }),
    run({ text: "x", color: "red" }), run({ text: "x", color: ["#123456"] }),
    run({ text: "x", fontSize: "12" }), run({ text: "x", fontSize: NaN }), run({ text: "x", fontSize: 5 }), run({ text: "x", fontSize: 401 }),
    run({ text: "x", fontFamily: "Arial;background:url(x)" }), run({ text: "x", fontFamily: "<b>" }), run({ text: "x", fontFamily: "a".repeat(101) }),
    { paragraphs: [{ runs: [], align: "start" }] }, { paragraphs: [{ runs: [], lineHeight: 4.1 }] }, { paragraphs: [{ runs: [], spaceAfter: -1 }] },
    { paragraphs: [{ runs: [], indent: 1.5 }] }, { paragraphs: [{ runs: [], list: "decimal" }] },
  ]) assert.throws(() => normalizeRichText(value));
  for (const value of [null, [], { vertical: "center" }, { overflow: "hidden" }, { autoFit: true }, { extra: true }, Object.create({ vertical: "top" })])
    assert.throws(() => normalizeTextBox(value));
});

test("text limits count total UTF-16 content and paragraph separators before merging runs", () => {
  assert.equal(plainText(normalizeRichText({ paragraphs: [{ runs: [{ text: "x".repeat(100000) }] }] })).length, 100000);
  assert.throws(() => normalizeRichText({ paragraphs: [{ runs: [{ text: "x".repeat(100000) }] }, { runs: [] }] }));
  assert.throws(() => normalizeRichText({ paragraphs: Array.from({ length: 501 }, () => ({ runs: [] })) }));
  assert.throws(() => normalizeRichText({ paragraphs: [{ runs: Array.from({ length: 5001 }, () => ({ text: "" })) }] }));
  assert.throws(() => normalizeRichText({ paragraphs: Array.from({ length: 2 }, () => ({ runs: Array.from({ length: 2501 }, () => ({ text: "" })) })) }));
});

test("normalization rejects sparse and decorated arrays and counts inserted empty runs toward the limit", () => {
  for (const paragraphs of [Array(1), Object.assign([], { html: "unsafe" }), Object.setPrototypeOf([], { inherited: true })])
    assert.throws(() => normalizeRichText({ paragraphs }));
  for (const runs of [Array(1), Object.assign([], { hidden: true }), Object.setPrototypeOf([], { inherited: true })])
    assert.throws(() => normalizeRichText({ paragraphs: [{ runs }] }));
  assert.throws(() => normalizeRichText({ paragraphs: [{ runs: Array.from({ length: 5000 }, (_, i) => ({ text: "x", bold: !!(i % 2) })) }, { runs: [] }] }));
});

test("partial UTF-16 formatting splits and merges selected Korean and emoji without changing other styles", () => {
  const original = { paragraphs: [{ runs: [{ text: "한글😀끝", italic: true }] }, { runs: [{ text: "다음" }] }] };
  const next = formatRichText(original, { start: 1, end: 4 }, "character", { bold: true, color: "#FF0000" });
  assert.deepEqual(next.paragraphs[0].runs, [{ text: "한", italic: true }, { text: "글😀", color: "#ff0000", bold: true, italic: true }, { text: "끝", italic: true }]);
  assert.equal(plainText(next), "한글😀끝\n다음");
  assert.deepEqual(original.paragraphs[0].runs, [{ text: "한글😀끝", italic: true }]);
  const all = formatRichText(next, null, "character", { italic: false });
  assert.equal(all.paragraphs[1].runs[0].italic, false);
  assert.deepEqual(formatRichText({ paragraphs: [{ runs: [{ text: "A", bold: true }, { text: "B" }] }] }, { start: 1, end: 2 }, "character", { bold: true }).paragraphs[0].runs, [{ text: "AB", bold: true }]);
  assert.deepEqual(formatRichText(original, { start: 2, end: 2 }, "character", { bold: true }), original);
});

test("paragraph ranges include the selected newline but exclude the next paragraph at an end boundary", () => {
  const original = { paragraphs: [{ runs: [{ text: "첫째" }] }, { runs: [{ text: "둘째" }] }, { runs: [{ text: "" }] }] };
  const first = formatRichText(original, { start: 0, end: 3 }, "paragraph", { align: "right", list: "bullet" });
  assert.equal(first.paragraphs[0].align, "right");
  assert.equal(first.paragraphs[1].align, undefined);
  const newline = formatRichText(original, { start: 2, end: 3 }, "paragraph", { indent: 1 });
  assert.equal(newline.paragraphs[0].indent, 1);
  assert.equal(newline.paragraphs[1].indent, undefined);
  const cursor = formatRichText(original, { start: 6, end: 6 }, "paragraph", { spaceAfter: 12 });
  assert.equal(cursor.paragraphs[2].spaceAfter, 12);
  assert.equal(cursor.paragraphs[1].spaceAfter, undefined);
  assert.ok(formatRichText(original, null, "paragraph", { lineHeight: 2 }).paragraphs.every(p => p.lineHeight === 2));
  for (const range of [{ start: -1, end: 1 }, { start: 4, end: 2 }, { start: 0, end: 7 }, { start: 0.5, end: 1 }, { start: "0", end: 1 }])
    assert.throws(() => formatRichText(original, range, "character", { bold: true }));
  assert.throws(() => formatRichText(original, null, "character", { text: "replace" }));
  assert.throws(() => formatRichText(original, null, "paragraph", { bold: true }));
  assert.throws(() => formatRichText(original, null, "box", {}));
});

test("safe block-span rendering preserves heading and inline hosts with text-only content and ordered list markers", () => {
  for (const tag of ["h1", "p", "span"]) {
    const { document } = parseHTML(`<html><body><${tag} style="font-size:40px">Original</${tag}></body></html>`);
    const element = document.body.firstElementChild;
    renderRichText(element, rich);
    const serialized = parseHTML(document.toString()).document.body.firstElementChild;
    assert.equal(serialized.localName, tag);
    assert.equal(serialized.getAttribute("data-sd-rich"), "true");
    assert.equal(serialized.querySelectorAll("[data-sd-paragraph]").length, 3);
    assert.equal(serialized.querySelectorAll("p,script").length, 0);
    assert.equal(serialized.querySelector("[data-sd-run]").textContent, "한글😀");
    assert.deepEqual([...serialized.querySelectorAll("[data-sd-marker]")].map(e => e.textContent.trim()), ["1.", "1.", "•"]);
    assert.equal(serialized.querySelector("[data-sd-marker]").getAttribute("contenteditable"), "false");
    assert.equal(serialized.querySelector("[data-sd-paragraph]").style.textAlign, "center");
    assert.equal(serialized.querySelector("[data-sd-text-content]").style.width, "100%");
    assert.equal(serialized.querySelector("[data-sd-text-content]").style.flexShrink, "0");
    assert.equal(serialized.querySelector("[data-sd-run]").style.fontSize, "30px");
    assert.equal(serialized.style.display, undefined);
    assert.equal(serialized.style.fontSize, "40px");
    assert.match(serialized.textContent, /<script>x<\/script>/);
  }
  const { document } = parseHTML("<html><body><div></div></body></html>");
  renderRichText(document.body.firstElementChild, { paragraphs: [0, 1, 2, 0].map(indent => ({ runs: [{ text: "Item" }], list: "number", indent })) });
  assert.deepEqual([...document.querySelectorAll("[data-sd-marker]")].map(e => e.textContent.trim()), ["1.", "1.", "1.", "2."]);
});

test("an indented plain paragraph preserves the shallower numbered-list sequence", () => {
  const { document } = parseHTML("<html><body><div></div></body></html>");
  renderRichText(document.body.firstElementChild, { paragraphs: [
    { runs: [{ text: "First" }], list: "number", indent: 0 },
    { runs: [{ text: "Nested" }], list: "number", indent: 1 },
    { runs: [{ text: "Nested explanation" }], list: "none", indent: 1 },
    { runs: [{ text: "Nested restart" }], list: "number", indent: 1 },
    { runs: [{ text: "Second" }], list: "number", indent: 0 },
  ] });
  assert.deepEqual([...document.querySelectorAll("[data-sd-marker]")].map(e => e.textContent), ["1.", "1.", "1.", "2."]);
});

test("host underline becomes a run default while explicit false and unrelated decorations are preserved", () => {
  const { document } = parseHTML('<html><body><div style="text-decoration:underline"><p style="text-decoration:underline line-through">Original</p></div></body></html>');
  const element = document.querySelector("p");
  const value = { paragraphs: [{ runs: [{ text: "Default" }, { text: " Off", underline: false }, { text: " On", underline: true }] }] };
  renderRichText(element, value);
  assert.equal(element.style.textDecorationLine, "line-through");
  assert.deepEqual([...element.querySelectorAll("[data-sd-run]")].map(run => run.style.textDecoration), ["underline", "none", "underline"]);
  assert.equal(JSON.parse(element.getAttribute("data-sd-rich-text")).paragraphs[0].runs[0].underline, undefined);
  assert.equal(element.parentElement.style.textDecoration, "underline");
  renderRichText(element, value);
  assert.deepEqual([...element.querySelectorAll("[data-sd-run]")].map(run => run.style.textDecoration), ["underline", "none", "underline"]);
});

test("browser rendering cancels CSS host underline without losing omitted run defaults across rerenders", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>body{margin:0}.underlined{font:32px/40px Arial;width:600px;margin:0;text-decoration:underline}</style><p class="underlined" id="target">Original</p>');
    await page.addScriptTag({ path: fileURLToPath(new URL("../public/text-model.js", import.meta.url)) });
    const value = { paragraphs: [{ runs: [{ text: "Off", underline: false }, { text: " On", underline: true }, { text: " Default" }] }] };
    for (let index = 0; index < 2; index++) {
      await page.evaluate(value => SDText.renderRichText(document.querySelector("#target"), value), value);
      const rendered = await page.locator("#target").screenshot();
      await page.evaluate(() => {
        const root = document.querySelector("#target");
        root.style.textDecorationLine = "none";
        const runs = root.querySelectorAll("[data-sd-run]");
        runs[0].style.textDecoration = "none";
        runs[1].style.textDecoration = "underline";
        runs[2].style.textDecoration = "underline";
      });
      assert.ok(rendered.equals(await page.locator("#target").screenshot()), "Explicitly disabled underline must match the visual reference while omitted underline keeps the host default.");
    }
  } finally { await browser.close(); }
});

test("server-rendered underline defaults survive browser rendering and explicit underline removal", async () => {
  const { document } = parseHTML('<html><body><p id="target" style="text-decoration:underline">Original</p></body></html>');
  const value = { paragraphs: [{ runs: [{ text: "Default" }, { text: " Off", underline: false }] }] };
  renderRichText(document.querySelector("p"), value);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(document.toString());
    await page.addScriptTag({ path: fileURLToPath(new URL("../public/text-model.js", import.meta.url)) });
    const result = await page.evaluate(value => {
      const root = document.querySelector("#target");
      SDText.renderRichText(root, value);
      return { host: getComputedStyle(root).textDecorationLine, runs: [...root.querySelectorAll("[data-sd-run]")].map(run => getComputedStyle(run).textDecorationLine) };
    }, value);
    assert.deepEqual(result, { host: "none", runs: ["underline", "none"] });
  } finally { await browser.close(); }
});

test("text boxes retain rich content and legacy flow unless vertical alignment was explicitly requested", () => {
  const { document } = parseHTML('<html><body><p style="display:inline-block">Legacy <b>bold</b></p></body></html>');
  const element = document.body.firstElementChild;
  applyPatch(element, { textBox: { overflow: "clip", autoFit: "shrink" } });
  assert.equal(element.querySelector("b").textContent, "bold");
  assert.equal(element.style.display, "inline-block");
  assert.equal(element.style.overflow, "hidden");
  applyPatch(element, { richText: rich, fontSize: 48, w: 300, h: 180, textBox: { vertical: "middle", overflow: "clip", autoFit: "shrink" }, hidden: true });
  assert.equal(element.style.width, "300px");
  assert.equal(element.style.height, "180px");
  assert.equal(element.style.display, "none");
  assert.equal(element.style.justifyContent, "center");
  applyPatch(element, { textBox: { vertical: "bottom", overflow: "visible", autoFit: "none" }, hidden: false });
  assert.equal(element.querySelectorAll("[data-sd-paragraph]").length, 3);
  assert.equal(element.style.justifyContent, "flex-end");
  assert.equal(element.style.display, "flex");
  assert.equal(element.style.overflow, "visible");
  assert.deepEqual(JSON.parse(element.getAttribute("data-sd-text-box")), { vertical: "bottom", overflow: "visible", autoFit: "none" });
});

test("legacy visibility updates tolerate unrelated malformed text metadata", () => {
  const { document } = parseHTML('<html><body><p data-sd-text-box="unrelated legacy value" style="display:none">Legacy</p></body></html>');
  const element = document.body.firstElementChild;
  applyPatch(element, { hidden: false });
  assert.notEqual(element.style.display, "none");
  assert.equal(element.textContent, "Legacy");
});

test("state keeps rich text precedence, legacy defaults and separate added, original and slide-copy content", () => {
  const state = initialState(input);
  state.patches.e0 = { text: "stale", richText: rich, fontSize: 60, color: "#333333" };
  state.patches.e1 = { text: "Legacy" };
  state.added.push({ id: "a-text", slide: "s0", kind: "text", text: "stale added", richText: rich, x: 20, y: 30 });
  state.clones["s-copy"] = "s0";
  state.order.push("s-copy");
  state.patches["s-copy--e0"] = { richText: { paragraphs: [{ runs: [{ text: "Clone" }] }] } };
  const normalized = validateState(state, input);
  assert.deepEqual(validateState(normalized, input), normalized);
  const document = parsed(normalized);
  const original = document.querySelector('[data-sd-id="e0"]');
  assert.equal(original.querySelector("[data-sd-run]").textContent, "한글😀");
  assert.equal(original.style.fontSize, "60px");
  assert.equal(document.querySelector('[data-sd-id="e1"]').textContent, "Legacy");
  assert.equal(document.querySelector('[data-sd-id="a-text"]').style.fontSize, "48px");
  assert.equal(document.querySelector('[data-sd-id="s-copy--e0"]').textContent, "Clone");
  const inherited = Object.assign(Object.create({ bold: true }), { text: "bad" });
  assert.throws(() => validateState({ ...state, patches: { e0: { richText: { paragraphs: [{ runs: [inherited] }] } } } }, input));
  assert.throws(() => validateState({ ...state, added: [{ id: "a-bad", slide: "s0", kind: "text", richText: { paragraphs: [{ runs: [inherited] }] } }] }, input));
});

test("rich text plain fallbacks allow 100000 characters in patches and added objects while legacy text stays bounded", () => {
  const text = "가".repeat(100000);
  const richText = { paragraphs: [{ runs: [{ text }] }] };
  const state = initialState(input);
  state.patches.e0 = { text, richText };
  state.added.push({ id: "a-long-text", slide: "s0", kind: "text", text, richText });
  const normalized = validateState(state, input);
  assert.equal(normalized.patches.e0.text.length, 100000);
  assert.equal(normalized.added[0].text.length, 100000);
  assert.equal(normalized.patches.e0.richText.paragraphs[0].runs[0].text.length, 100000);
  for (const value of [{ text: text + "가", richText }, { text: "가".repeat(20001) }]) {
    assert.throws(() => validateState({ ...initialState(input), patches: { e0: value } }, input));
    assert.throws(() => validateState({ ...initialState(input), added: [{ id: "a-too-long", slide: "s0", kind: "text", ...value }] }, input));
  }
  assert.equal(validateState({ ...initialState(input), patches: { e0: { text: "가".repeat(20000) } } }, input).patches.e0.text.length, 20000);
});

test("saving rich text and its plain fallback beyond the legacy limit preserves original and added content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-long-rich-text-"));
  try {
    const store = new Store(directory);
    await store.init();
    const deck = await store.create({ ...input, files: new Map([["index.html", Buffer.from(input.html)]]) });
    const text = "한글😀 ".repeat(5000);
    const richText = { paragraphs: [{ runs: [{ text, bold: true }] }] };
    const state = structuredClone(deck.state);
    state.patches.e0 = { text, richText };
    state.added.push({ id: "a-long-text", slide: "s0", kind: "text", text, richText });
    const saved = await store.save(deck.id, 1, state);
    assert.equal(saved.revision, 2);
    const reopened = await store.get(deck.id);
    assert.equal(reopened.state.patches.e0.text, text);
    assert.equal(reopened.state.added[0].text, text);
    const document = parsed(reopened.state);
    assert.equal(document.querySelector('[data-sd-id="e0"] [data-sd-run]').textContent, text);
    assert.equal(document.querySelector('[data-sd-id="a-long-text"] [data-sd-run]').textContent, text);
    assert.equal(document.querySelector('[data-sd-id="a-long-text"] [data-sd-run]').style.fontWeight, "700");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rich text survives saved revision reads, duplication, restored state and HTML export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-rich-text-"));
  try {
    const store = new Store(directory);
    await store.init();
    const deck = await store.create({ ...input, files: new Map([["index.html", Buffer.from(input.html)]]) });
    const state = structuredClone(deck.state);
    state.patches.e0 = { richText: rich, textBox: { vertical: "middle", overflow: "clip", autoFit: "shrink" }, w: 350, h: 160 };
    const saved = await store.save(deck.id, 1, state);
    assert.deepEqual((await store.get(deck.id, 2)).state, saved.state);
    assert.deepEqual((await store.duplicate(deck.id)).state, saved.state);
    const reset = await store.save(deck.id, 2, deck.state);
    await store.save(deck.id, reset.revision, (await store.get(deck.id, 2)).state);
    const restored = await store.get(deck.id);
    assert.deepEqual(restored.state, saved.state);
    const output = await exportDeck({ store, deck: restored, format: "html" });
    const zip = await JSZip.loadAsync(output.buffer);
    const document = parseHTML(await zip.file("index.html").async("string")).document;
    const element = document.querySelector('[data-sd-id="e0"]');
    assert.equal(element.querySelectorAll("[data-sd-paragraph]").length, 3);
    assert.equal(element.querySelector("[data-sd-run]").style.fontFamily, '"Noto Sans KR", sans-serif');
    assert.equal(element.querySelector("[data-sd-run]").style.color, "#123abc");
    assert.equal(element.style.justifyContent, "center");
    assert.equal(element.style.overflow, "hidden");
    assert.equal(element.querySelectorAll("script").length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
