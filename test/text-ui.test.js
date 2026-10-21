import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
import { importArchive } from "../src/archive.js";

// The controlled frame isolates the parent command boundary from editor implementation.
const frameDocument = `<!doctype html><html><body><script>
window.commands = [];
window.autoSettle = true;
window.autoTextResult = true;
window.reply = data => parent.postMessage({ studio: true, editorSession: new URLSearchParams(location.search).get("editorSession"), ...data }, "*");
addEventListener("message", event => {
  if (!event.data?.studio) return;
  commands.push(event.data);
  if (event.data.type === "commit-edit" && autoSettle) reply({ type: "edit-settled", requestId: event.data.requestId });
  if (["text-format", "text-replace"].includes(event.data.type) && autoTextResult) reply({ type: "text-command-result", requestId: event.data.requestId });
});
reply({ type: "ready" });
</script></body></html>`;
const info = (id = "e0", extra = {}) => ({
  id, tag: "h1", text: "한글 text", x: 0, y: 0, w: 300, h: 100, rotate: 0,
  color: "#ffffff", fill: "#000000", fontSize: 40, textEditable: true, textEditing: false,
  textStyle: { fontFamily: "Arial", fontSize: 32, color: "#123456", bold: true, italic: false, underline: true, align: "center", lineHeight: 1.5, spaceAfter: 12, indent: 2, list: "bullet" },
  textBox: { vertical: "middle", overflow: "clip", autoFit: "shrink" },
  textRange: null, textOverflowing: false, ...extra,
});
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "studio-text-ui-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const zip = new JSZip();
    zip.file("index.html", '<html><head><title>Text</title></head><body><main id="stage"><section class="slide"><h1>제목</h1><p>본문</p></section></main></body></html>');
    const deck = await app.store.create(await importArchive(await zip.generateAsync({ type: "nodebuffer" })));
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(5000);
    await page.route(url => url.searchParams.get("mode") === "edit", route => route.fulfill({ contentType: "text/html", body: frameDocument }));
    await page.goto(app.origin + "/#deck=" + deck.id);
    await page.waitForSelector("#editor:not([hidden])");
    const frame = await (await page.$("#deckFrame")).contentFrame();
    await frame.waitForFunction(() => window.commands?.some(item => item.type === "go"));
    const send = async data => { await frame.evaluate(data => window.reply(data), data); await page.waitForTimeout(30); };
    const select = selected => send({ type: "select", slide: "s0", elements: Array.isArray(selected) ? selected : [selected] });
    const commands = () => frame.evaluate(() => commands.filter(item => ["text-format", "text-replace", "patch"].includes(item.type)));
    const change = async (id, value, wait = true) => {
      if (wait) await page.waitForFunction(() => document.querySelector("#saveStatus").textContent !== "서식 적용 중…");
      await page.locator("#" + id).evaluate((control, value) => { control.value = value; control.dispatchEvent(new Event("change", { bubbles: true })); }, value);
      if (wait) await page.waitForFunction(() => document.querySelector("#saveStatus").textContent !== "서식 적용 중…");
    };
    await fn({ app, deck, page, frame, send, select, commands, change });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}

test("text inspector reflects current run, paragraph, box and selected range", () => fixture(async ({ page, select }) => {
  await select(info("e0", { textEditing: true, textRange: { start: 1, end: 4 }, textOverflowing: true }));
  assert.equal(await page.locator("#fontValue").inputValue(), "32");
  assert.equal(await page.locator("#colorValue").inputValue(), "#123456");
  assert.equal(await page.locator("#fontFamilyValue").inputValue(), "Arial");
  for (const [id, value] of [["boldTextBtn", "true"], ["italicTextBtn", "false"], ["underlineTextBtn", "true"]])
    assert.equal(await page.locator("#" + id).getAttribute("aria-pressed"), value);
  for (const [id, value] of [["textAlignValue", "center"], ["lineHeightValue", "1.5"], ["spaceAfterValue", "12"], ["listStyleValue", "bullet"], ["verticalAlignValue", "middle"], ["textOverflowValue", "clip"], ["textAutoFitValue", "shrink"]])
    assert.equal(await page.locator("#" + id).inputValue(), value);
  assert.match(await page.locator("#textRangeLabel").textContent(), /선택한 문자/);
  assert.equal(await page.locator("#textOverflowNote").isVisible(), true);
  await select(info());
  assert.match(await page.locator("#textRangeLabel").textContent(), /전체/);
  assert.equal(await page.locator("#textOverflowNote").isHidden(), true);
  await select(info("e0", { textEditing: true, textRange: { start: 2, end: 2 } }));
  assert.match(await page.locator("#textRangeLabel").textContent(), /선택한 글자가 없으면 전체 텍스트/);
}));

test("character controls emit settled formatting commands without prematurely changing saved state", () => fixture(async ({ app, deck, page, select, commands, change }) => {
  await select(info());
  await change("fontValue", "44");
  await change("colorValue", "#abcdef");
  await change("fontFamilyValue", "Noto Sans KR");
  await page.locator("#boldTextBtn").click();
  await page.locator("#italicTextBtn").click();
  await page.locator("#underlineTextBtn").click();
  await change("textValue", "새 내용\n둘째 문단");
  await page.waitForTimeout(50);
  const sent = (await commands()).map(({ type, id, scope, changes, text }) => ({ type, id, ...(scope ? { scope, changes } : { text }) }));
  assert.deepEqual(sent, [
    { type: "text-format", id: "e0", scope: "character", changes: { fontSize: 44 } },
    { type: "text-format", id: "e0", scope: "character", changes: { color: "#abcdef" } },
    { type: "text-format", id: "e0", scope: "character", changes: { fontFamily: "Noto Sans KR" } },
    { type: "text-format", id: "e0", scope: "character", changes: { bold: false } },
    { type: "text-format", id: "e0", scope: "character", changes: { italic: true } },
    { type: "text-format", id: "e0", scope: "character", changes: { underline: false } },
    { type: "text-replace", id: "e0", text: "새 내용\n둘째 문단" },
  ]);
  await page.waitForTimeout(700);
  const saved = await app.store.get(deck.id);
  assert.equal(saved.revision, deck.revision);
  assert.equal(saved.state.patches.e0, undefined);
}));

test("paragraph and box controls preserve their command scopes and indentation limits", () => fixture(async ({ page, select, commands, change }) => {
  await select(info());
  for (const [id, value] of [["textAlignValue", "justify"], ["lineHeightValue", "2"], ["spaceAfterValue", "18"], ["listStyleValue", "number"], ["verticalAlignValue", "bottom"], ["textOverflowValue", "visible"], ["textAutoFitValue", "none"]]) await change(id, value);
  await page.locator("#indentTextBtn").click();
  await page.locator("#outdentTextBtn").click();
  await page.waitForTimeout(50);
  assert.deepEqual((await commands()).map(({ scope, changes }) => ({ scope, changes })), [
    { scope: "paragraph", changes: { align: "justify" } },
    { scope: "paragraph", changes: { lineHeight: 2 } },
    { scope: "paragraph", changes: { spaceAfter: 18 } },
    { scope: "paragraph", changes: { list: "number" } },
    { scope: "box", changes: { vertical: "bottom" } },
    { scope: "box", changes: { overflow: "visible" } },
    { scope: "box", changes: { autoFit: "none" } },
    { scope: "paragraph", changes: { indent: 3 } },
    { scope: "paragraph", changes: { indent: 1 } },
  ]);
  await select(info("e0", { textStyle: { ...info().textStyle, indent: 8 } }));
  assert.equal(await page.locator("#indentTextBtn").isDisabled(), true);
  await select(info("e0", { textStyle: { ...info().textStyle, indent: 0 } }));
  assert.equal(await page.locator("#outdentTextBtn").isDisabled(), true);
}));

test("text command captures numeric value before an IME settle refresh and cancels a changed target", () => fixture(async ({ page, frame, send, select, commands, change }) => {
  await select(info());
  await frame.evaluate(() => { window.autoSettle = false; });
  await change("fontValue", "52", false);
  await frame.waitForFunction(() => commands.some(item => item.type === "commit-edit"));
  assert.equal((await commands()).length, 0);
  await select(info());
  await frame.evaluate(() => reply({ type: "edit-settled", requestId: commands.findLast(item => item.type === "commit-edit").requestId }));
  await page.waitForTimeout(50);
  assert.equal((await commands())[0].changes.fontSize, 52);
  await change("lineHeightValue", "2.5", false);
  await select(info("e1"));
  await frame.evaluate(() => reply({ type: "edit-settled", requestId: commands.findLast(item => item.type === "commit-edit").requestId }));
  await page.waitForTimeout(50);
  assert.equal((await commands()).length, 1);
  assert.equal(await page.locator("#fontValue").isEnabled(), true);
}));

test("locked, compound and multiple selections disable all text mutation paths", () => fixture(async ({ page, select, commands, change }) => {
  for (const selection of [info("e0", { locked: true }), info("e0", { textEditable: false }), [info(), info("e1")]]) {
    await select(selection);
    for (const id of ["textValue", "fontValue", "colorValue", "fontFamilyValue", "boldTextBtn", "textAlignValue", "textAutoFitValue"])
      assert.equal(await page.locator("#" + id).isDisabled(), true, id);
    await change("textValue", "보호된 내용");
    await change("fontValue", "99");
    await page.locator("#boldTextBtn").evaluate(control => control.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }
  await page.waitForTimeout(50);
  assert.deepEqual(await commands(), []);
}));

test("numeric text controls accept fractional spacing and reject out-of-range values", () => fixture(async ({ page, select, commands, change }) => {
  await select(info());
  await change("lineHeightValue", "1.25");
  await page.waitForTimeout(30);
  assert.deepEqual((await commands()).map(({ changes }) => changes), [{ lineHeight: 1.25 }]);
  for (const [id, value] of [["fontValue", "401"], ["lineHeightValue", "0.4"], ["spaceAfterValue", "201"], ["fontValue", ""]]) await change(id, value);
  await page.waitForTimeout(30);
  assert.equal((await commands()).length, 1);
}));

test("text controls stay busy until the matching command result and preserve the actual save status", () => fixture(async ({ app, deck, page, frame, send, select, commands, change }) => {
  await select(info());
  await frame.evaluate(() => { window.autoSettle = false; window.autoTextResult = false; });
  await change("fontValue", "52", false);
  assert.equal(await page.locator("#saveStatus").textContent(), "서식 적용 중…");
  assert.equal(await page.locator("#fontValue").isDisabled(), true);
  assert.equal(await page.locator("#textValue").isDisabled(), true);
  assert.equal(await page.locator("#xValue").isEnabled(), true);
  await frame.waitForFunction(() => commands.some(item => item.type === "commit-edit"));
  await frame.evaluate(() => reply({ type: "edit-settled", requestId: commands.findLast(item => item.type === "commit-edit").requestId }));
  await frame.waitForFunction(() => commands.some(item => item.type === "text-format"));
  const request = (await commands())[0];
  assert.equal(typeof request.requestId, "string");
  await change("colorValue", "#abcdef", false);
  await send({ type: "text-command-result", requestId: "wrong-request" });
  await send({ type: "text-command-result", requestId: request.requestId, editorSession: "old-session" });
  assert.equal(await page.locator("#fontValue").isDisabled(), true);
  assert.equal((await commands()).length, 1);
  await send({ type: "change", slide: "s0", id: "e0", patch: { text: "확정된 내용" } });
  await send({ type: "text-command-result", requestId: request.requestId });
  assert.equal(await page.locator("#fontValue").isEnabled(), true);
  assert.notEqual(await page.locator("#saveStatus").textContent(), "서식 적용 중…");
  await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.includes("저장됨"));
  assert.equal((await app.store.get(deck.id)).state.patches.e0.text, "확정된 내용");
}));

test("no-op, rejected and timed-out text commands restore controls and the prior save status", () => fixture(async ({ page, frame, send, select, commands, change }) => {
  await select(info());
  const previousStatus = await page.locator("#saveStatus").textContent();
  await change("fontValue", "32");
  assert.equal(await page.locator("#saveStatus").textContent(), previousStatus);
  await frame.evaluate(() => { window.autoTextResult = false; });
  await change("fontValue", "52", false);
  await frame.waitForFunction(() => commands.filter(item => item.type === "text-format").length === 2);
  await send({ type: "text-command-result", requestId: (await commands())[1].requestId, error: "서식 적용을 거절했습니다." });
  assert.equal(await page.locator("#fontValue").isEnabled(), true);
  assert.equal(await page.locator("#saveStatus").textContent(), previousStatus);
  assert.match(await page.locator("#toast").textContent(), /서식 적용을 거절/);
  await change("fontValue", "53", false);
  await page.waitForFunction(() => !document.querySelector("#fontValue").disabled);
  assert.equal(await page.locator("#saveStatus").textContent(), previousStatus);
  assert.match(await page.locator("#toast").textContent(), /서식.*확인/);
}));

test("changing the selected target cancels a pending result and ignores its late rejection", () => fixture(async ({ page, frame, send, select, commands, change }) => {
  await select(info());
  await frame.evaluate(() => { window.autoTextResult = false; });
  const previousStatus = await page.locator("#saveStatus").textContent();
  await change("fontValue", "52", false);
  await frame.waitForFunction(() => commands.some(item => item.type === "text-format"));
  const requestId = (await commands())[0].requestId;
  await select(info("e1"));
  assert.equal(await page.locator("#fontValue").isEnabled(), true);
  assert.equal(await page.locator("#saveStatus").textContent(), previousStatus);
  await send({ type: "text-command-result", requestId, error: "오래된 명령" });
  assert.equal(await page.locator("#toast").isHidden(), true);
}));

test("undo reports pending immediately while input settles and only returns saved after the undo save", () => fixture(async ({ app, deck, page, frame, send }) => {
  await send({ type: "change", slide: "s0", id: "e0", patch: { text: "실행 취소할 내용" } });
  await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨"));
  await frame.evaluate(() => { window.autoSettle = false; });
  await page.locator("#undoBtn").click();
  assert.equal(await page.locator("#saveStatus").textContent(), "실행 취소 중…");
  assert.equal(await page.locator("#undoBtn").isDisabled(), true);
  assert.equal(await page.locator("#sceneValue").isDisabled(), true);
  await frame.waitForFunction(() => commands.some(item => item.type === "commit-edit"));
  const undone = page.waitForResponse(response => response.url().endsWith("/save") && response.request().method() === "POST");
  await frame.evaluate(() => reply({ type: "edit-settled", requestId: commands.findLast(item => item.type === "commit-edit").requestId }));
  await undone;
  await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨"));
  assert.equal((await app.store.get(deck.id)).state.patches.e0, undefined);
  assert.equal(await page.locator("#undoBtn").isEnabled(), true);
}));
