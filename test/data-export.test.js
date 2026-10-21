import test from "node:test";
import assert from "node:assert/strict";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { DOMParser, parseHTML } from "linkedom";
import * as DataExport from "../src/data-export.js";

const { addDataObject } = DataExport;

const parse = xml => new DOMParser().parseFromString(xml, "text/xml");
const tags = (node, name) => [...node.getElementsByTagName(name)];
async function output(objects) {
  const pptx = new PptxGenJS(); pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  objects.forEach((object, index) => addDataObject(slide, object, `data-${index}`));
  return JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }));
}

test("native table output keeps frame, equal row heights, editable text and explicit cell styling", async () => {
  const zip = await output([{ kind: "table", x: 144, y: 72, w: 720, h: 288, table: { rows: [["이름", "값"], ["<safe & text>", "42"]], header: true, fontSize: 28, color: "#123456", fill: "#abcdef", headerFill: "#fedcba", border: "#456789" } }]);
  const doc = parse(await zip.file("ppt/slides/slide1.xml").async("string"));
  const frame = tags(doc, "p:graphicFrame")[0], table = tags(frame, "a:tbl")[0];
  assert.ok(table, "native editable table required");
  assert.deepEqual(tags(table, "a:tr").map(node => node.getAttribute("h")), ["914400", "914400"]);
  assert.deepEqual(tags(table, "a:gridCol").map(node => node.getAttribute("w")), ["2286000", "2286000"]);
  assert.equal(tags(frame, "a:off")[0].getAttribute("x"), "914400");
  assert.equal(tags(frame, "a:ext")[0].getAttribute("cy"), "1828800");
  assert.ok(tags(table, "a:t").some(node => node.textContent === "<safe & text>"));
  assert.ok(tags(table, "a:rPr").every(node => node.getAttribute("sz") === "1400"));
  const cells = tags(table, "a:tc");
  assert.ok(tags(cells[0], "a:srgbClr").some(node => node.getAttribute("val") === "FEDCBA"));
  assert.ok(tags(cells[2], "a:srgbClr").some(node => node.getAttribute("val") === "ABCDEF"));
  assert.ok(tags(cells[2], "a:srgbClr").some(node => node.getAttribute("val") === "456789"));
  assert.equal(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 1);
});

test("bar, line and pie exports are native charts with editable embedded workbooks and exact data", async () => {
  const objects = ["bar", "line", "pie"].map((type, i) => ({ kind: "chart", x: 144, y: 72, w: 720, h: 400, chart: { type, categories: ["한글 & A", "B"], series: [{ name: "실적", values: type === "pie" ? [10, 30] : [-10, 30] }], colors: ["#123abc", "#ef4567"], fontSize: 24 } }));
  const zip = await output(objects);
  const slide = parse(await zip.file("ppt/slides/slide1.xml").async("string"));
  assert.equal(tags(slide, "c:chart").length, 3);
  assert.equal(tags(slide, "p:pic").length, 0);
  for (const [i, kind] of ["bar", "line", "pie"].entries()) {
    const xml = await zip.file(/^ppt\/charts\/chart\d+\.xml$/)[i].async("string"), doc = parse(xml);
    assert.equal(tags(doc, `c:${kind}Chart`).length, 1);
    assert.ok(tags(doc, "c:v").some(node => node.textContent === "한글 & A"));
    assert.ok(tags(doc, "c:v").some(node => node.textContent === (kind === "pie" ? "10" : "-10")));
    assert.ok(tags(doc, "a:srgbClr").some(node => node.getAttribute("val") === "123ABC"));
    assert.equal(tags(doc, "c:externalData").length, 1);
    if (kind !== "pie") {
      assert.equal(tags(doc, "c:min")[0].getAttribute("val"), "-10");
      assert.equal(tags(doc, "c:max")[0].getAttribute("val"), "30");
    }
  }
  const workbooks = Object.keys(zip.files).filter(name => /^ppt\/embeddings\/.*\.xlsx$/.test(name));
  assert.equal(workbooks.length, 3);
  const workbook = await JSZip.loadAsync(await zip.file(workbooks[0]).async("nodebuffer"));
  const sheet = await workbook.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(sheet, /<v>-10<\/v>/);
  assert.match(sheet, /<v>30<\/v>/);
  const strings = await workbook.file("xl/sharedStrings.xml").async("string");
  assert.match(strings, /한글 &amp; A/);
});

test("data output rejects unsupported rotations, groups and invalid frames before adding objects", () => {
  const pptx = new PptxGenJS(), slide = pptx.addSlide();
  const base = { kind: "table", x: 0, y: 0, w: 100, h: 100 };
  for (const object of [{ ...base, rotate: 5 }, { ...base, group: {} }, { ...base, w: 0 }, { ...base, x: NaN }, { ...base, kind: "image" }, { ...base, table: { rows: [[null]] } }]) {
    assert.throws(() => addDataObject(slide, object, "invalid"));
  }
  assert.equal(slide._slideObjects.length, 0);
});

test("mixed native content has unique shape IDs after table finalization, with stable names and references", async () => {
  const pptx = new PptxGenJS();
  for (let index = 0; index < 2; index++) {
    const slide = pptx.addSlide();
    slide.addText("Existing", { x: 0, y: 0, w: 1, h: 1, objectName: "existing" });
    addDataObject(slide, { kind: "table", x: 0, y: 144, w: 400, h: 200 }, "table");
    addDataObject(slide, { kind: "chart", x: 500, y: 0, w: 400, h: 200 }, "chart");
    addDataObject(slide, { kind: "table", x: 0, y: 400, w: 400, h: 200 }, "second-table");
  }
  const raw = await pptx.write({ outputType: "nodebuffer" });
  const result = DataExport.finalizeDataPptx ? await DataExport.finalizeDataPptx(raw) : raw;
  const zip = await JSZip.loadAsync(result);
  for (let index = 1; index <= 2; index++) {
    const doc = parse(await zip.file(`ppt/slides/slide${index}.xml`).async("string"));
    const nodes = tags(doc, "p:cNvPr"), ids = nodes.map(node => node.getAttribute("id"));
    assert.equal(new Set(ids).size, ids.length, "PowerPoint shape IDs must be unique even when tables follow text or charts");
    assert.equal(nodes.find(node => node.getAttribute("name") === "existing").getAttribute("id"), "2");
    assert.equal(nodes.find(node => node.getAttribute("name") === "chart").getAttribute("id"), "4");
    assert.equal(tags(doc, "c:chart").length, 1);
  }
  if (DataExport.finalizeDataPptx) assert.ok(result.equals(await DataExport.finalizeDataPptx(result)), "finalizer is idempotent");
});

test("single bar series retains series colors and legend semantics instead of per-point overrides", async () => {
  const zip = await output([{ kind: "chart", x: 0, y: 0, w: 720, h: 400, chart: { type: "bar", categories: ["A", "B"], series: [{ name: "Revenue", values: [-2, 3] }], colors: ["#123456", "#abcdef"] } }]);
  const doc = parse(await zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async("string"));
  assert.equal(tags(doc, "c:dPt").length, 0, "single-series bars must not acquire category legend entries");
  assert.equal(tags(doc, "c:invertIfNegative")[0].getAttribute("val"), "0");
  assert.ok(tags(doc, "a:srgbClr").some(node => node.getAttribute("val") === "123456"));
  assert.ok(!tags(doc, "a:srgbClr").some(node => node.getAttribute("val") === "ABCDEF"));
});

test("pie data points repeat the supplied palette deterministically for every category", async () => {
  const zip = await output([{ kind: "chart", x: 0, y: 0, w: 720, h: 400, chart: { type: "pie", categories: ["A", "B", "C", "D", "E"], series: [{ name: "Share", values: [1, 2, 3, 4, 5] }], colors: ["#123456", "#abcdef"] } }]);
  const doc = parse(await zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async("string"));
  assert.deepEqual(tags(doc, "c:dPt").map(point => tags(point, "a:srgbClr")[0].getAttribute("val")), ["123456", "ABCDEF", "123456", "ABCDEF", "123456"]);
});

test("clustered bars occupy the same category width in SVG and native charts with multiple series", async () => {
  const object = { kind: "chart", x: 0, y: 0, w: 720, h: 400, chart: { type: "bar", categories: ["A", "B"], series: [{ name: "S1", values: [1, 2] }, { name: "S2", values: [3, 4] }] } };
  const zip = await output([object]), doc = parse(await zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async("string"));
  const gap = Number(tags(doc, "c:gapWidth")[0].getAttribute("val"));
  const { document } = parseHTML("<div></div>"), host = document.querySelector("div");
  globalThis.SDData.render(host, object);
  const barWidth = Number(host.querySelector("rect[data-sd-value]").getAttribute("width"));
  const categoryWidth = 720 * .81 / 2;
  assert.ok(Math.abs(barWidth * 2 / categoryWidth - 2 / (2 + gap / 100)) < .003, "native bar gap is measured against one bar, not the whole cluster");
});
