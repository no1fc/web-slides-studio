import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { initialState, prepareDeck, renderDeck } from "../src/deck.js";

const scripts = Object.fromEntries(await Promise.all(["text-model", "text-editor", "object-model", "bridge"].map(async name =>
  [name, await readFile(new URL(`../public/${name}.js`, import.meta.url), "utf8")])));
const theme = "--sd-theme-heading-font:Georgia;--sd-theme-body-font:Arial;--sd-theme-text:#123456;--sd-theme-accent:#cc3300;";
const themed = { paragraphs: [{ runs: [{ text: "Theme", fontTheme: "heading", colorTheme: "accent" }, { text: " Fixed", fontFamily: "Arial", color: "#112233" }] }] };

async function fixture(fn) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(`<div id="text" style="${theme}font:32px Arial;color:#000000;width:800px;height:240px"></div>`);
    await page.addScriptTag({ content: scripts["text-model"] });
    await page.addScriptTag({ content: scripts["text-editor"] });
    await page.evaluate(rich => SDTextEditor.render(document.querySelector("#text"), rich), themed);
    await fn(page);
  } finally { await browser.close(); }
}

test("live theme updates affect linked runs while DOM reads keep tokens and export resolves actual values", () => fixture(async page => {
  const result = await page.evaluate(() => {
    const el = document.querySelector("#text"), spans = [...el.querySelectorAll("[data-sd-run]")];
    el.style.setProperty("--sd-theme-heading-font", "Verdana");
    el.style.setProperty("--sd-theme-accent", "#007744");
    return { raw: SDTextEditor.model(el), read: SDTextEditor.read(el), resolved: SDTextEditor.resolve(el),
      visible: spans.map(span => ({ font: getComputedStyle(span).fontFamily, color: getComputedStyle(span).color, fill: getComputedStyle(span).webkitTextFillColor })) };
  });
  assert.equal(result.read.paragraphs[0].runs[0].fontTheme, "heading");
  assert.equal(result.read.paragraphs[0].runs[0].colorTheme, "accent");
  assert.equal(result.read.paragraphs[0].runs[0].fontFamily, undefined);
  assert.equal(result.read.paragraphs[0].runs[0].color, undefined);
  assert.deepEqual(result.raw, themed);
  assert.deepEqual(result.visible, [{ font: "Verdana", color: "rgb(0, 119, 68)", fill: "rgb(0, 119, 68)" }, { font: "Arial", color: "rgb(17, 34, 51)", fill: "rgb(17, 34, 51)" }]);
  const run = result.resolved.paragraphs[0].runs[0];
  assert.equal(run.fontFamily, "Verdana"); assert.equal(run.color, "#007744");
  assert.equal(run.fontTheme, undefined); assert.equal(run.colorTheme, undefined);
}));

test("editing preserves nearest inherited theme but respects nested explicit font and color declarations", () => fixture(async page => {
  await page.evaluate(() => {
    const el = document.querySelector("#text"), run = el.querySelector("[data-sd-run]");
    run.innerHTML = '<b>A</b><span style="font-family:Courier New;color:#abcdef;-webkit-text-fill-color:#abcdef">B</span><i>C</i>';
    el.contentEditable = "true"; el.focus(); SDTextEditor.restore(el, { start: 3, end: 3 });
  });
  await page.keyboard.type("D");
  const { raw, resolved } = await page.evaluate(() => ({ raw: SDTextEditor.model(document.querySelector("#text")), resolved: SDTextEditor.resolve(document.querySelector("#text")) }));
  const runs = raw.paragraphs[0].runs;
  assert.equal(runs.map(run => run.text).join(""), "ABCD Fixed");
  assert.equal(runs[0].fontTheme, "heading"); assert.equal(runs[0].colorTheme, "accent");
  assert.equal(runs[1].fontTheme, undefined); assert.equal(runs[1].colorTheme, undefined);
  assert.equal(runs[1].fontFamily, '"Courier New"'); assert.equal(runs[1].color, "#abcdef");
  assert.equal(runs[2].text, "CD"); assert.equal(runs[2].fontTheme, "heading"); assert.equal(runs[2].colorTheme, "accent");
  assert.ok(resolved.paragraphs[0].runs.every(run => !run.fontTheme && !run.colorTheme && run.fontFamily && run.color));
}));

test("empty themed paragraphs and plain text replacement retain theme references", () => fixture(async page => {
  const result = await page.evaluate(() => {
    const el = document.querySelector("#text");
    SDTextEditor.render(el, { paragraphs: [{ runs: [{ text: "", fontTheme: "body", colorTheme: "text" }] }] });
    el.contentEditable = "true";
    const empty = SDTextEditor.read(el);
    return { empty, filled: SDTextEditor.replaceText(empty, "새 글") };
  });
  for (const rich of [result.empty, result.filled]) {
    assert.equal(rich.paragraphs[0].runs[0].fontTheme, "body");
    assert.equal(rich.paragraphs[0].runs[0].colorTheme, "text");
  }
  assert.equal(result.filled.paragraphs[0].runs[0].text, "새 글");
}));

async function bridgeFixture(fn) {
  const input = prepareDeck('<html><head><style>html,body{margin:0}main,.slide{position:absolute;width:1920px;height:1080px}</style></head><body><main><section class="slide"><h1>Original</h1></section></main></body></html>');
  const state = initialState(input);
  state.added.push({ id: "a-text", slide: "s0", kind: "text", x: 100, y: 200, w: 800, h: 240, fontSize: 32, richText: themed },
    { id: "a-shape", slide: "s0", kind: "shape", x: 1000, y: 200, w: 100, h: 100, fill: "#123456" });
  const config = { edit: true, state, managerOrigin: "http://theme.test" };
  const html = renderDeck(input.html, state).replace("</body>", `<script id="sd-config" type="application/json">${JSON.stringify(config)}</script>${Object.values(scripts).map(source => `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}</body>`);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.setDefaultTimeout(5000);
    await page.route("http://theme.test/**", route => route.fulfill({ contentType: "text/html", body: route.request().url().endsWith("/deck") ? html : '<script>window.messages=[];addEventListener("message",e=>messages.push(e.data));</script><iframe style="width:1920px;height:1080px;border:0" src="/deck"></iframe>' }));
    await page.goto("http://theme.test/");
    const frame = page.frames().find(frame => frame.url().endsWith("/deck"));
    await frame.waitForFunction(() => !!window.__sd);
    await frame.evaluate(theme => document.querySelector("[data-sd-slide]").style.cssText += theme, theme);
    const send = async (type, data = {}) => page.evaluate(({ type, data }) => {
      window.messages = []; document.querySelector("iframe").contentWindow.postMessage({ studio: true, type, ...data }, "http://theme.test");
    }, { type, data });
    const message = async type => { await page.waitForFunction(type => messages.some(message => message.type === type), type); return page.evaluate(type => messages.findLast(message => message.type === type), type); };
    await fn({ page, frame, send, message });
  } finally { await browser.close(); }
}

test("bridge copy and grouping retain live theme links while inspector and native export use computed styles", () => bridgeFixture(async ({ frame, send, message }) => {
  await send("select-ids", { ids: ["a-text"] });
  const selection = await message("select");
  assert.equal(selection.element.textStyle.fontFamily, "Georgia");
  assert.equal(selection.element.textStyle.color, "#cc3300");
  await send("command", { name: "copy" });
  const copy = (await message("objects")).objects[0];
  assert.equal(copy.richText.paragraphs[0].runs[0].fontTheme, "heading");
  assert.equal(copy.richText.paragraphs[0].runs[0].colorTheme, "accent");
  assert.equal(copy.richText.paragraphs[0].runs[1].fontFamily, "Arial");
  assert.equal(copy.richText.paragraphs[0].runs[1].color, "#112233");
  await send("select-ids", { ids: ["a-text", "a-shape"] });
  await message("select");
  await send("command", { name: "group" });
  const group = (await message("object-structure")).objects[0];
  assert.equal(group.group.children[0].richText.paragraphs[0].runs[0].fontTheme, "heading");
  assert.equal(group.group.children[0].richText.paragraphs[0].runs[0].colorTheme, "accent");
  const exported = await frame.evaluate(() => window.__sd.collect().find(object => object.id === "a-text"));
  const run = exported.richText.paragraphs[0].runs[0];
  assert.equal(run.fontFamily, "Georgia"); assert.equal(run.color, "#cc3300");
  assert.equal(run.fontTheme, undefined); assert.equal(run.colorTheme, undefined);
}));
