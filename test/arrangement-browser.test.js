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
  const root = await mkdtemp(join(tmpdir(), "studio-arrangement-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const z = new JSZip();
    z.file("index.html", `<!doctype html><html><head><title>배치 테스트</title><style>
      html,body{margin:0}main{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none}.slide.active{display:block}
      h1{position:absolute;left:100px;top:40px;width:500px;height:80px;margin:0;font-size:42px;color:rgb(10,100,90)}
      </style></head><body><main id="stage"><section class="slide"><h1>복제할 <strong>제목</strong></h1></section><section class="slide"><h1>둘째</h1></section></main></body></html>`);
    let deck = await app.store.create(await importArchive(await z.generateAsync({ type: "nodebuffer" })));
    deck.state.added.push(...[
      { id: "a-one", x: 100, y: 240, w: 120, h: 80 },
      { id: "a-two", x: 440, y: 350, w: 200, h: 100 },
      { id: "a-three", x: 1000, y: 510, w: 160, h: 120 },
    ].map(a => ({ ...a, slide: "s0", kind: "text", text: a.id, fontSize: 30, fill: "#cceee5" })));
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
    page.setDefaultTimeout(6000);
    await page.goto(app.origin + "/#deck=" + deck.id);
    const frame = page.frameLocator("#deckFrame");
    await frame.locator('[data-sd-id="a-one"]').waitFor();
    await page.evaluate(() => { window.messages = []; window.addEventListener("message", e => { if (e.data?.studio) window.messages.push(e.data); }); });
    await fn({ app, browser, page, frame, deck });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}
const item = (frame, id) => frame.locator(`[data-sd-id="${id}"]`);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1, `${a} ≈ ${b}`);
async function send(page, type, data = {}) { await page.evaluate(({ type, data }) => { const f = document.querySelector("#deckFrame"); f.contentWindow.postMessage({ studio: true, type, ...data }, new URL(f.src).origin); }, { type, data }); }
async function multi(frame, ids) { for (const [i, id] of ids.entries()) await item(frame, id).click({ modifiers: i ? ["Shift"] : [] }); }
async function waitChange(page, count = 1) { await page.waitForFunction(n => window.messages.filter(m => ["change", "batch-change"].includes(m.type)).length >= n, count); }
async function saved(page) { await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨")); }
async function position(frame, id) { return item(frame, id).evaluate(e => e.style.translate.split(" ").map(parseFloat)); }
async function undoReady(page, frame, id, x) {
  await page.locator("#undoBtn").click();
  const content = await (await page.$("#deckFrame")).contentFrame();
  await content.waitForFunction(({ id, x }) => { const e = document.querySelector(`[data-sd-id="${id}"]`); return e && parseFloat(e.style.translate) === x; }, { id, x });
}

test("shift selection drags all objects once and undo restores the whole command", () => fixture(async ({ page, frame }) => {
  await multi(frame, ["a-one", "a-two"]);
  assert.equal(await frame.locator(".sd-selected").count(), 2);
  const box = await item(frame, "a-one").boundingBox(), ss = await frame.locator(".slide.active").evaluate(e => e.getBoundingClientRect().width / 1920);
  await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 15 + 30 * ss, box.y + 15 + 20 * ss, { steps: 3 }); await page.mouse.up();
  await waitChange(page);
  assert.deepEqual(await position(frame, "a-one"), [130, 260]);
  assert.deepEqual(await position(frame, "a-two"), [470, 370]);
  const changes = await page.evaluate(() => window.messages.filter(m => m.type === "batch-change"));
  assert.equal(changes.length, 1); assert.equal(changes[0].changes.length, 2);
  await undoReady(page, frame, "a-one", 100);
  assert.deepEqual(await position(frame, "a-two"), [440, 350]);
}));

test("area selection, group keyboard and cancelled drag preserve every member", () => fixture(async ({ page, frame }) => {
  const slide = await frame.locator(".slide.active").boundingBox(), ss = slide.width / 1920;
  await page.mouse.move(slide.x + 80 * ss, slide.y + 220 * ss); await page.mouse.down();
  await page.mouse.move(slide.x + 660 * ss, slide.y + 470 * ss); await page.mouse.up();
  assert.equal(await frame.locator(".sd-selected").count(), 2);
  await page.keyboard.press("Shift+ArrowRight"); await waitChange(page);
  assert.deepEqual(await position(frame, "a-one"), [110, 240]);
  assert.deepEqual(await position(frame, "a-two"), [450, 350]);
  const box = await item(frame, "a-one").boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 50, box.y + 50); await page.keyboard.press("Escape"); await page.mouse.up();
  assert.deepEqual(await position(frame, "a-one"), [110, 240]);
  assert.deepEqual(await position(frame, "a-two"), [450, 350]);
  await page.locator("#slideList .slide-item").nth(1).click();
  await frame.locator('[data-sd-slide="s1"].active').waitFor();
  assert.equal(await frame.locator(".sd-selected").count(), 0);
}));

test("alignment and equal-gap distribution use the selection bounds and persist", () => fixture(async ({ page, frame, app, deck }) => {
  await multi(frame, ["a-one", "a-two", "a-three"]);
  await send(page, "command", { name: "align-top" }); await waitChange(page, 1);
  for (const id of ["a-one", "a-two", "a-three"]) near((await position(frame, id))[1], 240);
  await send(page, "command", { name: "distribute-x" }); await waitChange(page, 2);
  near((await position(frame, "a-two"))[0], 510); // x=100+120+290; equal gap is 290.
  near((await position(frame, "a-three"))[0], 1000);
  await saved(page); await page.reload(); await item(frame, "a-two").waitFor();
  assert.equal((await app.store.get(deck.id)).state.patches["a-two"].x, 510);
}));

test("locked objects resist editing while layers can reveal hidden objects and reorder siblings", () => fixture(async ({ page, frame, app, deck }) => {
  await item(frame, "a-one").click();
  await send(page, "layer-toggle", { id: "a-one", key: "locked" }); await waitChange(page, 1);
  await send(page, "select-ids", { ids: ["a-one"] });
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Delete");
  assert.deepEqual(await position(frame, "a-one"), [100, 240]);
  assert.equal(await item(frame, "a-one").isVisible(), true);
  await send(page, "layer-toggle", { id: "a-one", key: "locked" }); await waitChange(page, 2);
  await send(page, "layer-toggle", { id: "a-one", key: "hidden" }); await waitChange(page, 3);
  assert.equal(await item(frame, "a-one").isVisible(), false);
  await send(page, "layer-toggle", { id: "a-one", key: "hidden" }); await waitChange(page, 4);
  await item(frame, "a-one").click(); await send(page, "command", { name: "front" }); await waitChange(page, 5);
  const z = await item(frame, "a-one").evaluate(e => Number(getComputedStyle(e).zIndex));
  assert.ok(z > await item(frame, "a-two").evaluate(e => Number(getComputedStyle(e).zIndex)));
  await saved(page); assert.equal((await app.store.get(deck.id)).state.patches["a-one"].z, z);
}));

test("duplicated source text keeps formatting, new IDs and independence and can paste to another slide", () => fixture(async ({ page, frame, app, deck }) => {
  const title = frame.locator('[data-sd-slide="s0"] h1[data-sd-id="e0"]');
  await title.click(); await page.keyboard.press("Control+d");
  await page.waitForFunction(() => window.messages.some(m => m.type === "objects"));
  await frame.locator('[data-sd-added="true"]').nth(3).waitFor(); await saved(page);
  let current = await app.store.get(deck.id), copy = current.state.added.find(a => a.kind === "html");
  assert.ok(copy?.id.startsWith("a-")); assert.equal(current.state.added.length, 4);
  assert.match(copy.html, /strong/); assert.ok(!copy.html.includes("data-sd-id"));
  const copied = item(frame, copy.id);
  assert.equal(await copied.evaluate(e => getComputedStyle(e).color), "rgb(10, 100, 90)");
  await page.locator('[data-layer-id="e0"] [data-layer-action="select"]').click();
  await page.waitForFunction(() => document.querySelector('[data-layer-id="e0"] [data-layer-action="select"]').getAttribute("aria-pressed") === "true");
  await page.locator("#ribbon-format-tab").click();
  await page.locator("#textContentSettingsBtn").click();
  await page.locator("#textValue").fill("원본만 변경"); await page.locator("#textValue").dispatchEvent("change");
  await page.locator("#textContentSettings").getByRole("button", {name:"닫기",exact:true}).click();
  assert.match(await copied.textContent(), /복제할/);
  await copied.click(); await page.keyboard.press("Control+c");
  await page.locator("#slideList .slide-item").nth(1).click();
  await page.locator("#pasteObjectsBtn").click();
  await frame.locator('[data-sd-slide="s1"] [data-sd-added="true"]').waitFor(); await saved(page);
  current = await app.store.get(deck.id);
  assert.equal(current.state.added.filter(a => a.kind === "html").length, 2);
  assert.equal(new Set(current.state.added.map(a => a.id)).size, current.state.added.length);
}));

test("layer ordering persists when a sibling is locked and does not unlock or move it", () => fixture(async ({ page, frame, app, deck }) => {
  await send(page, "layer-toggle", { id: "a-two", key: "locked" }); await waitChange(page, 1);
  await item(frame, "a-one").click();
  const response = page.waitForResponse(r => r.url().endsWith("/save") && r.request().method() === "POST");
  await page.locator("#ribbon-arrange-tab").click();
  await page.locator("#layerFrontBtn").click(); await waitChange(page, 2); await response;
  const current = await app.store.get(deck.id);
  assert.ok(current.state.patches["a-one"].z > current.state.patches["a-two"].z);
  assert.equal(current.state.patches["a-two"].locked, true);
  await page.reload(); await item(frame, "a-two").waitFor();
  assert.deepEqual(await position(frame, "a-two"), [440, 350]);
  assert.ok(await item(frame, "a-one").evaluate(e => Number(getComputedStyle(e).zIndex)) > await item(frame, "a-two").evaluate(e => Number(getComputedStyle(e).zIndex)));
}));

test("group movement keeps document coordinates at 50, 100 and 200 percent zoom", () => fixture(async ({ page, frame }) => {
  for (const [i, zoom] of ["50", "100", "200"].entries()) {
    await page.locator("#zoomValue").selectOption(zoom);
    const content = await (await page.$("#deckFrame")).contentFrame();
    await content.waitForFunction(width => Math.abs(document.querySelector(".slide.active").getBoundingClientRect().width - width) < 1, 1920 * Number(zoom) / 100);
    await content.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await send(page, "select-ids", { ids: ["a-one", "a-two"] });
    await page.waitForFunction(() => document.querySelector("#selectionCount").textContent === "2개 선택");
    const box = await item(frame, "a-one").boundingBox(), ss = Number(zoom) / 100;
    await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + 10 + 12 * ss, box.y + 10 + 8 * ss); await page.mouse.up();
    await waitChange(page, i + 1);
    assert.deepEqual(await position(frame, "a-one"), [100 + 12 * (i + 1), 240 + 8 * (i + 1)]);
    assert.deepEqual(await position(frame, "a-two"), [440 + 12 * (i + 1), 350 + 8 * (i + 1)]);
  }
}));

test("alignment and vertical distribution measure the visible bounds of rotated objects", () => fixture(async ({ page, frame }) => {
  await item(frame, "a-three").click();
  await page.locator("#rotateValue").fill("30"); await page.locator("#rotateValue").dispatchEvent("change");
  await send(page, "select-ids", { ids: ["a-one", "a-two", "a-three"] });
  await page.locator("#ribbon-arrange-tab").click();
  await page.locator("#alignRightBtn").click(); await waitChange(page, 1);
  const rectangles = async () => Promise.all(["a-one", "a-two", "a-three"].map(id => item(frame, id).evaluate(e => { const r = e.getBoundingClientRect(); return { right: r.right, top: r.top, bottom: r.bottom }; })));
  let rects = await rectangles(); near(rects[0].right, rects[1].right); near(rects[1].right, rects[2].right);
  const edges = [rects[0].top, rects[2].bottom];
  await page.locator("#ribbon-arrange-tab").click();
  await page.locator("#distributeYBtn").click(); await waitChange(page, 2);
  rects = await rectangles(); near(rects[0].top, edges[0]); near(rects[2].bottom, edges[1]);
  near(rects[1].top - rects[0].bottom, rects[2].top - rects[1].bottom);
}));

test("a duplicated title retains editable font and color through reload and repeated duplication", () => fixture(async ({ page, frame }) => {
  await item(frame, "e0").click(); await page.keyboard.press("Control+d");
  const copy = frame.locator('[data-sd-added="true"]').nth(3);
  await copy.waitFor();
  await page.waitForFunction(() => document.querySelector("#fontValue").value === "42");
  await page.locator("#fontValue").fill("64"); await page.locator("#fontValue").dispatchEvent("change");
  await page.locator("#colorValue").fill("#aa2233"); await page.locator("#colorValue").dispatchEvent("change");
  await saved(page);
  const emphasis = copy.locator("[data-sd-run]").filter({ hasText: "제목" });
  assert.equal(await emphasis.evaluate(e => getComputedStyle(e).fontSize), "64px");
  assert.equal(await emphasis.evaluate(e => getComputedStyle(e).color), "rgb(170, 34, 51)");
  await page.locator("#ribbon-format-tab").click();
  await page.locator("#textContentSettingsBtn").click();
  await page.locator("#textValue").fill("새 제목"); await page.locator("#textValue").dispatchEvent("change");
  await page.locator("#textContentSettings").getByRole("button", {name:"닫기",exact:true}).click();
  assert.equal(await copy.evaluate(e => getComputedStyle(e).fontSize), "64px");
  await saved(page); await page.reload(); await copy.waitFor();
  assert.equal(await copy.textContent(), "새 제목");
  assert.equal(await copy.evaluate(e => getComputedStyle(e).color), "rgb(170, 34, 51)");
  await copy.click(); await page.keyboard.press("Control+d");
  const twice = frame.locator('[data-sd-added="true"]').nth(4); await twice.waitFor();
  assert.equal(await twice.evaluate(e => getComputedStyle(e).fontSize), "64px");
}));

test("runtime navigation refreshes the layer inventory for the newly active slide", () => fixture(async ({ page, frame }) => {
  const content = await (await page.$("#deckFrame")).contentFrame();
  await content.evaluate(() => window.__sd.go(1));
  await frame.locator('[data-sd-slide="s1"].active').waitFor();
  await page.locator('[data-layer-id="e1"]').waitFor();
  assert.equal(await page.locator('[data-layer-id="a-one"]').count(), 0);
}));

test("duplicating a rotated object with an off-center origin preserves its visual placement", () => fixture(async ({ page, frame }) => {
  const original = item(frame, "e0");
  await original.evaluate(e => { e.style.rotate = "30deg"; e.style.transformOrigin = "0 0"; });
  await page.locator('[data-layer-id="e0"] [data-layer-action="select"]').click();
  await page.waitForFunction(() => document.querySelector('[data-layer-id="e0"] [data-layer-action="select"]').getAttribute("aria-pressed") === "true");
  const before = await original.boundingBox(), ss = await frame.locator(".slide.active").evaluate(e => e.getBoundingClientRect().width / 1920);
  await page.locator("#duplicateObjectsBtn").click();
  const copied = frame.locator('[data-sd-added="true"]').nth(3); await copied.waitFor();
  const after = await copied.boundingBox();
  near((after.x - before.x) / ss, 24); near((after.y - before.y) / ss, 24);
  near(after.width / ss, before.width / ss); near(after.height / ss, before.height / ss);
}));
