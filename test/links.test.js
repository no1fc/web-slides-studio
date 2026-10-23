import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { chromium } from "playwright";
import { initialState, prepareDeck, renderDeck, validateState } from "../src/deck.js";

const O = globalThis.SDObjects;
const urlLink = { type: "url", url: "https://example.com/path?q=1#section" };
const slideLink = { type: "slide", slideId: "s2" };
const input = prepareDeck('<html><head><style>html,body{margin:0}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none}.slide.active{display:block}h1{position:absolute;left:40px;top:30px;width:500px;height:70px;margin:0}</style></head><body><main id="stage"><section class="slide"><h1>First</h1></section><section class="slide"><h1>Second</h1></section><section class="slide"><h1>Last</h1></section></main></body></html>');
const shape = (link, x = 100) => ({ kind: "shape", x, y: 200, w: 200, h: 100, link });
function linkedState() {
  const state = initialState(input);
  state.patches.e0 = { link: slideLink };
  state.added.push({ id: "a-url", slide: "s0", ...shape(urlLink) }, { id: "a-group", slide: "s0", ...O.groupObjects([shape(urlLink, 500), shape(slideLink, 800)]) });
  state.order = ["s0", "s2", "s1"];
  return state;
}

test("links strictly validate record shapes and protocols without requiring a live slide target", () => {
  assert.equal(O.normalizeLink(null), null);
  assert.deepEqual(O.normalizeLink(urlLink), urlLink);
  assert.deepEqual(O.normalizeLink(slideLink), slideLink);
  assert.deepEqual(O.normalizeLink({ type: "slide", slideId: "s-removed-clone" }), { type: "slide", slideId: "s-removed-clone" });
  for (const value of [undefined, [], false, {}, { type: "url", url: "javascript:alert(1)" }, { type: "url", url: "data:text/html,x" }, { type: "url", url: "//example.com" }, { type: "url", url: "https:example.com" }, { type: "url", url: "https://user:secret@example.com" }, { type: "url", url: "https://example.com/\nfoo" }, { type: "url", url: "https://example.com/\\foo" }, { type: "url", url: "https://example.com/" + "x".repeat(2048) }, { type: "url", url: "https://example.com", slideId: "s0" }, { type: "slide", slideId: "s0\n" }, { type: "slide", slideId: "__proto__" }, Object.create(urlLink), { get type() { throw new Error("getter executed"); } }]) assert.throws(() => O.normalizeLink(value));
  const state = linkedState();
  state.order = ["s0", "s1"];
  assert.deepEqual(validateState(state, input).patches.e0.link, slideLink);
  state.patches.e0.link = { type: "url", url: "javascript:alert(1)" };
  assert.throws(() => validateState(state, input));
});

test("rendering, overrides, grouping and serialization retain link metadata", () => {
  const state = validateState(JSON.parse(JSON.stringify(linkedState())), input);
  let { document } = parseHTML(renderDeck(input.html, state));
  const get = id => JSON.parse(document.querySelector(`[data-sd-id="${id}"]`).getAttribute("data-sd-link"));
  assert.deepEqual(get("e0"), slideLink);
  assert.deepEqual(get("a-url"), urlLink);
  assert.equal(document.querySelectorAll('[data-sd-id="a-group"] [data-sd-link]').length, 2);
  const { id, slide, ...group } = state.added[1];
  assert.deepEqual(O.ungroup(group).map(object => object.link), [urlLink, slideLink]);
  state.patches["a-url"] = { link: null };
  state.patches["a-group"] = { link: slideLink };
  ({ document } = parseHTML(renderDeck(input.html, validateState(state, input))));
  assert.equal(document.querySelector('[data-sd-id="a-url"]').hasAttribute("data-sd-link"), false);
  assert.deepEqual(get("a-group"), slideLink);
});

const scripts = await Promise.all(["text-model", "text-editor", "object-model", "bridge"].map(name => readFile(new URL(`../public/${name}.js`, import.meta.url), "utf8")));
async function fixture(fn, { edit = false, deleted = false, originalNavigation = false } = {}) {
  const state = linkedState();
  if (deleted) state.order = ["s0", "s1"];
  const config = { edit, state, managerOrigin: "http://links.test" };
  const navigation = originalNavigation ? '<script>window.goSlide=n=>{window.originalSlide=n;document.querySelectorAll("[data-sd-slide]").forEach((s,i)=>s.classList.toggle("active",i===n));};document.addEventListener("click",()=>window.legacyClicks=(window.legacyClicks||0)+1);</script>' : '';
  const html = renderDeck(input.html, validateState(state, input)).replace("</body>", `${navigation}<script id="sd-config" type="application/json">${JSON.stringify(config)}</script>${scripts.map(source => `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}</body>`);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.setDefaultTimeout(5000);
    await page.route("http://links.test/**", route => route.fulfill({ contentType: "text/html", body: route.request().url().endsWith("/deck") ? html : '<script>window.messages=[];addEventListener("message",e=>messages.push(e.data));</script><iframe style="width:1920px;height:1080px;border:0" src="/deck"></iframe>' }));
    await page.goto("http://links.test/");
    const frame = page.frames().find(frame => frame.url().endsWith("/deck"));
    await frame.waitForFunction(() => !!window.__sd);
    await frame.evaluate(() => { window.opened = []; window.open = (...args) => { opened.push(args); return null; }; });
    const send = (type, data = {}) => page.evaluate(({ type, data }) => { window.messages = []; document.querySelector("iframe").contentWindow.postMessage({ studio: true, type, ...data }, "http://links.test"); }, { type, data });
    const message = async type => { await page.waitForFunction(type => messages.some(message => message.type === type), type); return page.evaluate(type => messages.findLast(message => message.type === type), type); };
    await fn({ page, frame, send, message });
  } finally { await browser.close(); }
}

test("presentation links activate by click and Enter with stable reordered IDs and original navigation", () => fixture(async ({ frame }) => {
  const original = frame.locator('[data-sd-id="e0"]'), url = frame.locator('[data-sd-id="a-url"]');
  assert.equal(await original.getAttribute("role"), "link");
  assert.equal(await original.getAttribute("tabindex"), "0");
  assert.ok(await url.getAttribute("aria-label"));
  await url.click();
  assert.deepEqual(await frame.evaluate(() => opened), [[urlLink.url, "_blank", "noopener,noreferrer"]]);
  await original.focus(); await original.press("Enter");
  assert.equal(await frame.evaluate(() => __sd.current), 1);
  assert.equal(await frame.evaluate(() => originalSlide), 1);
  assert.equal(await frame.locator('.slide.active').getAttribute("data-sd-slide"), "s2");
  await frame.evaluate(() => __sd.go(0));
  await original.click();
  assert.equal(await frame.evaluate(() => __sd.current), 1);
  assert.equal(await frame.evaluate(() => window.legacyClicks || 0), 0);
}, { originalNavigation: true }));

test("deleted slide targets safely do nothing and clean disables activation and focus artifacts", () => fixture(async ({ frame }) => {
  await frame.locator('[data-sd-id="e0"]').click();
  assert.equal(await frame.evaluate(() => __sd.current), 0);
  const child = frame.locator('[data-sd-id="a-group"] [data-sd-link]').first();
  await child.focus(); await child.press("Enter");
  assert.equal(await frame.evaluate(() => opened.length), 1);
  await frame.evaluate(() => __sd.clean());
  assert.equal(await child.getAttribute("tabindex"), null);
  assert.equal(await child.evaluate(el => el === document.activeElement), false);
  await child.click();
  assert.equal(await frame.evaluate(() => opened.length), 1);
}, { deleted: true }));

test("editor reports and copies links but does not navigate or attach runtime link semantics", () => fixture(async ({ frame, send, message }) => {
  const original = frame.locator('[data-sd-id="e0"]');
  await original.click();
  assert.equal(await frame.evaluate(() => __sd.current), 0);
  assert.equal(await original.getAttribute("role"), null);
  await frame.locator('[data-sd-id="a-url"]').click();
  assert.equal(await frame.evaluate(() => opened.length), 0);
  await send("select-ids", { ids: ["e0"] });
  assert.deepEqual((await message("select")).element.link, slideLink);
  await send("command", { name: "copy" });
  assert.deepEqual((await message("objects")).objects[0].link, slideLink);
  await send("select-ids", { ids: ["a-url"] }); await message("select");
  await send("command", { name: "copy" });
  assert.deepEqual((await message("objects")).objects[0].link, urlLink);
  await send("select-ids", { ids: ["a-group"] }); await message("select");
  await send("command", { name: "copy" });
  assert.deepEqual((await message("objects")).objects[0].group.children.map(child => child.link), [urlLink, slideLink]);
  await send("select-ids", { ids: ["a-url"] }); await message("select");
  await send("patch", { id: "a-url", patch: { link: null } });
  assert.equal((await message("select")).element.link, null);
  await frame.evaluate(() => {
    const anchor = document.createElement("a"); anchor.href = "https://example.com"; anchor.textContent = "Original anchor";
    anchor.style.cssText = "position:absolute;left:50px;top:600px"; document.querySelector('[data-sd-slide="s0"]').append(anchor);
    window.anchorDefaults = [];
    for (const type of ["click", "auxclick", "keydown"]) {
      const event = type === "keydown" ? new KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true }) : new MouseEvent(type, { bubbles: true, cancelable: true });
      anchor.dispatchEvent(event); anchorDefaults.push(event.defaultPrevented);
    }
    anchor.contentEditable = "true";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true }); anchor.dispatchEvent(event); anchorDefaults.push(event.defaultPrevented);
  });
  assert.deepEqual(await frame.evaluate(() => anchorDefaults), [true, true, true, true]);
}, { edit: true }));
