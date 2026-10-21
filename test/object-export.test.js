import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { DOMParser } from "linkedom";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCJkAAAAASUVORK5CYII=", "base64");
const crop = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 };
const image = { id: "a-image", kind: "image", nativeObject: true, src: "assets/original.png", x: 144, y: 288, w: 432, h: 216, rotate: 30, naturalWidth: 1000, naturalHeight: 500, image: { mode: "stretch", crop } };
const tags = (node, name) => [...node.getElementsByTagName(name)];
async function api() { return import("../src/object-export.js"); }
test("image fill and picture share the same entrance animation target root", async () => {
  const {addNativeObjects}=await api(),ppt=new pptxgen(),mappings=[];
  addNativeObjects(ppt.addSlide(),[{kind:'image',object:{...image,fill:'#ffffff'},mapped:{options:{data:'image/png;base64,'+pixel.toString('base64'),x:1,y:1,w:3,h:2}}}],[],[],mappings);
  assert.equal(mappings.length,2);assert.deepEqual(mappings.map(m=>m.rootId),['a-image','a-image']);
  const {finalizeEffectsPptx}=await import('../src/effects-export.js');
  const bytes=await finalizeEffectsPptx(await ppt.write({outputType:'nodebuffer'}),{order:['s0'],animations:{'a-image':'fade'}},[mappings]);
  const xml=await(await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml').async('string');
  assert.equal(new Set([...xml.matchAll(/<p:spTgt spid="(\d+)"/g)].map(m=>m[1])).size,2);
});
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "studio-native-objects-"));
  try { await mkdir(join(root, "assets")); await writeFile(join(root, "assets/original.png"), pixel); await fn({ root, url: "http://localhost:1234/v/d/token/index.html", contentOrigin: "http://localhost:1234" }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("native crop embeds original bytes and writes source crop without baking it into a screenshot", () => fixture(async context => {
  const { prepareNativeObjects, addNativeObjects, finalizeObjectPptx } = await api();
  const prepared = await prepareNativeObjects([image], context);
  assert.deepEqual(prepared.hideIds, [image.id]);
  const ppt = new pptxgen(); ppt.layout = "LAYOUT_WIDE";
  const shapes = [], pictures = [];
  addNativeObjects(ppt.addSlide(), prepared.entries, shapes, pictures);
  const zip = await JSZip.loadAsync(await finalizeObjectPptx(await ppt.write({ outputType: "nodebuffer" }), [pictures]));
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  assert.equal(tags(doc, "p:pic").length, 1);
  assert.deepEqual(Object.fromEntries([...tags(doc, "a:srcRect")[0].attributes].map(a => [a.name, a.value])), { l: "10000", t: "20000", r: "30000", b: "10000" });
  const xfrm = tags(tags(doc, "p:pic")[0], "a:xfrm")[0];
  assert.equal(xfrm.getAttribute("rot"), "1800000");
  assert.equal(tags(xfrm, "a:off")[0].getAttribute("x"), "914400");
  assert.equal(tags(xfrm, "a:ext")[0].getAttribute("cx"), "2743200");
  const embedded = await Promise.all(Object.values(zip.files).filter(f => /^ppt\/media\/.*\.png$/.test(f.name)).map(f => f.async("nodebuffer")));
  assert.ok(embedded.some(bytes => bytes.equals(pixel)), "full source file is embedded byte-for-byte");
}));

test("Fill adds centered source crop while Fit keeps crop and centers a rotated image within its frame", async () => {
  const { pptxImage } = await api();
  const source = { data: "image/png;base64," + pixel.toString("base64") };
  const fill = pptxImage({ ...image, x: 0, y: 0, w: 200, h: 200, rotate: 0, image: { mode: "fill", crop: { left: 0, top: 0, right: 0, bottom: 0 } } }, source, "fill");
  assert.deepEqual(fill.crop, { left: 0.25, top: 0, right: 0.25, bottom: 0 });
  const fit = pptxImage({ ...image, x: 100, y: 200, w: 200, h: 200, rotate: 90, image: { mode: "fit", crop: { left: 0, top: 0, right: 0, bottom: 0 } } }, source, "fit");
  assert.equal(fit.options.x, 100 / 144);
  assert.equal(fit.options.y, 250 / 144);
  assert.equal(fit.options.w, 200 / 144);
  assert.equal(fit.options.h, 100 / 144);
  assert.equal(fit.options.rotate, 90);
  assert.deepEqual(fit.crop, { left: 0, top: 0, right: 0, bottom: 0 });
});

test("native shapes preserve ellipse, line, open arrowhead and stroke settings in PPTX XML", async () => {
  const { prepareNativeObjects, addNativeObjects } = await api();
  const objects = ["rect", "ellipse", "line", "arrow"].map((type, i) => ({ id: `a-${type}`, kind: "shape", nativeObject: true, x: 100 + i * 300, y: 200, w: 240, h: 120, rotate: 20, shape: { type, fill: type === "ellipse" ? "none" : "#112233", stroke: "#abcdef", strokeWidth: 4, dash: type === "line" ? "dot" : "dash" } }));
  const prepared = await prepareNativeObjects(objects, {});
  assert.equal(prepared.hideIds.length, 4);
  const ppt = new pptxgen(); ppt.layout = "LAYOUT_WIDE";
  addNativeObjects(ppt.addSlide(), prepared.entries, [], []);
  const zip = await JSZip.loadAsync(await ppt.write({ outputType: "nodebuffer" }));
  const doc = new DOMParser().parseFromString(await zip.file("ppt/slides/slide1.xml").async("string"), "text/xml");
  const shapes = tags(doc, "p:sp");
  assert.deepEqual(shapes.map(s => tags(s, "a:prstGeom")[0].getAttribute("prst")), ["rect", "ellipse", "line", "line"]);
  assert.equal(tags(shapes[1], "a:noFill").length, 1);
  assert.equal(tags(shapes[2], "a:prstDash")[0].getAttribute("val"), "sysDot");
  assert.equal(tags(shapes[3], "a:tailEnd")[0].getAttribute("type"), "arrow");
  assert.equal(tags(shapes[0], "a:ln")[0].getAttribute("w"), "25400");
});

test("unsupported group children keep the entire group visible and invalid source paths are never loaded", () => fixture(async context => {
  const { prepareNativeObjects } = await api();
  const good = { ...image, id: "g--1" };
  for (const bad of [
    { ...image, src: "../outside.png" },
    { ...image, src: "http://other.invalid/assets/original.png" },
    { ...image, src: "http://localhost:1234/v/other/token/assets/original.png" },
    { ...image, src: "assets/missing.png" },
    { kind: "text", x: 0, y: 0, w: 200, h: 200, text: "clipped", textBox: { overflow: "clip" }, textOverflowing: true },
  ]) {
    const prepared = await prepareNativeObjects([{ id: "a-group", kind: "group", children: [good, bad] }], context);
    assert.deepEqual(prepared, { entries: [], hideIds: [] });
  }
}));

test("groups flatten to editable ordered children including their text background and inherited rotation", () => fixture(async context => {
  const { prepareNativeObjects, addNativeObjects } = await api();
  const text = { id: "g--text", kind: "text", x: 400, y: 350, w: 300, h: 120, rotate: 40, text: "group text", fontSize: 40, fill: "#fefefe" };
  const prepared = await prepareNativeObjects([{ id: "a-group", kind: "group", children: [image, text] }], context);
  assert.deepEqual(prepared.hideIds, ["a-group"]);
  assert.equal(prepared.entries.length, 2);
  const ppt = new pptxgen(); const textShapes = [], pictures = [];
  addNativeObjects(ppt.addSlide(), prepared.entries, textShapes, pictures);
  assert.equal(textShapes.length, 1);
  assert.deepEqual(textShapes[0].options.fill, { color: "FEFEFE" });
  assert.equal(textShapes[0].options.rotate, 40);
}));

test("grouped list gutters use the same geometry scale as the browser", async () => {
  const { pptxText } = await import("../src/text-export.js");
  const mapped = pptxText({ x: 0, y: 0, w: 400, h: 200, textMetricsScale: 1.5, fontScale: 0.8, richText: { paragraphs: [{ runs: [{ text: "list", fontSize: 60 }], list: "bullet", indent: 1 }] } }, "text");
  assert.match(mapped.paragraphXml[0], /marL="426720"/);
  assert.match(mapped.paragraphXml[0], /indent="-182880"/);
  assert.equal(mapped.runs[0].options.fontSize, 24);
});

test("native Fit images retain the original frame fill behind their letterbox and transparent pixels", () => fixture(async context => {
  const { prepareNativeObjects, addNativeObjects } = await api();
  const prepared = await prepareNativeObjects([{ ...image, fill: "#abcDEF", image: { mode: "fit", crop } }], context);
  const ppt = new pptxgen(); addNativeObjects(ppt.addSlide(), prepared.entries, [], []);
  const zip = await JSZip.loadAsync(await ppt.write({ outputType: "nodebuffer" }));
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const background = tags(doc, "p:sp")[0];
  assert.equal(tags(background, "a:srgbClr")[0].getAttribute("val"), "ABCDEF");
  assert.equal(tags(background, "a:xfrm")[0].getAttribute("rot"), "1800000");
  assert.equal(tags(background, "a:ext")[0].getAttribute("cx"), "2743200");
  assert.ok(xml.indexOf("sd-native-image-background") < xml.indexOf('name="sd-native-image-0"'));
}));

const coloredShape = (id, x, y, w, h, fill = "#ff0000", rotate = 0) => ({ id, kind: "shape", nativeObject: true, x, y, w, h, rotate, shape: { type: "rect", fill, stroke: "#000000", strokeWidth: 0, dash: "solid" } });
test("a raster fallback keeps overlapping lower native roots behind it while preserving independent and upper roots", async () => {
  const { prepareNativeObjects } = await api();
  const lower = coloredShape("a-lower", 100, 100, 300, 300);
  const separate = coloredShape("a-separate", 900, 100, 100, 100);
  const group = { id: "a-fallback", kind: "group", nativeObject: true, x: 200, y: 200, w: 300, h: 200, children: [
    coloredShape("blue-child", 200, 200, 300, 200, "#0000ff"),
    { id: "clipped", kind: "text", nativeObject: true, x: 200, y: 200, w: 100, h: 20, text: "overflow", textBox: { overflow: "clip" }, textOverflowing: true },
  ] };
  const upper = coloredShape("a-upper", 250, 250, 100, 100, "#00ff00");
  const result = await prepareNativeObjects([lower, separate, group, upper], {});
  assert.deepEqual(result.hideIds, ["a-separate", "a-upper"]);
  assert.deepEqual(result.entries.map(e => e.object.id), ["a-separate", "a-upper"]);
});

test("fallback propagates through overlapping lower roots and considers rotated children outside a group frame", async () => {
  const { prepareNativeObjects } = await api();
  const chain = [
    coloredShape("a-bottom", 100, 100, 100, 100),
    coloredShape("a-middle", 150, 100, 200, 100),
    { ...coloredShape("a-raster", 300, 100, 100, 100), nativeSupported: false },
  ];
  assert.deepEqual((await prepareNativeObjects(chain, {})).hideIds, []);
  const group = { id: "a-group", kind: "group", nativeObject: true, nativeSupported: false, x: 700, y: 300, w: 50, h: 50, children: [
    coloredShape("a-rotated-child", 300, 300, 200, 20, "#0000ff", 90),
  ] };
  const lower = coloredShape("a-lower", 390, 215, 20, 20);
  const separate = coloredShape("a-separate", 1000, 100, 100, 100);
  assert.deepEqual((await prepareNativeObjects([lower, separate, group], {})).hideIds, ["a-separate"]);
});

test("visible overflowing text extends a raster group's coverage beyond its declared frames", async () => {
  const { prepareNativeObjects } = await api();
  const lower = coloredShape("a-lower", 100, 200, 200, 100);
  const upper = coloredShape("a-upper", 500, 200, 100, 100, "#00ff00");
  const group = { id: "a-group", kind: "group", nativeObject: true, x: 100, y: 100, w: 200, h: 40, children: [
    { id: "visible-text", kind: "text", nativeObject: true, x: 100, y: 100, w: 200, h: 20, fontSize: 40, text: "Long visible paragraph ".repeat(20), textBox: { overflow: "visible" }, textOverflowing: true },
    { id: "clipped-text", kind: "text", nativeObject: true, x: 100, y: 120, w: 10, h: 20, text: "clipped", textBox: { overflow: "clip" }, textOverflowing: true },
  ] };
  const result = await prepareNativeObjects([lower, group, upper], {});
  assert.deepEqual(result.hideIds, ["a-upper"], "the lower shape must not cover text painted outside the raster group frame");
  assert.deepEqual(result.entries.map(e => e.object.id), ["a-upper"]);
  group.children[0].textBox.overflow = "clip";
  assert.deepEqual((await prepareNativeObjects([lower, group, upper], {})).hideIds, ["a-lower", "a-upper"], "clipped content does not extend the group's painted bounds");
});

test("editable PPTX keeps a lower red shape under an upper blue group with clipped text", { timeout: 30000 }, async () => {
  const { startStudio } = await import("../src/server.js");
  const { importArchive } = await import("../src/archive.js");
  const { exportDeck } = await import("../src/export.js");
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "studio-object-layers-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  let browser;
  try {
    const archive = new JSZip();
    archive.file("index.html", '<html><head><style>html,body{margin:0}main{width:1920px;height:1080px;position:relative}.slide{position:absolute;inset:0}</style></head><body><main id="stage"><section class="slide"></section></main></body></html>');
    let deck = await app.store.create(await importArchive(await archive.generateAsync({ type: "nodebuffer" })));
    const addedShape = (id, x, y, w, h, fill, z) => {
      const { nativeObject, ...shape } = coloredShape(id, x, y, w, h, fill);
      return { ...shape, slide: "s0", z };
    };
    deck.state.added.push(
      addedShape("a-red", 100, 100, 500, 400, "#ff0000", 20),
      addedShape("a-yellow", 1000, 100, 150, 100, "#ffff00", 20),
      { id: "a-blue-group", slide: "s0", kind: "group", x: 200, y: 200, w: 400, h: 250, z: 21, group: { width: 400, height: 250, children: [
        { kind: "shape", x: 0, y: 0, w: 400, h: 250, shape: { type: "rect", fill: "#0000ff", stroke: "#000000", strokeWidth: 0, dash: "solid" } },
        { kind: "text", x: 10, y: 10, w: 100, h: 20, richText: { paragraphs: [{ runs: [{ text: "Clipped group text", fontSize: 80 }] }] }, textBox: { overflow: "clip", autoFit: "none" } },
      ] } },
      addedShape("a-green", 500, 250, 100, 100, "#00ff00", 22),
    );
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const output = await exportDeck({ store: app.store, deck, format: "pptx-editable", url: `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html?rev=${deck.revision}`, contentOrigin: app.contentOrigin });
    const zip = await JSZip.loadAsync(output.buffer);
    const xml = await zip.file("ppt/slides/slide1.xml").async("string");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const fills = tags(doc, "p:sp").map(shape => tags(tags(shape, "a:solidFill")[0], "a:srgbClr")[0].getAttribute("val"));
    assert.deepEqual(fills, ["FFFF00", "00FF00"], "only the separate yellow and upper green shapes stay native");
    assert.doesNotMatch(xml, /Clipped group text|FF0000|0000FF/);
    const background = Object.values(zip.files).find(f => /^ppt\/media\/.*\.jpe?g$/.test(f.name));
    assert.ok(background);
    const data = "data:image/jpeg;base64," + (await background.async("nodebuffer")).toString("base64");
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const colors = await page.evaluate(async src => {
      const img = new Image(); img.src = src; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d"); context.drawImage(img, 0, 0);
      return [[120, 120], [350, 350]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3));
    }, data);
    assert.ok(colors[0][0] > 240 && colors[0][1] < 15 && colors[0][2] < 15, JSON.stringify(colors));
    assert.ok(colors[1][0] < 15 && colors[1][1] < 15 && colors[1][2] > 240, JSON.stringify(colors));
  } finally { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("saved image crops, shapes and scaled groups reach offline HTML and native PPTX", { timeout: 60000 }, async () => {
  const { startStudio } = await import("../src/server.js");
  const { importArchive } = await import("../src/archive.js");
  const { exportDeck } = await import("../src/export.js");
  const root = await mkdtemp(join(tmpdir(), "studio-object-export-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  try {
    const archive = new JSZip();
    archive.file("index.html", '<html><head><title>Native objects</title><style>html,body{margin:0}main{width:1920px;height:1080px;position:relative}.slide{position:absolute;inset:0}</style></head><body><main id="stage"><section class="slide"></section></main></body></html>');
    archive.file("assets/original.png", pixel);
    let deck = await app.store.create(await importArchive(await archive.generateAsync({ type: "nodebuffer" })));
    deck.state.added.push(
      { id: "a-photo", slide: "s0", kind: "image", src: "assets/original.png", x: 80, y: 80, w: 200, h: 160, rotate: 10, fill: "#eeeeee", image: { mode: "stretch", crop } },
      { id: "a-group", slide: "s0", kind: "group", x: 350, y: 300, w: 900, h: 300, rotate: 15, group: { width: 600, height: 200, children: [
        { kind: "image", src: "assets/original.png", x: 0, y: 0, w: 200, h: 200, image: { mode: "fit", crop: { left: 0, top: 0, right: 0, bottom: 0 } } },
        { kind: "shape", x: 250, y: 0, w: 200, h: 100, shape: { type: "ellipse", fill: "#aabbcc", stroke: "#112233", strokeWidth: 8, dash: "dash" } },
        { kind: "text", x: 250, y: 120, w: 300, h: 80, text: "Grouped text", fontSize: 32, color: "#123456", fill: "#fefefe" },
      ] } },
      { id: "a-clipped", slide: "s0", kind: "group", x: 1750, y: 900, w: 300, h: 100, group: { width: 300, height: 100, children: [
        { kind: "image", src: "assets/original.png", x: 0, y: 0, w: 300, h: 100 },
        { kind: "text", x: 0, y: 0, w: 200, h: 80, text: "Must stay raster", fontSize: 30 },
      ] } },
    );
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    const args = { store: app.store, deck, url: `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html?rev=${deck.revision}`, contentOrigin: app.contentOrigin };
    const html = await exportDeck({ ...args, format: "html" });
    const htmlZip = await JSZip.loadAsync(html.buffer);
    assert.ok(htmlZip.file("assets/studio-object-model.js"));
    assert.ok((await htmlZip.file("assets/original.png").async("nodebuffer")).equals(pixel));
    assert.match(await htmlZip.file("index.html").async("string"), /data-sd-kind="group"/);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto(args.url, { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.__sd);
      const collected = await page.evaluate(() => window.__sd.collect());
      assert.equal(collected.find(e => e.id === "a-group")?.nativeSupported, true, JSON.stringify(collected));
      const extracted = join(root, "offline");
      for (const file of Object.values(htmlZip.files).filter(file => !file.dir)) {
        const path = join(extracted, file.name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, await file.async("nodebuffer"));
      }
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(pathToFileURL(join(extracted, "index.html")).href);
      await page.waitForFunction(() => !!window.__sd && document.querySelector('[data-sd-id="a-photo"] img')?.naturalWidth > 0);
      const offline = await page.locator('[data-sd-id="a-photo"]').evaluate(element => ({
        image: JSON.parse(element.dataset.sdImage), source: element.querySelector("img").getAttribute("src"),
        sourceWidth: parseFloat(element.querySelector("img").style.width),
      }));
      assert.deepEqual(offline.image.crop, crop);
      assert.equal(offline.source, "assets/original.png");
      assert.ok(Math.abs(offline.sourceWidth - 200 / 0.6) < 0.01, "offline viewer reapplies the reversible crop");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
    const output = await exportDeck({ ...args, format: "pptx-editable" });
    const zip = await JSZip.loadAsync(output.buffer);
    const xml = await zip.file("ppt/slides/slide1.xml").async("string");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    assert.equal(tags(doc, "p:pic").length, 3, "background and two source images; clipped group remains wholly raster");
    assert.match(xml, /<a:srcRect l="10000" t="20000" r="30000" b="10000"\/>/);
    assert.match(xml, /<a:prstGeom prst="ellipse"/);
    assert.match(xml, /sd-native-image-background/);
    assert.match(xml, /Grouped text/);
    assert.doesNotMatch(xml, /Must stay raster/);
    const textShape = tags(doc, "p:sp").find(s => tags(s, "a:t").some(t => t.textContent === "Grouped text"));
    assert.equal(tags(textShape, "a:rPr")[0].getAttribute("sz"), "2400", "32px font receives the group's 1.5 scale");
    assert.equal(tags(textShape, "a:xfrm")[0].getAttribute("rot"), "900000");
    const media = await Promise.all(Object.values(zip.files).filter(f => /^ppt\/media\//.test(f.name) && !f.dir).map(f => f.async("nodebuffer")));
    assert.ok(media.some(bytes => bytes.equals(pixel)));
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
