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
  const root = await mkdtemp(join(tmpdir(), "studio-foundation-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    const zip = new JSZip();
    zip.file("index.html", `<!doctype html><html><head><title>Foundation</title>
      <style>html,body{margin:0}main{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none}.slide.active{display:block}h1{position:absolute;left:20px;top:20px;margin:0;font-size:48px}input{position:absolute;left:100px;top:700px}</style>
      </head><body><main id="stage"><section class="slide"><h1>원본 제목</h1><input value="입력값"></section><section class="slide"><h1>둘째</h1></section></main></body></html>`);
    let deck = await app.store.create(await importArchive(await zip.generateAsync({ type: "nodebuffer" })));
    deck.state.added.push({ id: "a-foundation", slide: "s0", kind: "text", text: "한글 편집", x: 150, y: 160, w: 500, h: 100, fontSize: 48 });
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
    await page.goto(app.origin + "/#deck=" + deck.id);
    await page.waitForSelector("#slideList .slide-item");
    const frame = page.frameLocator("#deckFrame");
    await frame.locator('[data-sd-id="a-foundation"]').waitFor();
    await page.evaluate(() => {
      window.bridgeMessages = [];
      window.addEventListener("message", e => { if (e.data?.studio) window.bridgeMessages.push(e.data); });
    });
    await fn({ app, page, frame, deck });
  } finally {
    await browser?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}
const element = frame => frame.locator('[data-sd-id="a-foundation"]');
async function changes(page) {
  // A frame message is delivered in a later task than the pointer event.
  await page.waitForTimeout(50);
  return page.evaluate(() => window.bridgeMessages.filter(m => m.type === "change"));
}
async function clearMessages(page) {
  await page.evaluate(() => { window.bridgeMessages = []; });
}
async function move(page, frame, dx, dy, finish = "up") {
  const box = await element(frame).boundingBox();
  const scale = await frame.locator('[data-sd-slide="s0"]').evaluate(e => e.getBoundingClientRect().width / 1920);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx * scale, box.y + box.height / 2 + dy * scale);
  if (finish === "escape") await page.keyboard.press("Escape");
  if (finish === "cancel") await element(frame).dispatchEvent("pointercancel", { pointerId: 1 });
  if (finish === "lost") await element(frame).evaluate(e => e.releasePointerCapture(1));
  await page.mouse.up();
}

test("added elements report their base coordinates and one-axis edits preserve the other axis", () => fixture(async ({ app, page, frame, deck }) => {
  await element(frame).click();
  await page.waitForFunction(() => document.querySelector("#xValue").value === "150");
  assert.equal(await page.locator("#xValue").inputValue(), "150");
  assert.equal(await page.locator("#yValue").inputValue(), "160");
  await page.locator("#yValue").fill("220");
  await page.locator("#yValue").dispatchEvent("change");
  assert.equal(await element(frame).evaluate(e => e.style.translate), "150px 220px");
  await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨"));
  await page.reload();
  await element(frame).waitFor();
  assert.equal(await element(frame).evaluate(e => e.style.translate), "150px 220px");
  assert.equal((await app.store.get(deck.id)).state.patches["a-foundation"].y, 220);
}));

test("one drag commits once from the added base and undo restores it", () => fixture(async ({ page, frame }) => {
  await clearMessages(page);
  await move(page, frame, 10, 0);
  const messages = await changes(page);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].patch, { x: 160, y: 160 });
  assert.equal(await element(frame).evaluate(e => e.style.translate), "160px 160px");
  await page.locator("#undoBtn").click();
  await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨"));
  await element(frame).waitFor();
  assert.equal(await element(frame).evaluate(e => e.style.translate), "150px 160px");
}));

test("micro drags, escape, pointer cancellation and lost capture roll back without a change", () => fixture(async ({ page, frame }) => {
  for (const [dx, finish] of [[1, "up"], [25, "escape"], [25, "cancel"], [25, "lost"]]) {
    await clearMessages(page);
    await move(page, frame, dx, 0, finish);
    assert.equal((await changes(page)).length, 0, finish);
    assert.equal(await element(frame).evaluate(e => e.style.translate), "150px 160px", finish);
  }
}));

test("blank clicks and slide navigation clear selection and notify the parent", () => fixture(async ({ page, frame }) => {
  await element(frame).click();
  await clearMessages(page);
  await frame.locator('[data-sd-slide="s0"]').click({ position: { x: 600, y: 300 } });
  assert.equal(await frame.locator(".sd-selected").count(), 0);
  await page.waitForFunction(() => window.bridgeMessages.some(m => m.type === "select" && m.element === null));
  await element(frame).click();
  await clearMessages(page);
  await page.locator("#slideList .slide-item").nth(1).click();
  await page.waitForFunction(() => window.bridgeMessages.some(m => m.type === "select" && m.element === null));
  assert.equal(await frame.locator(".sd-selected").count(), 0);
}));

test("text clicks keep native caret behavior and composition is not intercepted by global commands", () => fixture(async ({ page, frame }) => {
  await element(frame).dblclick();
  assert.equal(await element(frame).getAttribute("contenteditable"), "true");
  const result = await element(frame).evaluate(e => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    e.dispatchEvent(click);
    e.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    e.dispatchEvent(escape);
    const focusedDuringComposition = document.activeElement === e && e.isContentEditable;
    e.textContent = "한글 입력 완료";
    e.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한글" }));
    e.blur();
    return { prevented: click.defaultPrevented, focusedDuringComposition };
  });
  assert.deepEqual(result, { prevented: false, focusedDuringComposition: true });
  assert.equal((await changes(page)).at(-1)?.patch.text, "한글 입력 완료");
  await frame.locator("input").click();
  const prevented = await frame.locator("input").evaluate(e => {
    const key = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    e.dispatchEvent(key);
    return key.defaultPrevented;
  });
  assert.equal(prevented, false);
}));

test("navigation commits pending text while hidden false restores a live display override", () => fixture(async ({ app, page, frame, deck }) => {
  await element(frame).dblclick();
  await element(frame).fill("이동 전에 완성한 한글");
  await page.locator("#slideList .slide-item").nth(1).click();
  await page.waitForFunction(() => window.bridgeMessages.some(m => m.type === "change" && m.patch?.text === "이동 전에 완성한 한글"));
  await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨"));
  assert.equal((await app.store.get(deck.id)).state.patches["a-foundation"].text, "이동 전에 완성한 한글");
  await page.locator("#slideList .slide-item").first().click();
  await element(frame).waitFor({ state: "visible" });
  await element(frame).evaluate(e => { e.style.display = "inline-block"; });
  const sendPatch = patch => page.evaluate(patch => {
    const f = document.querySelector("#deckFrame");
    f.contentWindow.postMessage({ studio: true, type: "patch", id: "a-foundation", patch }, new URL(f.src).origin);
  }, patch);
  await sendPatch({ hidden: true });
  await element(frame).waitFor({ state: "hidden" });
  await sendPatch({ hidden: false });
  await element(frame).waitFor({ state: "visible" });
  assert.equal(await element(frame).evaluate(e => e.style.display), "inline-block");
  await page.locator("#slideList .slide-item").nth(1).click();
  await frame.locator('[data-sd-slide="s1"].active').waitFor();
  await sendPatch({ text: "다른 슬라이드에 적용하면 안 됨" });
  await page.waitForTimeout(50);
  assert.equal(await element(frame).textContent(), "이동 전에 완성한 한글");
}));

test("undo immediately after text editing restores the previous content", () => fixture(async ({ page, frame }) => {
  await element(frame).dblclick();
  await element(frame).fill("실행 취소할 내용");
  await page.locator("#undoBtn").click();
  await element(frame).filter({ hasText: /^한글 편집$/ }).waitFor();
  assert.equal(await element(frame).textContent(), "한글 편집");
}));

test("opening JSON settles direct text edits before taking the snapshot", () => fixture(async ({ page, frame }) => {
  await element(frame).dblclick();
  await element(frame).fill("JSON에도 보존할 내용");
  await page.locator("#ribbon-file-tab").click();
  await page.locator("#jsonBtn").click();
  const field = page.locator("#jsonState");
  await field.waitFor();
  assert.equal(JSON.parse(await field.inputValue()).patches["a-foundation"].text, "JSON에도 보존할 내용");
}));

test("commit acknowledgement waits for composition and follows the finalized text change", () => fixture(async ({ page, frame }) => {
  await element(frame).dblclick();
  await clearMessages(page);
  await element(frame).evaluate(e => {
    e.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
    e.textContent = "한글 조합중";
  });
  await page.evaluate(() => {
    const f = document.querySelector("#deckFrame");
    f.contentWindow.postMessage({ studio: true, type: "commit-edit", requestId: "composition-test" }, new URL(f.src).origin);
  });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.bridgeMessages.some(m => m.type === "edit-settled" && m.requestId === "composition-test")), false);
  await element(frame).evaluate(e => {
    e.textContent = "한글 조합완료";
    e.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "료" }));
  });
  await page.waitForFunction(() => window.bridgeMessages.some(m => m.type === "edit-settled" && m.requestId === "composition-test"));
  const messages = await page.evaluate(() => window.bridgeMessages);
  const change = messages.findIndex(m => m.type === "change" && m.patch?.text === "한글 조합완료");
  const settled = messages.findIndex(m => m.type === "edit-settled" && m.requestId === "composition-test");
  assert.ok(change >= 0 && change < settled);
}));
