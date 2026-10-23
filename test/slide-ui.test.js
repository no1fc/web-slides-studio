import { clickEditorTool, openRibbonTab } from './editor-ui-helpers.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import JSZip from "jszip";
import { startStudio } from "../src/server.js";
import { importArchive } from "../src/archive.js";

async function fixture(fn, originalNote = "원본 노트") {
  const root = await mkdtemp(join(tmpdir(), "studio-slides-ui-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const zip = new JSZip();
    zip.file("index.html", '<html><head><title>구성 테스트</title><style>body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{display:none;position:absolute;inset:0}.slide.active{display:block}.notes{display:none}</style></head><body><main id="stage"><section class="slide"><div class="notes">원본 노트</div></section><section class="slide"></section><section class="slide"></section></main></body></html>'.replace("원본 노트", originalNote));
    const d = await app.store.create(await importArchive(await zip.generateAsync({ type: "nodebuffer" })));
    const p = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    p.setDefaultTimeout(7000);
    await p.goto(app.origin + "/#deck=" + d.id);
    await p.waitForFunction(() => typeof frameReady !== "undefined" && frameReady);
    const saved = async () => {
      await p.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨") && !transitionBusy);
      return (await app.store.get(d.id)).state;
    };
    const ready = () => p.waitForFunction(() => frameReady && !transitionBusy);
    await fn({ app, d, p, saved, ready });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}

test("slide multi-selection moves, duplicates and deletes a stable block and preserves notes", () => fixture(async ({ p, saved, ready }) => {
  const rows = p.locator("#slideList .slide-item");
  await rows.nth(1).click({ modifiers: ["Control"] });
  await p.waitForFunction(() => document.querySelectorAll(".slide-item.selected").length === 2);
  await clickEditorTool(p, 'downSlideBtn');
  let s = await saved(); await ready();
  assert.deepEqual(s.order, ["s2", "s0", "s1"]);
  await clickEditorTool(p, 'duplicateSlideBtn');
  s = await saved(); await ready();
  assert.equal(s.order.length, 5);
  const copies = s.order.slice(3);
  assert.deepEqual(copies.map(id => s.clones[id]), ["s0", "s1"]);
  assert.equal(s.notes[copies[0]], "원본 노트");
  assert.equal(await p.locator(".slide-item.selected").count(), 2);
  await clickEditorTool(p, 'removeSlideBtn');
  s = await saved(); await ready();
  assert.deepEqual(s.order, ["s2", "s0", "s1"]);
  await rows.first().click(); await ready();
  await p.keyboard.press("Control+a");
  assert.equal(await p.locator(".slide-item.selected").count(), 3);
  await clickEditorTool(p, 'removeSlideBtn');
  await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("하나 이상"));
  assert.equal((await saved()).order.length, 3);
}));

test("deleting layout placeholders detaches roles and reapplying creates a visible replacement", () => fixture(async ({ p, saved, ready }) => {
  await openRibbonTab(p, 'slide');
  await clickEditorTool(p, 'layoutBtn');
  await p.locator("#applySlideLayoutBtn").click();
  let s = await saved(); await ready();
  const original = s.slideLayouts.s0.placeholders.title;
  await p.frameLocator("#deckFrame").locator(`[data-sd-id="${original}"]`).click();
  await openRibbonTab(p, 'format');
  await p.locator("#objectSettingsBtn").click();
  await p.locator("#removeElementBtn").click();
  await p.waitForFunction(id => state.patches[id]?.hidden, original);
  s = await saved();
  assert.equal(s.slideLayouts.s0.placeholders.title, undefined);
  assert.equal(s.patches[original].hidden, true);
  await p.locator("#undoBtn").click();
  s = await saved(); await ready();
  assert.equal(s.slideLayouts.s0.placeholders.title, original);
  await p.frameLocator("#deckFrame").locator(`[data-sd-id="${original}"]`).click();
  await p.keyboard.press("Delete");
  await p.waitForFunction(id => state.patches[id]?.hidden, original);
  s = await saved();
  assert.equal(s.slideLayouts.s0.placeholders.title, undefined);
  await openRibbonTab(p, 'slide');
  await clickEditorTool(p, 'layoutBtn');
  await p.locator("#applySlideLayoutBtn").click();
  s = await saved(); await ready();
  const replacement = s.slideLayouts.s0.placeholders.title;
  assert.notEqual(replacement, original);
  assert.equal(await p.frameLocator("#deckFrame").locator(`[data-sd-id="${replacement}"]`).isVisible(), true);
}));

test("undoing slide reorder keeps the active slide identity and keyboard focus works after click", () => fixture(async ({ p, saved, ready }) => {
  await p.locator(".slide-item").nth(1).click(); await ready();
  await p.keyboard.press("Alt+ArrowDown");
  assert.deepEqual((await saved()).order, ["s0", "s2", "s1"]); await ready();
  await p.locator("#undoBtn").click(); await saved(); await ready();
  assert.equal(await p.locator('.slide-item[aria-current="true"]').getAttribute("data-slide-id"), "s1");
}));

test("notes input survives immediate navigation, undo and reload without switching slides", () => fixture(async ({ p, saved, ready }) => {
  await p.locator("#notesPanel summary").click();
  assert.equal(await p.locator("#notesValue").inputValue(), "원본 노트");
  await p.locator("#notesValue").fill("첫 슬라이드 메모\n다음 줄");
  await p.locator(".slide-item").nth(1).click();
  await ready();
  assert.equal(await p.locator("#notesValue").inputValue(), "");
  assert.equal((await saved()).notes.s0, "첫 슬라이드 메모\n다음 줄");
  await p.locator("#undoBtn").click();
  assert.equal((await saved()).notes.s0, "원본 노트");
  await ready();
  await p.locator(".slide-item").first().click();
  await ready();
  await p.locator("#notesValue").fill("");
  await saved();
  await p.reload(); await ready();
  if (!(await p.locator("#notesPanel").getAttribute("open"))) await p.locator("#notesPanel summary").click();
  assert.equal(await p.locator("#notesValue").inputValue(), "");
}));

test("layouts reset positions but keep text, themes preserve individual formatting and cloned bindings", () => fixture(async ({ p, saved, ready }) => {
  await openRibbonTab(p, 'slide');
  await clickEditorTool(p, 'layoutBtn');
  await p.locator("#slideLayoutType").selectOption("title-body");
  await p.locator("#applySlideLayoutBtn").click();
  let s = await saved(); await ready();
  const titleId = s.slideLayouts.s0.placeholders.title;
  const initial = s.added.find(a => a.id === titleId);
  // Use the existing JSON UI to make a realistic external edit with individual formatting.
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await p.locator("#jsonBtn").click();
  const next = structuredClone(s);
  next.patches[titleId] = { x: 600, richText: { paragraphs: [{ runs: [{ text: "유지할 제목", color: "#aabbcc", fontTheme: "heading" }] }] } };
  await p.locator("#jsonState").fill(JSON.stringify(next));
  await p.locator("#jsonApplyBtn").click();
  await saved(); await ready();
  await openRibbonTab(p, 'slide');
  await clickEditorTool(p, 'themeBtn');
  await p.locator("#themePreset").selectOption("dark");
  await p.locator("#applyThemeBtn").click();
  s = await saved(); await ready();
  assert.equal(s.patches[titleId].richText.paragraphs[0].runs[0].color, "#aabbcc");
  const title = p.frameLocator("#deckFrame").locator(`[data-sd-id="${titleId}"]`);
  assert.equal(await title.locator("[data-sd-run]").first().evaluate(e => getComputedStyle(e).color), "rgb(170, 187, 204)");
  await openRibbonTab(p, 'slide');
  await clickEditorTool(p, 'layoutBtn');
  await p.locator("#resetSlideLayoutBtn").click();
  s = await saved(); await ready();
  const effective = { ...s.added.find(a => a.id === titleId), ...s.patches[titleId] };
  assert.equal(effective.x, initial.x);
  assert.equal(effective.richText.paragraphs[0].runs[0].text, "유지할 제목");
  assert.equal(effective.richText.paragraphs[0].runs[0].colorTheme, "accent");
  await clickEditorTool(p, 'duplicateSlideBtn');
  s = await saved(); await ready();
  const copy = s.order[1], copyTitle = s.slideLayouts[copy].placeholders.title;
  assert.notEqual(copyTitle, titleId);
  assert.equal(s.added.find(a => a.id === copyTitle).slide, copy);
}));

test("thumbnail selection keeps existing frames and drag reorders a selection in document order", () => fixture(async ({ p, saved, ready }) => {
  await p.waitForSelector(".slide-thumbnail iframe");
  const first = await p.locator(".slide-thumbnail iframe").first().elementHandle();
  await p.locator(".slide-item").nth(1).click({ modifiers: ["Shift"] }); await ready();
  assert.equal(await p.locator(".slide-item.selected").count(), 2);
  assert.equal(await first.evaluate(e => e.isConnected), true);
  await p.locator(".slide-item").first().dragTo(p.locator(".slide-item").nth(2), { targetPosition: { x: 80, y: 95 } });
  assert.deepEqual((await saved()).order, ["s2", "s0", "s1"]);
}));

test("long imported notes stay readable and intact when a slide is duplicated and other content is saved", () => fixture(async ({ p, app, d, saved, ready }) => {
  await p.locator("#notesPanel summary").click();
  assert.equal((await p.locator("#notesValue").inputValue()).length, 20001);
  assert.equal(await p.locator("#notesValue").evaluate(e => e.readOnly), true);
  assert.equal(await p.locator("#legacyNotesHelp").isVisible(), true);
  await clickEditorTool(p, 'duplicateSlideBtn');
  const s = await saved(); await ready();
  const copy = s.order[1];
  assert.equal(Object.hasOwn(s.notes, copy), false);
  assert.equal((await p.locator("#notesValue").inputValue()).length, 20001);
  const saving = p.waitForResponse(r => r.url().endsWith("/save") && r.request().method() === "POST");
  await openRibbonTab(p, 'slide');
  await p.locator("#backgroundValue").uncheck(); await saving; await saved();
  await p.reload(); await ready();
  const result = await app.store.get(d.id);
  assert.equal(result.sourceNotes.s0.length, 20001);
  assert.equal(result.sourceNotes[copy].length, 20001);
  assert.equal(result.state.background, false);
}, "L".repeat(20001)));
