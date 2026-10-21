import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { prepareDeck, initialState, migrateState, validateState, renderDeck, inheritNotes } from "../src/deck.js";
import { Store } from "../src/store.js";

const html = '<html><head><title>Layouts</title></head><body><main><section class="slide" style="background:#123456"><h1>Imported title</h1><aside class="notes">첫째<br>둘째</aside></section><section class="slide"><p>Imported body</p></section></main></body></html>';
const deck = prepareDeck(html);
const ids = () => { let n = 0; return prefix => `${prefix}-layout-${++n}`; };
const effective = (state, id) => ({ ...state.added.find(item => item.id === id), ...(state.patches[id] || {}) });
const text = object => object.richText?.paragraphs.map(p => p.runs.map(r => r.text).join("")).join("\n") ?? object.text;

function stateOfSize(size, legacy = false) {
  const state = initialState(deck);
  if (legacy) for (const key of ["notes", "slideLayouts", "theme"]) delete state[key];
  else state.notes = {};
  state.masters = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["m-boundary-" + i, { name: "Boundary fixture", html: "", css: "/**/" }]));
  let remaining = size - JSON.stringify(state).length;
  for (const master of Object.values(state.masters)) {
    const count = Math.min(remaining, 99996);
    master.css = "/*" + "x".repeat(count) + "*/";
    remaining -= count;
  }
  assert.equal(remaining, 0, "fixture must fit inside twenty legal master CSS entries");
  assert.equal(JSON.stringify(state).length, size);
  return state;
}

test("old version-one states receive independent slide authoring defaults and imported notes", () => {
  const state = initialState(deck);
  assert.equal(deck.slides[0].notes, "첫째\n둘째");
  assert.equal(state.notes.s0, "첫째\n둘째");
  const legacy = { order: ["s0", "s1"], patches: {}, added: [], background: true };
  const migrated = validateState(legacy, deck);
  assert.equal(migrated.schemaVersion, 1);
  assert.deepEqual(migrated.notes, { s0: "첫째\n둘째", s1: "" });
  assert.deepEqual(migrated.slideLayouts, {});
  assert.deepEqual(migrated.theme, { colors: { background: "#ffffff", text: "#172033", accent: "#2563eb" }, fonts: { heading: "Arial", body: "Arial" } });
  migrated.theme.colors.text = "#ffffff";
  assert.equal(initialState(deck).theme.colors.text, "#172033");
  assert.equal(migrateState(legacy).schemaVersion, 1);
  assert.equal(Object.hasOwn(legacy, "notes"), false);
});

test("a legacy state at the old exact size limit migrates and survives a saved revision", async () => {
  const legacy = stateOfSize(2000000, true);
  const migrated = validateState(legacy, deck);
  assert.ok(JSON.stringify(migrated).length > 2000000);
  assert.ok(JSON.stringify(migrated).length <= 2001024);
  const root = await mkdtemp(join(tmpdir(), "studio-slide-boundary-"));
  const store = new Store(root);
  await store.init();
  try {
    const created = await store.create({ ...deck, files: new Map([["index.html", Buffer.from(deck.html)]]) });
    const revision = store.path(created.id, "revisions", "1.json");
    const snapshot = JSON.parse(await readFile(revision, "utf8"));
    snapshot.state = legacy;
    const original = JSON.stringify(snapshot);
    await writeFile(revision, original);
    const loaded = await store.get(created.id);
    assert.deepEqual(loaded.state.masters, legacy.masters);
    const saved = await store.save(created.id, loaded.revision, loaded.state);
    const reopened = await store.get(created.id);
    assert.equal(reopened.revision, 2);
    assert.deepEqual(reopened.state, saved.state);
    assert.deepEqual(reopened.state.masters, legacy.masters);
    assert.equal(await readFile(revision, "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("normalized state accepts the migration margin boundary and rejects one character beyond it", () => {
  const boundary = stateOfSize(2001024);
  assert.equal(JSON.stringify(validateState(boundary, deck)).length, 2001024);
  assert.throws(() => validateState(stateOfSize(2001025), deck), /너무 큽니다/);
});

test("inherited notes share the migration margin without inflating editable state past its limit", () => {
  const nearBoundary = stateOfSize(2001000);
  const notes = inheritNotes(nearBoundary, { s0: "fits", s1: "x".repeat(20000) });
  assert.deepEqual(notes, { s0: "fits" });
  assert.ok(JSON.stringify({ ...nearBoundary, notes }).length <= 2001024);
  const full = stateOfSize(2001024);
  assert.deepEqual(inheritNotes(full, { s0: "" }), {});
  assert.doesNotThrow(() => validateState({ ...full, notes: inheritNotes(full, { s0: "x".repeat(20000) }) }, deck));
});

test("theme defaults normalize safe color and font values and reject malformed properties", () => {
  const Slides = globalThis.SDSlides;
  assert.ok(Slides, "shared slide model must be available to server and browser");
  assert.deepEqual(Slides.normalizeTheme(), Slides.DEFAULT_THEME);
  assert.deepEqual(Slides.normalizeTheme({ colors: { accent: "#AABBCC" }, fonts: { heading: '  "Noto Sans KR", sans-serif  ' } }), {
    colors: { background: "#ffffff", text: "#172033", accent: "#aabbcc" }, fonts: { heading: '"Noto Sans KR", sans-serif', body: "Arial" },
  });
  for (const theme of [null, [], "Arial", { extra: true }, { colors: null }, { colors: { unknown: "#123456" } }, { colors: { text: "red" } },
    { colors: { text: ["#123456"] } }, { fonts: { body: "Arial; color:red" } }, { fonts: { body: "a".repeat(101) } },
    { fonts: { body: '"Arial' } }, { fonts: { body: "" } }, Object.create({ colors: {} })])
    assert.throws(() => Slides.normalizeTheme(theme));
});

test("layouts add theme-bound native text while preserving unrelated imported and added content", () => {
  const state = initialState(deck);
  state.added.push({ id: "a-independent", slide: "s0", kind: "text", text: "Independent", x: 1, y: 2 });
  state.patches[deck.elements[0].id] = { text: "Changed import" };
  const before = structuredClone(state);
  const next = globalThis.SDSlides.applyLayout(state, "s0", "two-column", ids());
  assert.deepEqual(state, before);
  assert.deepEqual(next.slideLayouts.s0, { type: "two-column", placeholders: { title: "a-layout-1", body: "a-layout-2", body2: "a-layout-3" } });
  assert.deepEqual(next.added[0], before.added[0]);
  assert.deepEqual(next.patches[deck.elements[0].id], before.patches[deck.elements[0].id]);
  const placeholders = Object.values(next.slideLayouts.s0.placeholders).map(id => effective(next, id));
  for (const object of placeholders) {
    assert.equal(object.kind, "text");
    assert.equal(object.slide, "s0");
    assert.ok(object.x >= 0 && object.y >= 0 && object.x + object.w <= 1920 && object.y + object.h <= 1080);
    assert.equal(object.textBox.autoFit, "shrink");
  }
  assert.equal(placeholders[0].richText.paragraphs[0].runs[0].fontTheme, "heading");
  assert.equal(placeholders[0].richText.paragraphs[0].runs[0].colorTheme, "accent");
  assert.equal(placeholders[1].richText.paragraphs[0].runs[0].fontTheme, "body");
  assert.equal(placeholders[1].richText.paragraphs[0].runs[0].colorTheme, "text");
  assert.equal(placeholders[2].richText.paragraphs[0].runs[0].colorTheme, "text");
  assert.ok(placeholders[1].x + placeholders[1].w <= placeholders[2].x);
  assert.deepEqual(validateState(next, deck).slideLayouts, next.slideLayouts);
});

test("switching and removing layouts preserves role text, patches, and detached role objects", () => {
  const uid = ids();
  const initial = globalThis.SDSlides.applyLayout(initialState(deck), "s0", "two-column", uid);
  const { title, body, body2 } = initial.slideLayouts.s0.placeholders;
  initial.patches[title] = { text: "사용자 제목", richText: { paragraphs: [{ runs: [{ text: "사용자 제목", bold: false }] }] }, x: 500 };
  initial.patches[body] = { text: "첫째\n둘째" };
  const detached = structuredClone(effective(initial, body2));
  const next = globalThis.SDSlides.applyLayout(initial, "s0", "title", uid);
  assert.deepEqual(next.slideLayouts.s0.placeholders, { title, body });
  assert.equal(text(effective(next, title)), "사용자 제목");
  assert.equal(text(effective(next, body)), "첫째\n둘째");
  assert.deepEqual(effective(next, body2), detached);
  assert.equal(next.added.length, 3);
  const blank = globalThis.SDSlides.applyLayout(next, "s0", "blank", uid);
  assert.equal(Object.hasOwn(blank.slideLayouts, "s0"), false);
  assert.deepEqual(blank.added, next.added);
  assert.deepEqual(blank.patches, next.patches);
});

test("reset restores mapped placeholder geometry and formats while preserving text and omissions", () => {
  const state = globalThis.SDSlides.applyLayout(initialState(deck), "s0", "title-body", ids());
  const { title, body } = state.slideLayouts.s0.placeholders;
  const original = effective(state, title);
  state.patches[title] = { text: "Keep\nthis", richText: { paragraphs: [{ runs: [{ text: "Keep", color: "#ff0000", italic: true }] }, { runs: [{ text: "this" }] }] }, x: 900, y: 800, rotate: 90, fontSize: 12, color: "#ff0000", textBox: { autoFit: "none" }, hidden: true, z: 45 };
  state.added = state.added.filter(object => object.id !== body);
  delete state.slideLayouts.s0.placeholders.body;
  const snapshot = structuredClone(state);
  const reset = globalThis.SDSlides.resetLayout(state, "s0");
  const object = effective(reset, title);
  assert.deepEqual(state, snapshot);
  assert.equal(reset.added.length, 1);
  assert.deepEqual(reset.slideLayouts.s0.placeholders, { title });
  assert.equal(object.x, original.x);
  assert.equal(object.y, original.y);
  assert.equal(object.rotate, 0);
  assert.equal(text(object), "Keep\nthis");
  assert.equal(object.richText.paragraphs[0].runs[0].fontTheme, "heading");
  assert.equal(object.richText.paragraphs[0].runs[0].color, undefined);
  assert.equal(object.richText.paragraphs[0].runs[0].italic, undefined);
  assert.equal(object.color, undefined);
  assert.equal(object.textBox.autoFit, "shrink");
  assert.equal(object.hidden, true);
  assert.equal(object.z, 45);
  assert.doesNotThrow(() => validateState(reset, deck));
});

test("layout creation rejects invalid types, slide targets, duplicate IDs, and object-limit overflow", () => {
  const Slides = globalThis.SDSlides;
  const state = initialState(deck);
  assert.throws(() => Slides.applyLayout(state, "s0", "unknown", ids()));
  assert.throws(() => Slides.applyLayout(state, "s-missing", "title", ids()));
  assert.throws(() => Slides.applyLayout(state, "s0", "title", () => "bad-id"));
  assert.throws(() => Slides.applyLayout(state, "s0", "title", () => "a-reused"));
  state.added = Array.from({ length: 499 }, (_, i) => ({ id: `a-${i}`, slide: "s0", kind: "text", text: "x" }));
  assert.throws(() => Slides.applyLayout(state, "s0", "title", ids()));
  assert.equal(state.added.length, 499);
});

test("state validation enforces note limits and real same-slide unique text placeholder references", () => {
  const state = initialState(deck);
  state.notes.s0 = "x".repeat(20000);
  assert.equal(validateState(state, deck).notes.s0.length, 20000);
  for (const notes of [{ s0: "x".repeat(20001) }, { s0: 1 }, { "s-unknown": "text" }, [], null])
    assert.throws(() => validateState({ ...state, notes }, deck));
  const added = [{ id: "a-title", slide: "s0", kind: "text", text: "Title" }, { id: "a-other", slide: "s1", kind: "text", text: "Other" }, { id: "a-shape", slide: "s0", kind: "shape", shape: { type: "rect" } }];
  const valid = { ...initialState(deck), added, slideLayouts: { s0: { type: "title-body", placeholders: { title: "a-title" } } } };
  assert.doesNotThrow(() => validateState(valid, deck));
  for (const slideLayouts of [null, [], { "s-unknown": { type: "title", placeholders: {} } },
    { s0: { type: "blank", placeholders: {} } }, { s0: { type: "title", placeholders: {}, extra: true } },
    { s0: { type: "title", placeholders: { body2: "a-title" } } }, { s0: { type: "title", placeholders: { caption: "a-title" } } },
    { s0: { type: "title", placeholders: { title: "a-missing" } } }, { s0: { type: "title", placeholders: { title: "a-other" } } },
    { s0: { type: "title", placeholders: { title: "a-shape" } } }, { s0: { type: "title", placeholders: { title: "a-title", body: "a-title" } } },
    { s0: { type: "title", placeholders: { title: deck.elements[0].id } } }])
    assert.throws(() => validateState({ ...valid, slideLayouts }, deck));
});

test("state authoring fields reject inherited, accessor, hidden and symbol properties before cloning", () => {
  const state = initialState(deck);
  const inheritedTheme = Object.assign(Object.create({ extra: true }), { colors: { text: "#112233" } });
  const inheritedNotes = Object.assign(Object.create({ s1: "hidden" }), { s0: "visible" });
  const inheritedLayout = Object.assign(Object.create({ extra: true }), { type: "title", placeholders: {} });
  const hiddenLayout = Object.defineProperty({ type: "title", placeholders: {} }, "extra", { value: true });
  const symbolNotes = { s0: "x", [Symbol("secret")]: "hidden" };
  for (const extra of [{ theme: inheritedTheme }, { notes: inheritedNotes }, { notes: symbolNotes },
    { slideLayouts: { s0: inheritedLayout } }, { slideLayouts: { s0: hiddenLayout } }])
    assert.throws(() => validateState({ ...state, ...extra }, deck));
  let touched = false;
  const getterTheme = { get colors() { touched = true; return {}; } };
  assert.throws(() => validateState({ ...state, theme: getterTheme }, deck));
  assert.equal(touched, false);
});

test("reset drops a stale placeholder mapping without recreating deleted content", () => {
  const state = globalThis.SDSlides.applyLayout(initialState(deck), "s0", "title-body", ids());
  const title = state.slideLayouts.s0.placeholders.title;
  state.added = state.added.filter(object => object.id !== title);
  assert.throws(() => validateState(state, deck));
  const reset = globalThis.SDSlides.resetLayout(state, "s0");
  assert.equal(reset.added.length, 1);
  assert.equal(reset.slideLayouts.s0.placeholders.title, undefined);
  assert.doesNotThrow(() => validateState(reset, deck));
});

test("rendered slides inherit theme variables everywhere while layout background stays scoped", () => {
  let state = globalThis.SDSlides.applyLayout(initialState(deck), "s1", "title-body", ids());
  state.theme = { colors: { background: "#eeeeee", text: "#112233", accent: "#ff0000" }, fonts: { heading: "Georgia", body: "Arial" } };
  const title = state.added.find(item => item.id === state.slideLayouts.s1.placeholders.title);
  state.added.push({ ...structuredClone(title), id: "a-copied", slide: "s0" });
  const document = parseHTML(renderDeck(deck.html, validateState(state, deck))).document;
  const slides = [...document.querySelectorAll("[data-sd-slide]")];
  for (const slide of slides) {
    assert.equal(slide.style.getPropertyValue("--sd-theme-heading-font"), "Georgia");
    assert.equal(slide.style.getPropertyValue("--sd-theme-body-font"), "Arial");
    assert.equal(slide.style.getPropertyValue("--sd-theme-text"), "#112233");
    assert.equal(slide.style.getPropertyValue("--sd-theme-accent"), "#ff0000");
  }
  assert.equal(slides[0].style.background, "#123456");
  assert.equal(slides[1].style.background, "#eeeeee");
  assert.equal(document.querySelector('[data-sd-id="a-copied"] [data-sd-run]').style.fontFamily, "var(--sd-theme-heading-font)");
});

test("rendering stored notes safely replaces imported and cloned notes with line breaks intact", () => {
  const state = initialState(deck);
  state.clones["s-copy"] = "s0";
  state.order.push("s-copy");
  state.notes.s0 = "<img src=x onerror=alert(1)>\n새 노트";
  state.notes["s-copy"] = "복제 노트\n둘째 줄";
  const document = parseHTML(renderDeck(deck.html, validateState(state, deck))).document;
  const original = document.querySelector('[data-sd-slide="s0"] .notes');
  assert.equal(original.textContent, state.notes.s0);
  assert.equal(original.querySelector("img"), null);
  assert.equal(original.style.whiteSpace, "pre-wrap");
  assert.equal(document.querySelector('[data-sd-slide="s-copy"] .notes').textContent, state.notes["s-copy"]);
  state.notes.s0 = "";
  const cleared = parseHTML(renderDeck(deck.html, validateState(state, deck))).document;
  assert.equal(cleared.querySelector('[data-sd-slide="s0"] .notes').textContent, "");
});
