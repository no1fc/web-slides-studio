import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import JSZip from "jszip";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
import { prepareDeck } from "../src/deck.js";
import { exportDeck } from "../src/export.js";

const source = `<!doctype html><html><head><title>Slide output</title><style>
html,body{margin:0}main{position:relative;width:1920px;height:1080px;transform:scale(.3)}
.slide{display:none;position:absolute;inset:0;opacity:0}.slide.active{display:block;opacity:1}
.notes{display:none}.slide h1{font-size:70px}
</style><script>window.originalScriptRan=true;parent.postMessage({originalScript:true},"*")</script></head>
<body onload="window.originalEventRan=true"><canvas id="bg"></canvas><button id="global-control">Global control</button><main id="stage">
<section class="slide active"><h1>First slide</h1><div class="notes">Original first note</div></section>
<section class="slide" hidden aria-hidden="true"><h1>Second slide</h1><img src="assets/pixel.png" onload="window.originalImageEventRan=true"><div class="notes">Original second note</div></section>
</main></body></html>`;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
async function fixture(fn, html = source) {
  const root = await mkdtemp(join(tmpdir(), "studio-slide-output-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  try {
    const prepared = prepareDeck(html);
    const deck = await app.store.create({ ...prepared, files: new Map([["index.html", Buffer.from(prepared.html)], ["assets/pixel.png", pixel]]) });
    await fn(app, deck);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
}
const preview = (app, deck) => `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html?rev=${deck.revision}`;

async function legacyNote(app, deck, note, nearLimit = false) {
  const metaPath = app.store.path(deck.id, "meta.json"), revisionPath = app.store.path(deck.id, "revisions", "1.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")); meta.slides.forEach(slide => delete slide.notes);
  await writeFile(metaPath, JSON.stringify(meta));
  const assetPath = app.store.path(deck.id, "assets/index.html");
  await writeFile(assetPath, (await readFile(assetPath, "utf8")).replace("Original first note", note));
  const snapshot = JSON.parse(await readFile(revisionPath, "utf8")); delete snapshot.state.notes;
  if (nearLimit) {
    snapshot.state.masters = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["m-fill-" + i, { name: "Large existing source", html: `<p>${"x".repeat(99000)}</p>`, css: "" }]));
  }
  await writeFile(revisionPath, JSON.stringify(snapshot));
  return { revisionPath, before: await readFile(revisionPath, "utf8") };
}

test("oversized inherited notes remain complete through unrelated save, clone, duplicate, restore and HTML/PPTX", { timeout: 60000 }, () => fixture(async (app, deck) => {
  const note = "Legacy long note " + "n".repeat(20001);
  const history = await legacyNote(app, deck, note);
  let loaded = await app.store.get(deck.id);
  assert.equal(loaded.sourceNotes.s0, note);
  assert.equal(Object.hasOwn(loaded.state.notes, "s0"), false);
  loaded.state.patches.e0 = { text: "Unrelated edited title" };
  loaded.state.slideCode.s0 = { html: '<h1 data-sd-id="e0">Edited slide source without notes</h1>', css: "" };
  loaded.state.clones["s-legacy-copy"] = "s0";
  loaded.state.order = ["s0", "s-legacy-copy"];
  loaded = await app.store.save(deck.id, loaded.revision, loaded.state);
  assert.equal(loaded.sourceNotes["s-legacy-copy"], note);
  assert.equal((await app.store.duplicate(deck.id)).sourceNotes.s0, note);
  const previewHtml = parseHTML(await (await fetch(preview(app, loaded))).text()).document;
  assert.equal(previewHtml.querySelector('[data-sd-slide="s0"] .notes').textContent, note, "replacing slide HTML must preserve the separately inherited notes");
  const args = { store: app.store, deck: loaded, url: preview(app, loaded), contentOrigin: app.contentOrigin };
  const htmlZip = await JSZip.loadAsync((await exportDeck({ ...args, format: "html" })).buffer);
  const { document } = parseHTML(await htmlZip.file("index.html").async("string"));
  for (const slide of document.querySelectorAll("[data-sd-slide]")) assert.equal(slide.querySelector(".notes").textContent, note);
  const pptZip = await JSZip.loadAsync((await exportDeck({ ...args, format: "pptx" })).buffer);
  for (const path of ["ppt/notesSlides/notesSlide1.xml", "ppt/notesSlides/notesSlide2.xml"]) assert.ok((await pptZip.file(path).async("string")).includes(note));
  loaded.state.notes.s0 = "";
  loaded = await app.store.save(deck.id, loaded.revision, loaded.state);
  assert.equal(loaded.state.notes.s0, "");
  assert.equal(Object.hasOwn(loaded.sourceNotes, "s0"), false);
  const original = await app.store.get(deck.id, 1);
  loaded = await app.store.save(deck.id, loaded.revision, original.state);
  assert.equal(loaded.sourceNotes.s0, note);
  assert.equal(await readFile(history.revisionPath, "utf8"), history.before);
}));

test("legacy source notes do not push a previously valid editing state over its total size limit", () => fixture(async (app, deck) => {
  const note = "z".repeat(20000);
  const history = await legacyNote(app, deck, note, true);
  const loaded = await app.store.get(deck.id);
  assert.equal(loaded.sourceNotes.s0, note);
  assert.equal(Object.hasOwn(loaded.state.notes, "s0"), false);
  assert.ok(JSON.stringify(loaded.state).length <= 2000000);
  loaded.state.patches.e0 = { text: "Still editable" };
  const saved = await app.store.save(deck.id, loaded.revision, loaded.state);
  assert.equal(saved.sourceNotes.s0, note);
  const zip = await JSZip.loadAsync((await exportDeck({ store: app.store, deck: saved, format: "html" })).buffer);
  assert.equal(parseHTML(await zip.file("index.html").async("string")).document.querySelector('.notes').textContent, note);
  assert.equal(await readFile(history.revisionPath, "utf8"), history.before);
}));

test("new imports preserve oversized source notes while keeping editable state within limits", () => fixture(async (app, deck) => {
  const note = "long " + "q".repeat(20001);
  const prepared = prepareDeck(source.replace("Original first note", note));
  const imported = await app.store.create({ ...prepared, files: new Map([["index.html", Buffer.from(prepared.html)], ["assets/pixel.png", pixel]]) });
  assert.equal(imported.sourceNotes.s0, note);
  assert.equal(Object.hasOwn(imported.state.notes, "s0"), false);
}));

test("legacy snapshots recover imported notes for originals and clones without rewriting history", () => fixture(async (app, deck) => {
  const metaPath = app.store.path(deck.id, "meta.json");
  const revisionPath = app.store.path(deck.id, "revisions", "1.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  meta.slides.forEach(slide => delete slide.notes);
  await writeFile(metaPath, JSON.stringify(meta));
  const snapshot = JSON.parse(await readFile(revisionPath, "utf8"));
  delete snapshot.state.notes;
  snapshot.state.clones = { "s-copy": "s1", "s-blank": null };
  snapshot.state.order = ["s0", "s-copy", "s-blank"];
  await writeFile(revisionPath, JSON.stringify(snapshot));
  const before = await readFile(revisionPath, "utf8");
  let loaded = await app.store.get(deck.id);
  assert.equal(loaded.state.notes.s0, "Original first note");
  assert.equal(loaded.state.notes["s-copy"], "Original second note");
  assert.equal(loaded.state.notes["s-blank"], "");
  assert.equal(await readFile(revisionPath, "utf8"), before);
  loaded.state.notes.s0 = "";
  loaded.state.notes["s-copy"] = "Changed copy note";
  loaded = await app.store.save(deck.id, loaded.revision, loaded.state);
  assert.equal((await app.store.get(deck.id)).state.notes.s0, "", "an explicit empty note must remain empty");
  assert.equal((await app.store.get(deck.id)).state.notes["s-copy"], "Changed copy note");
  assert.equal((await app.store.get(deck.id, 1)).state.notes.s0, "Original first note");
  assert.equal(await readFile(revisionPath, "utf8"), before);
}));

test("thumbnail serves only the requested saved slide and executes no imported script or event", { timeout: 30000 }, () => fixture(async (app, deck) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const oldUrl = preview(app, deck) + "&mode=thumbnail&slide=s1";
    deck.state.patches[deck.elements.find(element => element.slide === "s1" && element.tag === "h1").id] = { text: "Saved second title" };
    deck.state.added.push(
      { id: "a-thumbnail-text", slide: "s1", kind: "text", x: 200, y: 400, w: 180, h: 60, richText: { paragraphs: [{ runs: [{ text: "Shrinking thumbnail text", fontSize: 90 }] }] }, textBox: { autoFit: "shrink", overflow: "clip" } },
      { id: "a-thumbnail-image", slide: "s1", kind: "image", src: "assets/pixel.png", x: 500, y: 400, w: 200, h: 200, image: { mode: "stretch", crop: { left: 0.1, right: 0.3, top: 0, bottom: 0 } } },
    );
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const url = preview(app, deck) + "&mode=thumbnail&slide=s1";
    const response = await page.goto(url, { waitUntil: "networkidle" });
    const result = await page.evaluate(() => ({
      slides: [...document.querySelectorAll("[data-sd-slide]")].map(slide => slide.dataset.sdSlide),
      scripts: !!window.originalScriptRan, events: !!(window.originalEventRan || window.originalImageEventRan),
      bridge: !!window.__sd, notes: [...document.querySelectorAll(".notes")].some(note => getComputedStyle(note).display !== "none"),
      controls: !!document.querySelector("#global-control,#bg"),
      rect: document.querySelector('[data-sd-slide="s1"]').getBoundingClientRect().toJSON(),
      visible: getComputedStyle(document.querySelector('[data-sd-slide="s1"]')).display,
      imageLoaded: document.querySelector("img").naturalWidth,
      eventAttributes: [...document.querySelectorAll("*")].some(element => [...element.attributes].some(attribute => /^on/i.test(attribute.name))),
      title: document.querySelector("h1").textContent,
      textScale: Number(document.querySelector('[data-sd-id="a-thumbnail-text"]').dataset.sdFontScale),
      imageWidth: parseFloat(document.querySelector('[data-sd-id="a-thumbnail-image"] img').style.width),
    }));
    assert.equal(response.status(), 200);
    assert.deepEqual(result.slides, ["s1"]);
    assert.equal(result.scripts, false); assert.equal(result.events, false); assert.equal(result.eventAttributes, false);
    assert.equal(result.bridge, false); assert.equal(result.notes, false); assert.equal(result.controls, false);
    assert.equal(result.rect.x, 0); assert.equal(result.rect.y, 0); assert.equal(result.rect.width, 1920); assert.equal(result.rect.height, 1080);
    assert.notEqual(result.visible, "none"); assert.equal(result.imageLoaded, 1);
    assert.equal(result.title, "Saved second title");
    assert.ok(result.textScale > 0 && result.textScale < 1, "static thumbnails run the shipped text fitter");
    assert.ok(Math.abs(result.imageWidth - 200 / 0.6) < 0.01, "static thumbnails keep reversible crop geometry");
    const oldHtml = await (await fetch(oldUrl)).text();
    assert.match(oldHtml, /Second slide/); assert.doesNotMatch(oldHtml, /Saved second title/);
    assert.doesNotMatch(response.headers()["content-security-policy"], /script-src[^;]*unsafe-inline/);
    assert.equal((await fetch(preview(app, deck) + "&mode=thumbnail&slide=missing")).status, 400);
    for (const asset of ["slide-model.js", "slide-ui.js"]) assert.equal((await fetch(app.origin + "/" + asset)).status, 200);
  } finally { await browser?.close(); }
}));

test("HTML and PPTX preserve current speaker notes and resolve theme fonts and colors", { timeout: 60000 }, () => fixture(async (app, deck) => {
  deck.state.notes = { s0: "Current note <tag> & details", s1: "" };
  deck.state.theme = { colors: { background: "#ddeeff", text: "#123456", accent: "#765432" }, fonts: { heading: "Georgia", body: "Verdana" } };
  deck.state.added.push({ id: "a-themed", slide: "s0", kind: "text", x: 200, y: 200, w: 1000, h: 200, richText: { paragraphs: [{ runs: [
    { text: "Theme heading", fontTheme: "heading", colorTheme: "accent", fontSize: 60 },
    { text: " and body", fontTheme: "body", colorTheme: "text", fontSize: 40 },
  ] }] } });
  deck = await app.store.save(deck.id, deck.revision, deck.state);
  const args = { store: app.store, deck, url: preview(app, deck), contentOrigin: app.contentOrigin };
  const htmlZip = await JSZip.loadAsync((await exportDeck({ ...args, format: "html" })).buffer);
  const { document } = parseHTML(await htmlZip.file("index.html").async("string"));
  assert.equal(document.querySelector('[data-sd-slide="s0"] .notes').textContent, "Current note <tag> & details");
  assert.equal(document.querySelector('[data-sd-slide="s0"] .notes tag'), null);
  assert.equal(document.querySelector('[data-sd-slide="s1"] .notes')?.textContent || "", "");
  assert.match(await htmlZip.file("README.txt").async("string"), /노트/);
  const pptZip = await JSZip.loadAsync((await exportDeck({ ...args, format: "pptx-editable" })).buffer);
  const notes1 = await pptZip.file("ppt/notesSlides/notesSlide1.xml").async("string");
  const notes2 = await pptZip.file("ppt/notesSlides/notesSlide2.xml").async("string");
  assert.match(notes1, /Current note &lt;tag&gt; &amp; details/);
  assert.match(notes1, /저장 버전 2/);
  assert.doesNotMatch(notes2, /Original second note/);
  assert.match(notes2, /저장 버전 2/);
  const slide = await pptZip.file("ppt/slides/slide1.xml").async("string");
  assert.match(slide, /typeface="Georgia"/); assert.match(slide, /typeface="Verdana"/);
  assert.match(slide, /val="765432"/); assert.match(slide, /val="123456"/);
  const theme = await pptZip.file("ppt/theme/theme1.xml").async("string");
  assert.match(theme, /typeface="Georgia"/); assert.match(theme, /typeface="Verdana"/);
}));
