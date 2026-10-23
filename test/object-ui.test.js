import { clickEditorTool } from './editor-ui-helpers.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
import { importArchive } from "../src/archive.js";

const frameDocument = `<!doctype html><script>
window.commands=[];
window.reply=data=>parent.postMessage({studio:true,editorSession:new URLSearchParams(location.search).get('editorSession'),...data},'*');
addEventListener('message',e=>{if(!e.data?.studio)return;commands.push(e.data);if(e.data.type==='commit-edit')reply({type:'edit-settled',requestId:e.data.requestId});});
reply({type:'ready'});
</script>`;
const info = (id, extra = {}) => ({ id, tag: "div", kind: "shape", text: "", x: 100, y: 100, w: 200, h: 100, rotate: 0, fill: "#087e77", groupable: true, textEditable: false, ...extra });
const shape = { type: "rect", fill: "#087e77", stroke: "#123456", strokeWidth: 2, dash: "solid" };
const image = { mode: "stretch", crop: { left: 0, top: 0, right: 0, bottom: 0 } };
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "studio-object-ui-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const zip = new JSZip();
    zip.file("index.html", '<html><head><title>Objects</title></head><body><main id="stage"><section class="slide"><h1>제목</h1></section></main></body></html>');
    zip.file("assets/pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
    let deck = await app.store.create(await importArchive(await zip.generateAsync({ type: "nodebuffer" })));
    deck.state.added.push(
      { id: "a-one", slide: "s0", kind: "shape", x: 100, y: 100, w: 200, h: 100, fill: "#087e77" },
      { id: "a-two", slide: "s0", kind: "shape", x: 400, y: 100, w: 200, h: 100, fill: "#087e77" },
      { id: "a-image", slide: "s0", kind: "image", x: 100, y: 400, w: 400, h: 200, src: "assets/pixel.png" },
    );
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(5000);
    await page.route(url => url.searchParams.get("mode") === "edit", route => route.fulfill({ contentType: "text/html", body: frameDocument }));
    await page.goto(app.origin + "/#deck=" + deck.id);
    const frame = async () => {
      const f = await (await page.waitForSelector("#deckFrame")).contentFrame();
      await f.waitForFunction(() => window.commands?.some(item => item.type === "go"));
      return f;
    };
    await frame();
    const send = async data => { await (await frame()).evaluate(data => window.reply(data), data); await page.waitForTimeout(40); };
    const select = async items => {
      const elements = Array.isArray(items) ? items : [items];
      await send({ type: "layers", slide: "s0", items: elements.map(e => ({ id: e.id, tag: e.tag, group: "g0", layerable: true, hidden: false, locked: false })) });
      await send({ type: "select", slide: "s0", elements });
    };
    const change = async (id, value) => {
      await page.locator("#" + id).evaluate((c, value) => { c.value = value; c.dispatchEvent(new Event("change", { bubbles: true })); }, value);
      await page.waitForFunction(() => !document.querySelector("#saveStatus").textContent.includes("적용 중"));
    };
    const saved = async () => { await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨")); return app.store.get(deck.id); };
    await fn({ app, deck, page, frame, send, select, change, saved });
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}

test("shape inspector edits native geometry and border, preserving legacy shape fill", () => fixture(async ({ page, select, change, saved }) => {
  await select(info("a-one", { shape }));
  await clickEditorTool(page, 'shapeSettingsBtn');
  assert.equal(await page.locator("#shapeTools").isVisible(), true);
  assert.equal(await page.locator("#textField").isHidden(), true);
  await change("shapeTypeValue", "ellipse");
  await change("shapeStrokeValue", "#ff3300");
  await change("shapeStrokeWidthValue", "7");
  await change("shapeDashValue", "dash");
  await page.locator("#shapeNoFillValue").check();
  const d = await saved(), p = d.state.patches["a-one"].shape;
  assert.deepEqual(p, { ...shape, type: "ellipse", stroke: "#ff3300", strokeWidth: 7, dash: "dash", fill: "none" });
  if (await page.locator("#shapeSettings").evaluate(el => el.open)) await page.keyboard.press("Escape");
  await page.locator("#undoBtn").click();
  await page.waitForFunction(() => document.querySelector("#saveStatus").textContent.startsWith("저장됨"));
  assert.equal((await saved()).state.patches["a-one"].shape.fill, shape.fill);
}));

test("image inspector stores non-destructive crop, rejects empty crop and resets", () => fixture(async ({ page, select, change, saved }) => {
  await select(info("a-image", { tag: "img", kind: "image", image, w: 400, h: 200 }));
  await clickEditorTool(page, 'imageSettingsBtn');
  await change("imageModeValue", "fit");
  await change("cropLeftValue", "20");
  await change("cropRightValue", "10");
  let d = await saved();
  assert.deepEqual(d.state.patches["a-image"].image, { mode: "fit", crop: { left: .2, right: .1, top: 0, bottom: 0 } });
  assert.equal(d.state.added.find(x => x.id === "a-image").src, "assets/pixel.png");
  const revision = d.revision;
  await change("cropRightValue", "85");
  assert.equal((await saved()).revision, revision);
  assert.match(await page.locator("#toast").textContent(), /자르기|crop|99/);
  await page.locator("#resetCropBtn").click();
  d = await saved();
  assert.deepEqual(d.state.patches["a-image"].image, { ...image, mode: "fit" });
  await select(info("a-image", { tag: "img", kind: "image", image, locked: true }));
  assert.equal(await page.locator("#imageModeValue").isDisabled(), true);
  assert.equal(await page.locator("#resetCropBtn").isDisabled(), true);
}));

test("group consumes exactly selected native sources in one undo command", () => fixture(async ({ page, deck, select, send, saved }) => {
  await select([info("a-one"), info("a-two", { x: 400 })]);
  assert.equal(await page.locator("#groupObjectsBtn").isEnabled(), true);
  const children = deck.state.added.slice(0, 2).map(a => { const { id, slide, ...o } = a; return { ...o, x: o.x - 100, y: o.y - 100 }; });
  await send({ type: "object-structure", slide: "s0", operation: "group", removeIds: ["a-one", "a-two"], objects: [{ kind: "group", x: 100, y: 100, w: 500, h: 100, group: { width: 500, height: 100, children } }] });
  let d = await saved();
  assert.equal(d.state.added.length, 2);
  const group = d.state.added.find(a => a.kind === "group");
  assert.equal(group.group.children.length, 2);
  assert.equal(d.state.added.some(a => a.id === "a-one"), false);
  if (await page.locator("#shapeSettings").evaluate(el => el.open)) await page.keyboard.press("Escape");
  await page.locator("#undoBtn").click();
  d = await saved();
  assert.deepEqual(d.state.added, deck.state.added);
}));

test("structure messages cannot remove unselected, locked, original or stale slide objects", () => fixture(async ({ deck, select, send, saved }) => {
  await select([info("a-one"), info("a-two")]);
  for (const data of [
    { removeIds: ["a-one", "a-image"] }, { removeIds: ["e0", "a-two"] },
    { removeIds: ["a-one", "a-two"], slide: "s9" }, { removeIds: ["a-one", "a-two"], editorSession: "stale-session" },
  ]) await send({ type: "object-structure", operation: "group", slide: "s0", objects: [{ kind: "shape", x: 1, y: 1, w: 50, h: 50 }], ...data });
  await select([info("a-one", { locked: true }), info("a-two")]);
  await send({ type: "object-structure", operation: "group", slide: "s0", removeIds: ["a-one", "a-two"], objects: [{ kind: "shape", x: 1, y: 1, w: 50, h: 50 }] });
  assert.equal((await saved()).revision, deck.revision);
}));

test("group numeric resize enforces uniform scale and ungroup preserves transformed children", () => fixture(async ({ page, deck, select, send, change, saved }) => {
  await select([info("a-one"), info("a-two")]);
  const children = deck.state.added.slice(0, 2).map(a => { const { id, slide, ...o } = a; return { ...o, x: o.x - 100, y: o.y - 100 }; });
  await send({ type: "object-structure", slide: "s0", operation: "group", removeIds: ["a-one", "a-two"], objects: [{ kind: "group", x: 100, y: 100, w: 500, h: 100, group: { width: 500, height: 100, children } }] });
  const group = (await saved()).state.added.find(a => a.kind === "group");
  await select(info(group.id, { kind: "group", group: group.group, w: 500, h: 100 }));
  assert.equal(await page.locator("#lockAspect").isChecked(), true);
  assert.equal(await page.locator("#lockAspect").isDisabled(), true);
  await change("wValue", "1000");
  await change("rotateValue", "90");
  const d = await saved(), p = d.state.patches[group.id];
  assert.equal(p.h, 200);
  const { id, slide, ...snapshot } = group;
  const objects = globalThis.SDObjects.ungroup({ ...snapshot, ...p });
  await send({ type: "object-structure", slide: "s0", operation: "ungroup", removeIds: [group.id], objects });
  const ungrouped = (await saved()).state.added.filter(a => a.kind === "shape");
  assert.equal(ungrouped.length, 2);
  assert.deepEqual(ungrouped.map(a => [a.x, a.y, a.w, a.h, a.rotate]), objects.map(a => [a.x, a.y, a.w, a.h, a.rotate]));
  assert.equal((await saved()).state.patches[group.id], undefined);
}));

test("shape insert offers four native types and saves the chosen arrow", () => fixture(async ({ page, saved }) => {
  await clickEditorTool(page, 'addShapeBtn');
  await page.locator("#dialog[open]").waitFor();
  assert.equal(await page.locator("#dialogBody [data-shape-type]").count(), 4);
  await page.locator('[data-shape-type="arrow"]').click();
  const d = await saved();
  assert.equal(d.state.added.at(-1).shape.type, "arrow");
}));

test("ungroup preserves explicit child z order from JSON instead of array order", () => fixture(async ({ deck, select, send, saved }) => {
  await select([info("a-one"), info("a-two")]);
  const children = deck.state.added.slice(0, 2).map((a, i) => { const { id, slide, ...o } = a; return { ...o, x: o.x - 100, y: o.y - 100, z: i ? 1 : 30 }; });
  await send({ type: "object-structure", slide: "s0", operation: "group", removeIds: ["a-one", "a-two"], objects: [{ kind: "group", x: 100, y: 100, w: 500, h: 100, group: { width: 500, height: 100, children } }] });
  const group = (await saved()).state.added.find(a => a.kind === "group");
  await select(info(group.id, { kind: "group", group: group.group, w: 500, h: 100 }));
  const { id, slide, ...snapshot } = group;
  await send({ type: "object-structure", slide: "s0", operation: "ungroup", removeIds: [group.id], objects: globalThis.SDObjects.ungroup(snapshot) });
  const restored = (await saved()).state.added.filter(a => a.kind === "shape").sort((a, b) => a.z - b.z);
  assert.deepEqual(restored.map(a => a.x), [400, 100]);
}));
