import { clickEditorTool, showEditorControl } from './editor-ui-helpers.js';
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
  const root = await mkdtemp(join(tmpdir(), "studio-text-browser-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const zip = new JSZip();
    zip.file("index.html", '<html><head><title>텍스트 편집</title><style>html,body{margin:0}main{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none}.slide.active{display:block}h1{position:absolute;left:100px;top:30px;width:1000px;margin:0;font:42px Arial;color:#123456}</style></head><body><main id="stage"><section class="slide"><h1>기본 <strong>강조</strong></h1></section><section class="slide"><h1>다음</h1></section></main></body></html>');
    let deck = await app.store.create(await importArchive(await zip.generateAsync({ type: "nodebuffer" })));
    deck.state.added.push({ id: "a-text", slide: "s0", kind: "text", text: "한글 Alpha Beta", x: 100, y: 220, w: 900, h: 280, fontSize: 48, color: "#183e38" });
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(6000);
    await page.goto(app.origin + "/#deck=" + deck.id);
    const frame = page.frameLocator("#deckFrame"), text = frame.locator('[data-sd-id="a-text"]'); await text.waitFor();
    await fn({ app, deck, page, frame, text });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}
async function saved(page) { await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨")); }
async function setting(page, id, action) {
  const control = page.locator("#" + id);
  const dialogId = await control.evaluate(el => el.closest("dialog")?.id);
  if (dialogId) await clickEditorTool(page, dialogId + "Btn");
  else await showEditorControl(page, id);
  const collapsed = control.locator("xpath=ancestor::details[not(@open)]");
  if (await collapsed.count()) await collapsed.locator("summary").click();
  await action(control);
  await page.waitForFunction(() => !document.querySelector("#saveStatus").textContent.includes("적용 중"));
  if (dialogId) await page.locator("#" + dialogId + " .dialog-head button").click();
}
async function change(page, id, value) {
  await setting(page, id, async control => { await control.fill(value); await control.dispatchEvent("change"); });
}
async function selectRange(text, start, end) {
  await text.evaluate((el, { start, end }) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = []; let pos = 0;
    while (walker.nextNode()) { const n = walker.currentNode; if (n.parentElement.closest("[data-sd-marker]")) continue; nodes.push({ n, start: pos, end: pos + n.length }); pos += n.length; }
    const a = nodes.find(n => start >= n.start && start <= n.end), b = nodes.find(n => end >= n.start && end <= n.end);
    const range = document.createRange(); range.setStart(a.n, start - a.start); range.setEnd(b.n, end - b.start);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, { start, end });
}

test("whole text formatting and paragraph controls persist and undo as one command", () => fixture(async ({ app, deck, page, text }) => {
  await text.click(); await page.locator("#boldTextBtn").click();
  await page.waitForFunction(() => document.querySelector("#boldTextBtn").getAttribute("aria-pressed") === "true");
  await setting(page, "textAlignValue", control => control.selectOption("center"));
  await setting(page, "listStyleValue", control => control.selectOption("bullet"));
  await setting(page, "indentTextBtn", control => control.click());
  await change(page, "lineHeightValue", "1.8");
  await saved(page); await page.reload(); await text.waitFor();
  const rich = (await app.store.get(deck.id)).state.patches["a-text"].richText;
  assert.equal(rich.paragraphs[0].runs[0].bold, true);
  assert.equal(rich.paragraphs[0].align, "center"); assert.equal(rich.paragraphs[0].list, "bullet");
  assert.equal(rich.paragraphs[0].indent, 1); assert.equal(rich.paragraphs[0].lineHeight, 1.8);
  await text.click(); await page.locator("#italicTextBtn").click(); await saved(page);
  const undoSave = page.waitForResponse(r => r.url().endsWith("/save") && r.request().method() === "POST");
  await page.locator("#undoBtn").click(); await undoSave; await text.waitFor();
  await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨"));
  assert.equal((await app.store.get(deck.id)).state.patches["a-text"].richText.paragraphs[0].runs[0].italic, false);
}));

test("a selection survives toolbar focus and only selected letters gain style across save and duplication", () => fixture(async ({ app, deck, page, frame, text }) => {
  await text.dblclick(); await selectRange(text, 3, 8);
  await page.locator("#boldTextBtn").click(); await saved(page);
  let rich = (await app.store.get(deck.id)).state.patches["a-text"].richText;
  assert.deepEqual(rich.paragraphs[0].runs.map(r => [r.text, r.bold]), [["한글 ", false], ["Alpha", true], [" Beta", false]]);
  await page.locator("#underlineTextBtn").click(); await saved(page);
  rich = (await app.store.get(deck.id)).state.patches["a-text"].richText;
  assert.equal(rich.paragraphs[0].runs[1].underline, true); assert.equal(rich.paragraphs[0].runs[0].underline, false);
  await clickEditorTool(page, 'duplicateObjectsBtn');
  await frame.locator('[data-sd-added="true"]').nth(1).waitFor(); await saved(page);
  const added = (await app.store.get(deck.id)).state.added;
  assert.deepEqual(added[1].richText, rich);
  await page.reload(); await text.waitFor(); assert.equal(await text.locator('[data-sd-run]').count(), 3);
}));

test("IME composition finishes before toolbar formatting and keeps the final Korean syllable", () => fixture(async ({ app, deck, page, text }) => {
  await text.dblclick();
  await text.dispatchEvent("compositionstart");
  await text.evaluate(el => { el.textContent = "한글 완성 중"; el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true })); });
  await page.locator("#boldTextBtn").click();
  await text.evaluate(el => { el.textContent = "한글 완성 끝"; el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "끝" })); });
  await page.waitForFunction(() => document.querySelector("#boldTextBtn").getAttribute("aria-pressed") === "true"); await saved(page);
  const p = (await app.store.get(deck.id)).state.patches["a-text"];
  assert.equal(p.text, "한글 완성 끝"); assert.equal(p.richText.paragraphs[0].runs[0].bold, true);
  await page.reload(); await text.waitFor(); assert.equal(await text.textContent(), "한글 완성 끝");
}));

test("autofit shrinks display without rewriting saved font sizes and vertical alignment stays inside the box", () => fixture(async ({ app, deck, page, text }) => {
  await text.click(); await change(page, "textValue", "긴 문장을 여러 번 적어 상자 안의 크기를 확인합니다. ".repeat(5));
  await change(page, "wValue", "400"); await change(page, "hValue", "180");
  await setting(page, "textAutoFitValue", control => control.selectOption("shrink")); await saved(page);
  await text.evaluate(el => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.ok(await text.evaluate(el => Number(el.dataset.sdFontScale) < 1));
  assert.equal((await app.store.get(deck.id)).state.patches["a-text"].richText.paragraphs[0].runs[0].fontSize, 48);
  await change(page, "textValue", "짧은 글");
  await setting(page, "verticalAlignValue", control => control.selectOption("bottom")); await saved(page);
  const space = await text.evaluate(el => { const a = el.getBoundingClientRect(), b = el.querySelector("[data-sd-text-content]").getBoundingClientRect(); return { top: b.top - a.top, bottom: a.bottom - b.bottom }; });
  assert.ok(space.top > 10); assert.ok(Math.abs(space.bottom) < 2);
  await page.reload(); await text.waitFor(); assert.equal(await text.evaluate(el => Number(el.dataset.sdFontScale)), 1);
}));

test("native typing keeps paragraphs, empty lines and emoji after leaving the editor", () => fixture(async ({ app, deck, page, text }) => {
  await text.dblclick(); await page.keyboard.press("Control+a"); await page.keyboard.insertText("첫 줄 😀");
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.insertText("마지막 줄");
  await page.locator("#boldTextBtn").click(); await saved(page);
  const p = (await app.store.get(deck.id)).state.patches["a-text"];
  assert.equal(p.text, "첫 줄 😀\n\n마지막 줄");
  assert.equal(p.richText.paragraphs.length, 3);
  await page.reload(); await text.waitFor();
  assert.deepEqual(await text.locator("[data-sd-paragraph]").allTextContents(), ["첫 줄 😀", "", "마지막 줄"]);
}));

test("plain text paste discards HTML and long text remains within the documented character limit", () => fixture(async ({ app, deck, page, text }) => {
  await text.dblclick(); await page.keyboard.press("Control+a");
  await text.evaluate(el => {
    const data = new DataTransfer(); data.setData("text/plain", "안전한 붙여넣기\n둘째 줄");
    data.setData("text/html", '<img src="invalid" onerror="alert(1)"><b>다른 내용</b>');
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await page.locator("#italicTextBtn").click(); await saved(page);
  assert.equal((await app.store.get(deck.id)).state.patches["a-text"].text, "안전한 붙여넣기\n둘째 줄");
  assert.equal(await text.locator("img").count(), 0);
  await change(page, "textValue", "긴".repeat(25000)); await saved(page);
  const p = (await app.store.get(deck.id)).state.patches["a-text"];
  assert.equal(p.text.length, 25000); assert.equal(p.richText.paragraphs[0].runs.length, 1);
}));

test("a caret in an empty paragraph edits and formats that paragraph only", () => fixture(async ({ app, deck, page, text }) => {
  await text.click(); await change(page, "textValue", "첫째\n\n셋째"); await saved(page);
  await text.dblclick();
  await text.evaluate(el => el.ownerDocument.defaultView.SDTextEditor.restore(el, { start: 3, end: 3 }));
  await page.keyboard.insertText("둘째");
  await setting(page, "textAlignValue", control => control.selectOption("right")); await saved(page);
  const p = (await app.store.get(deck.id)).state.patches["a-text"];
  assert.equal(p.text, "첫째\n둘째\n셋째");
  assert.deepEqual(p.richText.paragraphs.map(p => p.align), ["left", "right", "left"]);
}));

test("format buttons reflect and toggle a range that starts exactly at a run boundary", () => fixture(async ({ app, deck, page, text }) => {
  await text.dblclick(); await selectRange(text, 3, 8);
  await page.locator("#boldTextBtn").click(); await saved(page);
  assert.equal(await page.locator("#boldTextBtn").getAttribute("aria-pressed"), "true");
  await page.locator("#boldTextBtn").click(); await saved(page);
  const p = (await app.store.get(deck.id)).state.patches["a-text"];
  assert.equal(p.richText.paragraphs[0].runs.length, 1);
  assert.equal(p.richText.paragraphs[0].runs[0].bold, false);
}));

test("pasting into an autofit box preserves logical font sizes", () => fixture(async ({ app, deck, page, text }) => {
  await text.click(); await change(page, "textValue", "자동 축소 텍스트 ".repeat(20)); await saved(page);
  await change(page, "wValue", "400"); await change(page, "hValue", "180");
  await setting(page, "textAutoFitValue", control => control.selectOption("shrink")); await saved(page);
  assert.ok(Number(await text.getAttribute("data-sd-font-scale")) < 1);
  await text.dblclick(); await page.keyboard.press("Control+End");
  await text.evaluate(el => {
    const data = new DataTransfer(); data.setData("text/plain", "추가");
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await page.locator("#boldTextBtn").click(); await saved(page);
  const p = (await app.store.get(deck.id)).state.patches["a-text"];
  assert.equal(p.text.endsWith("추가"), true);
  for (const run of p.richText.paragraphs[0].runs) assert.ok(Math.abs(run.fontSize - 48) < 0.02);
}));

test("converting original nested text preserves its propagated underline", () => fixture(async ({ app, deck, page, frame }) => {
  const title = frame.locator('[data-sd-id="e0"]');
  await title.evaluate(el => { el.style.textDecoration = "underline"; });
  await title.click(); await page.locator("#italicTextBtn").click(); await saved(page);
  const rich = (await app.store.get(deck.id)).state.patches.e0.richText;
  assert.equal(rich.paragraphs[0].runs.length, 2);
  assert.equal(rich.paragraphs[0].runs.every(run => run.underline), true);
  await page.reload(); await title.waitFor();
  assert.equal(await title.locator("[data-sd-run]").evaluateAll(nodes => nodes.every(n => getComputedStyle(n).textDecorationLine.includes("underline"))), true);
}));

test("Shift+Enter creates a soft line break inside the current paragraph", () => fixture(async ({ app, deck, page, text }) => {
  await text.dblclick(); await page.keyboard.press("Control+a"); await page.keyboard.insertText("첫 줄");
  await page.keyboard.press("Shift+Enter"); await page.keyboard.insertText("같은 문단");
  await setting(page, "listStyleValue", control => control.selectOption("number")); await saved(page);
  const p = (await app.store.get(deck.id)).state.patches["a-text"];
  assert.equal(p.text, "첫 줄\n같은 문단");
  assert.equal(p.richText.paragraphs.length, 1);
  assert.equal(await text.locator("[data-sd-marker]").count(), 1);
}));

test("converting original inline runs preserves collapsed spaces and nonbreaking spaces", () => fixture(async ({ app, deck, page, frame }) => {
  const title = frame.locator('[data-sd-id="e0"]');
  await title.evaluate(el => { el.innerHTML = 'foo <b> bar</b>   baz&nbsp;X'; });
  const original = await title.innerText();
  await title.click(); await page.locator("#italicTextBtn").click(); await saved(page);
  assert.equal((await app.store.get(deck.id)).state.patches.e0.text, original);
  assert.equal(await title.innerText(), original);
}));

async function savedKey(page, key) {
  const source = await page.locator("#deckFrame").getAttribute("src");
  const response = page.waitForResponse(r => r.url().endsWith("/save") && r.request().method() === "POST");
  await page.keyboard.press(key);
  await response;
  await saved(page);
  if (/[zy]$/i.test(key)) {
    // Saving an undo/redo precedes iframe replacement; the previous element can
    // still be visible and would send its now-stale editor session if reused.
    await page.waitForFunction(previous => document.querySelector("#deckFrame").getAttribute("src") !== previous, source);
    const frame = await (await page.$("#deckFrame")).contentFrame();
    await frame.waitForURL(url => url.href !== source, { waitUntil: "domcontentloaded" });
  }
}
async function boldMiddleLetter(page, text) {
  await text.click(); await change(page, "textValue", "ABC"); await saved(page);
  await text.dblclick(); await selectRange(text, 1, 2);
  await savedKey(page, "Control+b");
}

test("keyboard formatting undo and redo reach app history while text editing is active", () => fixture(async ({ app, deck, page, text }) => {
  await boldMiddleLetter(page, text);
  assert.equal(await text.getAttribute("contenteditable"), "true");
  await savedKey(page, "Control+z"); await text.waitFor();
  let rich = (await app.store.get(deck.id)).state.patches["a-text"].richText;
  assert.equal(rich.paragraphs[0].runs.every(run => run.bold === false), true);
  assert.equal(await text.textContent(), "ABC");
  await text.dblclick(); await savedKey(page, "Control+Shift+z"); await text.waitFor();
  rich = (await app.store.get(deck.id)).state.patches["a-text"].richText;
  assert.deepEqual(rich.paragraphs[0].runs.map(run => [run.text, run.bold]), [["A", false], ["B", true], ["C", false]]);
  await text.dblclick(); await savedKey(page, "Control+z"); await text.waitFor();
  await text.dblclick(); await savedKey(page, "Control+y"); await text.waitFor();
  rich = (await app.store.get(deck.id)).state.patches["a-text"].richText;
  assert.equal(rich.paragraphs[0].runs[1].bold, true);
}));

test("native typing undo and redo stay native until the formatting boundary is reached", () => fixture(async ({ app, deck, page, text }) => {
  await boldMiddleLetter(page, text);
  const formattedRevision = (await app.store.get(deck.id)).revision;
  await selectRange(text, 2, 2); await page.keyboard.insertText("x");
  assert.equal(await text.textContent(), "ABxC");
  await page.keyboard.press("Control+z");
  assert.equal(await text.textContent(), "ABC");
  assert.equal(await text.getAttribute("contenteditable"), "true");
  await page.keyboard.press("Control+Shift+z");
  assert.equal(await text.textContent(), "ABxC");
  await page.keyboard.press("Control+z");
  assert.equal(await text.textContent(), "ABC");
  assert.equal((await app.store.get(deck.id)).revision, formattedRevision);
  await savedKey(page, "Control+z"); await text.waitFor();
  const rich = (await app.store.get(deck.id)).state.patches["a-text"].richText;
  assert.equal(rich.paragraphs[0].runs.every(run => run.bold === false), true);
}));

test("typing and deleting back to the same text still undoes the native deletion first", () => fixture(async ({ app, deck, page, text }) => {
  await boldMiddleLetter(page, text);
  await selectRange(text, 2, 2); await page.keyboard.insertText("x");
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Backspace");
  assert.equal(await text.textContent(), "ABC");
  await page.keyboard.press("Control+z");
  assert.equal(await text.textContent(), "ABxC");
  assert.equal(await text.getAttribute("contenteditable"), "true");
  await page.keyboard.press("Control+z");
  assert.equal(await text.textContent(), "ABC");
  await savedKey(page, "Control+z");
  const rich = (await app.store.get(deck.id)).state.patches["a-text"].richText;
  assert.equal(rich.paragraphs[0].runs.every(run => run.bold === false), true);
}));

test("plain-text paste undo restores the pre-paste session after native typing undo", () => fixture(async ({ app, deck, page, text }) => {
  await boldMiddleLetter(page, text);
  await selectRange(text, 1, 2);
  await text.evaluate(el => {
    const data = new DataTransfer(); data.setData("text/plain", "붙임");
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  assert.equal(await text.textContent(), "A붙임C");
  await page.keyboard.insertText("x");
  assert.equal(await text.textContent(), "A붙임xC");
  await page.keyboard.press("Control+z");
  assert.equal(await text.textContent(), "A붙임C");
  await savedKey(page, "Control+z"); await text.waitFor();
  const patch = (await app.store.get(deck.id)).state.patches["a-text"];
  assert.equal(patch.text, "ABC");
  assert.deepEqual(patch.richText.paragraphs[0].runs.map(run => [run.text, run.bold]), [["A", false], ["B", true], ["C", false]]);
}));

test("omitted run sizes inherit the text box font and copied text resolves inherited styles", () => fixture(async ({ app, deck, page, text, frame }) => {
  await text.evaluate(el => {
    el.style.textDecoration = "underline";
    el.ownerDocument.defaultView.SDTextEditor.render(el, { paragraphs: [{ runs: [{ text: "첫째", fontSize: 64 }, { text: "둘째" }] }] }, {});
  });
  const sizes = await text.evaluate(el => ({
    rendered: [...el.querySelectorAll("[data-sd-run]")].map(run => Number.parseFloat(getComputedStyle(run).fontSize)),
    resolved: el.ownerDocument.defaultView.SDTextEditor.resolve(el).paragraphs[0].runs.map(run => run.fontSize),
  }));
  assert.deepEqual(sizes.rendered, [64, 48]);
  assert.deepEqual(sizes.resolved, [64, 48]);
  await text.click(); await clickEditorTool(page, 'duplicateObjectsBtn');
  await frame.locator('[data-sd-added="true"]').nth(1).waitFor(); await saved(page);
  const runs = (await app.store.get(deck.id)).state.added[1].richText.paragraphs[0].runs;
  assert.deepEqual(runs.map(run => run.fontSize), [64, 48]);
  assert.equal(runs.every(run => run.underline === true), true);
}));
