import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { DOMParser } from "linkedom";
import { startStudio } from "../src/server.js";
import { prepareDeck } from "../src/deck.js";
import { exportDeck } from "../src/export.js";

const tags = (node, name) => [...node.getElementsByTagName(name)];
const parse = xml => new DOMParser().parseFromString(xml, "text/xml");
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "studio-export-links-"));
  const app = await startStudio({ root, port: 0, contentPort: 0 });
  try {
    const prepared = prepareDeck(`<html><head><style>html,body{margin:0}#stage{width:1920px;height:1080px;position:relative}.slide{position:absolute;inset:0;display:none}.slide.active{display:block}h1,p{position:absolute;margin:0;width:200px;height:60px}h1{left:100px;top:100px}p{left:400px;top:100px}p+ p{left:700px}[data-sd-id="a-group"]{filter:blur(.1px)}</style></head><body><main id="stage"><section class="slide active"><h1 style='font-family:"Definitely Missing SDLAB Font",Arial,sans-serif'>External</h1><p>Internal</p><p>Deleted</p></section><section class="slide"><h1>Middle</h1></section><section class="slide"><h1>Destination</h1></section></main></body></html>`);
    let deck = await app.store.create({ ...prepared, files: new Map([["index.html", Buffer.from(prepared.html)]]) });
    deck.state.patches.e0 = { link: { type: "url", url: "https://example.com/page?a=1&b=2" } };
    deck.state.patches.e1 = { link: { type: "slide", slideId: "s2" } };
    deck.state.patches.e2 = { link: { type: "slide", slideId: "s99" } };
    deck.state.order = ["s2", "s0", "s1"];
    deck.state.added.push({ id: "a-group", slide: "s0", kind: "group", x: 300, y: 400, w: 400, h: 200, rotate: 30,
      link: { type: "slide", slideId: "s1" }, group: { width: 200, height: 100, children: [
        { kind: "shape", x: 0, y: 0, w: 100, h: 100, fill: "#336699", link: { type: "url", url: "https://example.com/child" } },
        { kind: "text", x: 100, y: 0, w: 100, h: 100, text: "Raster fallback", textBox: { overflow: "clip", autoFit: "none" }, fontSize: 100 },
      ] } });
    deck = await app.store.save(deck.id, deck.revision, deck.state);
    await fn({ app, deck, args: { store: app.store, deck, url: `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html`, contentOrigin: app.contentOrigin } });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
}

test("image and editable PPTX preserve safe URLs, reordered slide links and transformed group links", { timeout: 60000 }, () => fixture(async ({ args }) => {
  for (const format of ["pptx", "pptx-editable"]) {
    const zip = await JSZip.loadAsync((await exportDeck({ ...args, format })).buffer);
    const xml = parse(await zip.file("ppt/slides/slide2.xml").async("string"));
    const rels = tags(parse(await zip.file("ppt/slides/_rels/slide2.xml.rels").async("string")), "Relationship");
    const links = tags(xml, "a:hlinkClick").map(node => {
      const shape = node.parentNode.parentNode.parentNode;
      const relation = rels.find(rel => rel.getAttribute("Id") === node.getAttribute("r:id"));
      return { node, shape, target: relation?.getAttribute("Target"), mode: relation?.getAttribute("TargetMode") };
    });
    assert.equal(links.length, 4, `${format}: deleted destination is omitted, original and grouped links retained`);
    const web = links.find(link => link.target === "https://example.com/page?a=1&amp;b=2");
    assert.equal(web?.mode, "External");
    assert.ok(links.some(link => link.target === "slide1.xml" && link.node.getAttribute("action") === "ppaction://hlinksldjump"));
    const child = links.find(link => link.target === "https://example.com/child");
    assert.ok(child, "linked child survives its group's raster fallback");
    assert.ok(links.some(link => link.target === "slide3.xml"), "group parent link retained");
    if (format === "pptx-editable") assert.doesNotMatch(await zip.file("ppt/slides/slide2.xml").async("string"), /sd-native-shape-/, "the filtered group remains raster while its links survive");
    const points = tags(child.shape, "a:pt").map(point => [Number(point.getAttribute("x")), Number(point.getAttribute("y"))]);
    assert.equal(points.length, 4);
    assert.notEqual(points[0][1], points[1][1], "rotated child's click area follows its rotation");
    const offset = tags(child.shape, "a:off")[0], size = tags(child.shape, "a:ext")[0];
    assert.ok(Math.abs(Number(offset.getAttribute("x")) / 6350 - 276.795) < 0.02, "scaled group child keeps its world position");
    assert.ok(Math.abs(Number(size.getAttribute("cx")) / 6350 - 273.205) < 0.02, "scaled and rotated group child keeps its world dimensions");
    assert.equal(tags(child.shape, "a:alpha")[0]?.getAttribute("val"), "0", "link overlay is invisible");
  }
}));

test("editable PPTX selects a usable fallback font for original and rich text without changing saved styles", { timeout: 60000 }, () => fixture(async ({ app, deck, args }) => {
  deck.state.added.push({ id: "a-font", slide: "s0", kind: "text", x: 100, y: 750, w: 1000, h: 150,
    text: "Fallback font", richText: { paragraphs: [{ runs: [{ text: "Fallback font", fontFamily: '"Definitely Missing SDLAB Font", "Times New Roman", serif', fontSize: 40 }] }] } });
  deck = await app.store.save(deck.id, deck.revision, deck.state);
  const zip = await JSZip.loadAsync((await exportDeck({ ...args, deck, format: "pptx-editable" })).buffer);
  const xml = await zip.file("ppt/slides/slide2.xml").async("string");
  assert.doesNotMatch(xml, /Definitely Missing SDLAB Font/);
  assert.match(xml, /typeface="Arial"/);
  assert.match(xml, /typeface="Times New Roman"/);
  assert.equal((await app.store.get(deck.id)).state.added.at(-1).richText.paragraphs[0].runs[0].fontFamily, '"Definitely Missing SDLAB Font", "Times New Roman", serif');
}));

test("PPTX ignores unsafe and hidden links and crops visible links to overflow containers and slide edges", { timeout: 60000 }, () => fixture(async ({ app }) => {
  const link = url => `data-sd-link='${JSON.stringify({ type: "url", url })}'`;
  const prepared = prepareDeck(`<html><head><style>body{margin:0}#stage{position:relative;width:1920px;height:1080px}.slide{position:absolute;inset:0}.link{position:absolute;width:200px;height:100px;background:red}</style></head><body><main id="stage"><section class="slide active">
    <div class="link" style="left:1850px;top:100px" ${link("https://example.com/edge")}></div>
    <div style="position:absolute;left:400px;top:300px;width:100px;height:100px;overflow:hidden"><div class="link" ${link("https://example.com/clipped")}></div></div>
    <div style="position:absolute;left:400px;top:500px;width:100px;height:100px;overflow:hidden;rotate:30deg"><div class="link" ${link("https://example.com/rotated-clip")}></div></div>
    <div class="link" style="left:800px;top:600px;clip-path:circle(50%)" ${link("https://example.com/masked")}></div>
    <div class="link" style="left:1000px;top:600px;clip:rect(0px,0px,0px,0px)" ${link("https://example.com/legacy-clip")}></div>
    <div style="filter:opacity(0)"><div class="link" style="left:1200px;top:600px" ${link("https://example.com/filter-hidden")}></div></div>
    <div class="link" style="display:none" ${link("https://example.com/hidden")}></div>
    <div class="link" ${link("javascript:alert(1)")}></div>
  </section></main></body></html>`);
  const deck = await app.store.create({ ...prepared, files: new Map([["index.html", Buffer.from(prepared.html)]]) });
  const zip = await JSZip.loadAsync((await exportDeck({ store: app.store, deck, format: "pptx", url: `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html`, contentOrigin: app.contentOrigin })).buffer);
  const xml = parse(await zip.file("ppt/slides/slide1.xml").async("string"));
  const relXml = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
  assert.doesNotMatch(relXml, /javascript:|example.com\/(hidden|masked|legacy-clip|filter-hidden)/);
  const rels = tags(parse(relXml), "Relationship");
  const widthFor = suffix => {
    const id = rels.find(rel => rel.getAttribute("Target")?.endsWith(suffix))?.getAttribute("Id");
    const node = tags(xml, "a:hlinkClick").find(node => node.getAttribute("r:id") === id);
    return Number(tags(node.parentNode.parentNode.parentNode, "a:ext")[0].getAttribute("cx")) / 6350;
  };
  assert.equal(widthFor("/edge"), 70);
  assert.equal(widthFor("/clipped"), 100);
  assert.ok(Math.abs(widthFor("/rotated-clip") - 136.60254) < 0.02);
  assert.match(await zip.file("ppt/notesSlides/notesSlide1.xml").async("string"), /링크 3개는 PPTX에서 제외/);
}));
