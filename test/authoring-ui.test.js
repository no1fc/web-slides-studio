import { clickEditorTool, openRibbonTab } from './editor-ui-helpers.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
+
test("code duplication preserves class selectors and CSS string literals", () => fixture(async (app, p, frame) => {
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'codeBtn');
  await p.locator("#codeHtml").fill('<h1 data-sd-id="e0" class="e0">선택자 구분</h1>');
  await p.locator("#codeCss").fill('.e0{color:red} [data-sd-id="e0"]{font-size:64px} .e0::after{content:\'[data-sd-id="e0"]\'}');
  await p.locator("#codeApplyBtn").click();
  await p.locator("#dialog").waitFor({state:"hidden"});
  await clickEditorTool(p, 'duplicateSlideBtn');
  await p.waitForFunction(() => frameReady && !transitionBusy && document.querySelectorAll("#slideList .slide-item").length === 2);
  await frame().locator(".slide.active h1").waitFor();
  assert.equal(await frame().locator(".slide.active h1").evaluate(e=>getComputedStyle(e).color), "rgb(255, 0, 0)");
  const d = await current(app), css=d.state.slideCode[d.state.order[1]].css;
  assert.match(css, /\.e0\{/);
  assert.ok(css.includes("content:'[data-sd-id=\"e0\"]'"));
}));

+
test("switching masters can be cancelled without discarding unsaved code", () => fixture(async (app, p) => {
  await openRibbonTab(p, 'slide');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'masterBtn');
  await p.locator("#masterSaveBtn").click();
  await p.locator("#dialog").waitFor({state:"hidden"});
  await openRibbonTab(p, 'slide');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'masterBtn');
  await p.locator("#masterHtml").waitFor({state:"visible"});
  const selected = await p.locator("#masterSelect").inputValue();
  await p.locator("#masterHtml").fill("<p>작성 중인 마스터</p>");
  p.once("dialog", dialog => dialog.dismiss());
  await p.locator("#masterSelect").selectOption("");
  assert.equal(await p.locator("#masterSelect").inputValue(), selected);
  assert.equal(await p.locator("#masterHtml").inputValue(), "<p>작성 중인 마스터</p>");
}));

+
test("failed source saves can be reopened and corrected without losing the draft", () => fixture(async (app, p) => {
  p.on("dialog", dialog => dialog.accept());
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'codeBtn');
  await p.locator("#codeHtml").fill('<h1>보존할 제목</h1><img src="missing.png">');
  await p.locator("#codeApplyBtn").click();
  await p.waitForFunction(() => document.getElementById("codeError").textContent.length > 0);
  await p.locator("#closeDialog").click();
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'codeBtn');
  await p.locator("#codeHtml").waitFor({state:"visible"});
  assert.match(await p.locator("#codeHtml").inputValue(), /missing.png/);
  await p.locator("#codeHtml").fill("<h1>보존할 제목</h1>");
  await p.locator("#codeApplyBtn").click();
  await p.locator("#dialog").waitFor({state:"hidden"});
  await saved(p);
  assert.match((await current(app)).state.slideCode.s0.html, /보존할 제목/);
}));
test("duplicating a code slide remaps CSS references to editable element IDs", () => fixture(async (app, p, frame) => {
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'codeBtn');
  await p.locator("#codeHtml").fill('<h1 data-sd-id="c-s0--e0">색상 유지</h1>');
  await p.locator("#codeCss").fill('[data-sd-id="c-s0--e0"]{color:rgb(255,0,0)}');
  await p.locator("#codeApplyBtn").click();
  await p.locator("#dialog").waitFor({state:"hidden"});
  await clickEditorTool(p, 'duplicateSlideBtn');
  await p.waitForFunction(() => frameReady && !transitionBusy && document.querySelectorAll("#slideList .slide-item").length === 2);
  await frame().locator(".slide.active h1").filter({hasText:"색상 유지"}).waitFor();
  assert.equal(await frame().locator(".slide.active h1").evaluate(e=>getComputedStyle(e).color), "rgb(255, 0, 0)");
}));


async function fixture(fn) {
  const app = await startStudio({ root: await mkdtemp(join(tmpdir(), "studio-authoring-ui-")), port: 0, contentPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    const p = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
    p.setDefaultTimeout(5000);
    await p.goto(app.origin);
    await p.locator("#newBtn").click();
    await p.waitForSelector("#slideList .slide-item");
    await fn(app, p, () => p.frameLocator("#deckFrame"));
  } finally { await browser.close(); await app.close(); }
}
async function saved(p) {
  await p.waitForFunction(() => frameReady && !transitionBusy && !dirty && !saving && document.getElementById("saveStatus").textContent.startsWith("저장됨"));
}
async function current(app) {
  return app.store.get((await app.store.list())[0].id);
}
test("HTML/CSS and JSON editors validate drafts, persist changes, and support undo", () => fixture(async (app, p, frame) => {
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'codeBtn');
  await p.locator("#codeHtml").fill('<h1 class="custom-title">코드 제목</h1>');
  await p.locator("#codeCss").fill(".custom-title {color:#ff0000;font-size:64px}");
  await p.locator("#codeApplyBtn").click();
  await p.waitForSelector("#dialog", { state: "hidden" });
  await saved(p);
  await p.waitForFunction(() => document.getElementById("deckFrame").src.includes("mode=edit"));
  await frame().locator(".slide.active .custom-title").waitFor();
  assert.equal(await frame().locator(".custom-title").evaluate(e => getComputedStyle(e).color), "rgb(255, 0, 0)");
  let d = await current(app);
  assert.match(d.state.slideCode.s0.html, /코드 제목/);
  const codeId = /data-sd-id="([^"]+)"/.exec(d.state.slideCode.s0.html)[1];
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await p.locator("#jsonBtn").click();
  const draft = JSON.parse(await p.locator("#jsonState").inputValue());
  draft.unknownFeature = true;
  await p.locator("#jsonState").fill(JSON.stringify(draft));
  await p.locator("#jsonApplyBtn").click();
  await p.waitForFunction(() => document.getElementById("jsonError").textContent.length > 0);
  assert.equal((await current(app)).revision, d.revision);
  delete draft.unknownFeature;
  draft.patches[codeId] = { text: "JSON 수정", x: 25 };
  await p.locator("#jsonState").fill(JSON.stringify(draft));
  await p.locator("#jsonApplyBtn").click();
  await p.waitForSelector("#dialog", { state: "hidden" });
  await saved(p);
  await p.reload();
  await p.waitForSelector("#slideList .slide-item");
  await frame().locator(".slide.active h1").filter({ hasText: "JSON 수정" }).waitFor();
  d = await current(app);
  assert.equal(d.state.patches[codeId].x, 25);
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'codeBtn');
  await p.locator("#codeHtml").fill("<script>alert(1)</script>");
  await p.locator("#codeApplyBtn").click();
  await p.waitForFunction(() => document.getElementById("codeError").textContent.length > 0);
  assert.match(await p.locator("#codeHtml").inputValue(), /script/);
  assert.equal((await current(app)).revision, d.revision);
}));
test("master templates propagate and survive code-slide duplication and undo", () => fixture(async (app, p, frame) => {
  await openRibbonTab(p, 'file');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'codeBtn');
  await p.locator("#layoutPreset").selectOption("two-column");
  await p.locator("#loadLayoutBtn").click();
  await p.locator("#codeApplyBtn").click();
  await p.waitForSelector("#dialog", { state: "hidden" });
  await saved(p);
  await openRibbonTab(p, 'slide');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'masterBtn');
  await p.locator("#masterName").fill("공통 브랜드");
  await p.locator("#masterHtml").fill('<div class="brand">SDLAB</div>');
  await p.locator("#masterCss").fill(".brand {position:absolute;top:10px;right:20px;color:#123456}");
  await p.locator("#masterSaveBtn").click();
  await p.waitForSelector("#dialog", { state: "hidden" });
  await saved(p);
  let d = await current(app);
  const masterId = d.state.slideMasters.s0;
  assert.equal(d.state.masters[masterId].name, "공통 브랜드");
  await clickEditorTool(p, 'duplicateSlideBtn');
  await p.waitForFunction(() => frameReady && !transitionBusy && document.querySelectorAll("#slideList .slide-item").length === 2);
  await saved(p);
  d = await current(app);
  const copied = d.state.order[1];
  assert.equal(d.state.slideMasters[copied], masterId);
  assert.ok(d.state.slideCode[copied]);
  assert.match(d.state.slideCode[copied].html, new RegExp("c-" + copied + "--"));
  await openRibbonTab(p, 'slide');
  await openRibbonTab(p, 'file');
  await p.locator("#advancedTools").evaluate(e => e.open = true);
  await clickEditorTool(p, 'masterBtn');
  await p.locator("#masterHtml").fill('<div class="brand">공통 수정</div>');
  await p.locator("#masterSaveBtn").click();
  await p.waitForSelector("#dialog", { state: "hidden" });
  await saved(p);
  await frame().locator(".slide.active .brand").filter({ hasText: "공통 수정" }).waitFor();
  await p.locator("#slideList .slide-item").first().click();
  await frame().locator(".slide.active .brand").filter({ hasText: "공통 수정" }).waitFor();
  await p.locator("#undoBtn").click();
  await saved(p);
  await frame().locator(".slide.active .brand").filter({ hasText: "SDLAB" }).waitFor();
}));
test("a delayed save response never overwrites later edits", () => fixture(async (app, p, frame) => {
  await frame().locator(".slide.active h1").click();
  let release;
  let intercepted;
  const seen = new Promise(resolve => { intercepted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  await p.route("**/api/decks/*/save", async route => {
    if (!first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch();
    intercepted();
    await gate;
    await route.fulfill({ response });
  });
  await openRibbonTab(p, 'format');
  await clickEditorTool(p, 'textContentSettingsBtn');
  await p.locator("#textValue").fill("먼저 저장");
  await p.locator("#textValue").dispatchEvent("change");
  await seen;
  await p.locator("#textValue").fill("나중 편집 유지");
  await p.locator("#textValue").dispatchEvent("change");
  release();
  await saved(p);
  assert.equal((await current(app)).state.patches.e0.text, "나중 편집 유지");
  await p.reload();
  await p.waitForSelector("#slideList .slide-item");
  await frame().locator(".slide.active h1").filter({ hasText: "나중 편집 유지" }).waitFor();
}));
