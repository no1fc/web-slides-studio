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
  const root = await mkdtemp(join(tmpdir(), "studio-precision-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const zip = new JSZip();
    zip.file("index.html", `<!doctype html><html><head><title>Precision</title><style>
      html,body{margin:0}main{position:relative;width:1920px;height:1080px;transform-origin:0 0}
      .slide{position:absolute;inset:0;display:none}.slide.active{display:block}
      h1{position:absolute;left:700px;top:500px;width:300px;height:100px;padding:20px;border:5px solid;margin:0;rotate:30deg;font-size:40px}
      input{position:absolute;left:50px;top:900px}
      </style></head><body><main id="stage"><section class="slide"><h1>원본 제목</h1><input value="입력값"></section><section class="slide"><h1>둘째</h1></section></main></body></html>`);
    let deck = await app.store.create(await importArchive(await zip.generateAsync({ type: "nodebuffer" })));
    deck.state.added.push({ id: "a-precision", slide: "s0", kind: "text", text: "정밀 편집", x: 400, y: 320, w: 400, h: 200, fontSize: 48 });
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(5000);
    await page.goto(app.origin + "/#deck=" + deck.id);
    const frame = page.frameLocator("#deckFrame"), target = frame.locator('[data-sd-id="a-precision"]');
    await target.waitFor();
    await page.evaluate(() => { window.messages = []; window.addEventListener("message", e => { if (e.data?.studio) window.messages.push(e.data); }); });
    await fn({ page, frame, target, app, deck });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}
const near = (a, b, tolerance = 1.5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} should be near ${b}`);
async function geometry(target) {
  return target.evaluate(e => {
    const c = getComputedStyle(e), r = e.getBoundingClientRect(), scale = e.closest("[data-sd-slide]").getBoundingClientRect().width / 1920;
    return { w: parseFloat(c.width), h: parseFloat(c.height), x: r.x / scale, y: r.y / scale, cx: (r.x + r.width / 2) / scale, cy: (r.y + r.height / 2) / scale, rotate: parseFloat(c.rotate) || 0, translate: e.style.translate };
  });
}
async function changes(page) {
  await page.waitForTimeout(60);
  return page.evaluate(() => window.messages.filter(m => m.type === "change"));
}
async function handleDrag({ page, frame }, handle, dx, dy, modifiers = [], finish = "up") {
  const locator = frame.locator(`[data-sd-handle="${handle}"]`);
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const scale = await frame.locator('[data-sd-slide="s0"]').evaluate(e => e.getBoundingClientRect().width / 1920);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx * scale, box.y + box.height / 2 + dy * scale, { steps: 4 });
  if (finish === "escape") await page.keyboard.press("Escape");
  if (finish === "cancel") await locator.dispatchEvent("pointercancel", { pointerId: 1 });
  if (finish === "lost") await locator.evaluate(e => e.releasePointerCapture(1));
  await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
}
async function saved(page) { await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨")); }
async function waitStyle(page, property, value) {
  const content = await (await page.$("#deckFrame")).contentFrame();
  await content.waitForFunction(({ property, value }) => {
    const e = document.querySelector('[data-sd-id="a-precision"]');
    return e && getComputedStyle(e)[property] === value;
  }, { property, value });
}

test("corner resize keeps the opposite corner, commits once and survives save and undo", () => fixture(async ctx => {
  const { page, frame, target, app, deck } = ctx;
  await target.click();
  const before = await geometry(target);
  await handleDrag(ctx, "se", 80, 40);
  const after = await geometry(target);
  near(after.w, 480); near(after.h, 240); near(after.x, before.x); near(after.y, before.y);
  assert.equal((await changes(page)).length, 1);
  await saved(page);
  assert.equal((await app.store.get(deck.id)).state.patches["a-precision"].w, 480);
  await page.locator("#undoBtn").click();
  await waitStyle(page, "width", "400px");
  await target.waitFor(); near((await geometry(target)).w, 400);
  await page.locator("#redoBtn").click();
  await waitStyle(page, "width", "480px");
  await saved(page); await page.reload(); await target.waitFor();
  near((await geometry(target)).w, 480);
}));

test("Shift keeps aspect and Alt keeps the center for side resizing", () => fixture(async ctx => {
  const { page, target } = ctx;
  await target.click(); const before = await geometry(target);
  await handleDrag(ctx, "e", 80, 0, ["Shift", "Alt"]);
  const after = await geometry(target);
  near(after.w, 560); near(after.h, 280); near(after.cx, before.cx); near(after.cy, before.cy);
  assert.equal((await changes(page)).length, 1);
}));

test("rotated content-box resizing uses local axes and preserves the opposite corner", () => fixture(async ctx => {
  const { page, frame } = ctx, target = frame.locator('[data-sd-slide="s0"] h1');
  await target.click();
  await page.waitForFunction(() => document.querySelector("#wValue").value === "300");
  assert.equal(await page.locator("#wValue").inputValue(), "300");
  assert.equal(await page.locator("#hValue").inputValue(), "100");
  assert.equal(await page.locator("#rotateValue").inputValue(), "30");
  const before = await geometry(target);
  await handleDrag(ctx, "se", 86.60254038, 50); // 100px along its rotated horizontal axis
  const after = await geometry(target);
  near(after.w, 400); near(after.h, 100);
  near(after.cx - before.cx, 43.30127019); near(after.cy - before.cy, 25);
}));

test("resize cancellation restores all inline geometry without a commit", () => fixture(async ctx => {
  const { page, target } = ctx;
  for (const finish of ["escape", "cancel", "lost"]) {
    await target.click(); const before = await geometry(target);
    await handleDrag(ctx, "nw", -80, -40, [], finish);
    assert.deepEqual(await geometry(target), before);
  }
  assert.equal((await changes(page)).length, 0);
}));

test("rotation handle rotates around the center and Shift snaps to 15 degrees", () => fixture(async ctx => {
  const { page, frame, target } = ctx;
  await target.click(); const before = await geometry(target);
  const handle = frame.locator('[data-sd-handle="rotate"]'), hb = await handle.boundingBox(), tb = await target.boundingBox();
  assert.ok(hb, "rotation handle is visible");
  const cx = tb.x + tb.width / 2, cy = tb.y + tb.height / 2, radius = cy - hb.y - hb.height / 2;
  await page.keyboard.down("Shift");
  await page.mouse.move(cx, cy - radius); await page.mouse.down();
  await page.mouse.move(cx + radius * Math.sin(44 * Math.PI / 180), cy - radius * Math.cos(44 * Math.PI / 180), { steps: 4 });
  await page.mouse.up(); await page.keyboard.up("Shift");
  const after = await geometry(target);
  near(after.rotate, 45, .01); near(after.cx, before.cx); near(after.cy, before.cy);
  assert.equal((await changes(page)).length, 1);
}));

test("arrow repeat is one undo transaction and text or form editing does not move the object", () => fixture(async ({ page, frame, target }) => {
  await target.click();
  await page.keyboard.down("ArrowRight"); await page.keyboard.down("ArrowRight"); await page.keyboard.down("ArrowRight"); await page.keyboard.up("ArrowRight");
  assert.equal((await changes(page)).length, 1);
  assert.equal(await target.evaluate(e => e.style.translate), "403px 320px");
  await page.keyboard.press("Shift+ArrowDown");
  assert.equal(await target.evaluate(e => e.style.translate), "403px 330px");
  await page.locator("#undoBtn").click(); await waitStyle(page, "translate", "403px 320px");
  assert.equal(await target.evaluate(e => e.style.translate), "403px 320px");
  await target.dblclick(); await page.keyboard.press("ArrowRight");
  assert.equal(await target.evaluate(e => e.style.translate), "403px 320px");
  await frame.locator("input").click(); await page.keyboard.press("ArrowRight");
  assert.equal(await target.evaluate(e => e.style.translate), "403px 320px");
}));

test("zoom changes only viewport size and drag stays in document coordinates at 50, 100 and 200 percent", () => fixture(async ({ page, frame, target, app, deck }) => {
  const revision = deck.revision;
  for (const zoom of ["50", "100", "200"]) {
    await page.locator("#zoomValue").selectOption(zoom);
    await page.waitForFunction(z => Math.abs(document.querySelector("#deckFrame").clientWidth - 1920 * Number(z) / 100) < 2, zoom);
    await target.scrollIntoViewIfNeeded(); await target.click();
    const before = await target.evaluate(e => parseFloat(e.style.translate));
    const box = await target.boundingBox(), s = Number(zoom) / 100;
    await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + 10 + 20 * s, box.y + 10); await page.mouse.up();
    near(await target.evaluate(e => parseFloat(e.style.translate)), before + 20, .01);
  }
  assert.equal((await changes(page)).length, 3);
  await saved(page);
  const latest = await app.store.get(deck.id);
  assert.ok(latest.revision > revision);
  assert.equal(latest.state.patches["a-precision"].x, 460);
  assert.equal(Object.hasOwn(latest.state, "zoom"), false);
  await page.locator("#zoomValue").selectOption("fit");
  assert.ok(await page.locator("#deckFrame").evaluate(e => e.clientWidth <= e.parentElement.parentElement.clientWidth));
}));

test("aspect checkbox links numeric width and height and unsupported transforms explain missing handles", () => fixture(async ({ page, frame, target }) => {
  await target.click(); await page.locator("#lockAspect").check();
  await page.locator("#wValue").fill("600"); await page.locator("#wValue").dispatchEvent("change");
  await waitStyle(page, "height", "300px");
  near((await geometry(target)).h, 300);
  await target.evaluate(e => { e.style.transform = "skewX(20deg)"; });
  await target.click();
  await page.waitForFunction(() => !document.querySelector("#precisionNote").hidden);
  assert.equal(await frame.locator('[data-sd-handle="se"]:visible').count(), 0);
  assert.match(await page.locator("#precisionNote").textContent(), /CSS/);
}));

test("selected handles follow zoom without reselecting the object", () => fixture(async ({ page, frame, target }) => {
  await page.locator("#zoomValue").selectOption("50");
  await target.click();
  await page.locator("#zoomValue").selectOption("100");
  await page.waitForFunction(() => document.querySelector("#deckFrame").clientWidth === 1920);
  await page.waitForTimeout(80);
  const box = await target.boundingBox(), overlay = await frame.locator("#sd-selection-overlay").boundingBox();
  near(overlay.width, box.width); near(overlay.height, box.height);
  near(overlay.x, box.x); near(overlay.y, box.y);
}));

test("numeric aspect lock preserves the same outer ratio as handles for padded objects", () => fixture(async ({ page, frame }) => {
  const target = frame.locator('[data-sd-slide="s0"] h1');
  await target.click(); await page.locator("#lockAspect").check();
  await page.locator("#wValue").fill("600"); await page.locator("#wValue").dispatchEvent("change");
  await page.waitForFunction(() => document.querySelector("#hValue").value !== "100");
  const g = await geometry(target);
  near((g.w + 50) / (g.h + 50), 350 / 150, .001);
}));

test("clicking an object after a form input gives arrow keys back to object editing", () => fixture(async ({ page, frame, target }) => {
  await frame.locator("input").click();
  await target.click(); await page.keyboard.press("ArrowRight");
  await changes(page);
  assert.equal(await target.evaluate(e => e.style.translate), "401px 320px");
}));

test("wheel keeps a fitted slide fixed and scrolls the canvas viewport when zoomed", () => fixture(async ({ page, target }) => {
  const before = await target.boundingBox();
  await page.mouse.move(before.x + 15, before.y + 15);
  await page.mouse.wheel(0, 200); await page.waitForTimeout(120);
  near((await target.boundingBox()).y, before.y);
  await page.locator("#zoomValue").selectOption("200");
  const iframe = await page.locator("#deckFrame").boundingBox();
  await page.mouse.move(iframe.x + 100, iframe.y + 100);
  await page.mouse.wheel(120, 200); await page.waitForTimeout(120);
  assert.ok(await page.locator("#canvasViewport").evaluate(e => e.scrollTop > 0 && e.scrollLeft > 0));
}));
