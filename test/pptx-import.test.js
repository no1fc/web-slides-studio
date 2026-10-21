import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { parseHTML } from "linkedom";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCJkAAAAASUVORK5CYII=", "base64");
const api = async buffer => (await import("../src/pptx-import.js")).importPptx(buffer);
async function fixture(build = () => {}, layout = "LAYOUT_WIDE") {
  const ppt = new PptxGenJS(); ppt.layout = layout; ppt.title = "가져오기 검증";
  const slide = ppt.addSlide(); build(slide, ppt);
  return ppt.write({ outputType: "nodebuffer" });
}
async function change(buffer, part, edit) {
  const zip = await JSZip.loadAsync(buffer);
  zip.file(part, edit(await zip.file(part).async("string")));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
const slidePart = "ppt/slides/slide1.xml";

test("imports directly positioned rich text, shape labels, original image bytes and speaker notes as editable state", async () => {
  const buffer = await fixture((slide, ppt) => {
    slide.addText([{ text: "굵은 ", options: { bold: true, color: "123456" } }, { text: "글자", options: { italic: true } }], { x: 1, y: 1, w: 4, h: 1, fontSize: 24, margin: 0 });
    slide.addText("도형 이름", { shape: ppt.ShapeType.ellipse, x: 1, y: 3, w: 2, h: 1, fill: { color: "ABCDEF" }, line: { color: "112233", width: 2 }, margin: 0 });
    slide.addShape(ppt.ShapeType.line, { x: 5, y: 1, w: 2, h: 1, line: { color: "123456", width: 2, beginArrowType: "none", endArrowType: "triangle" } });
    slide.addImage({ data: "image/png;base64," + pixel.toString("base64"), x: 8, y: 2, w: 1, h: 1 });
    slide.addNotes("발표자 노트\n둘째 줄");
  });
  const result = await api(buffer);
  assert.equal(result.slides.length, 1);
  assert.equal(result.title, "가져오기 검증");
  assert.match(result.state.notes.s0, /발표자 노트/);
  const rich = result.state.added.find(o => o.kind === "text" && o.text.includes("굵은"));
  assert.equal(rich.x, 144); assert.equal(rich.y, 144);
  assert.equal(rich.richText.paragraphs[0].runs[0].bold, true);
  assert.equal(rich.richText.paragraphs[0].runs[0].color, "#123456");
  assert.equal(rich.richText.paragraphs[0].runs[0].fontSize, 48);
  assert.ok(result.state.added.some(o => o.kind === "shape" && o.shape.type === "ellipse"));
  assert.ok(result.state.added.some(o => o.kind === "text" && o.text === "도형 이름"));
  const arrow = result.state.added.find(o => o.kind === "shape" && o.shape.type === "arrow");
  assert.ok(arrow.rotate > 20 && arrow.rotate < 30, "diagonal line remains diagonal");
  const image = result.state.added.find(o => o.kind === "image");
  assert.ok(result.files.get(image.src).equals(pixel));
  assert.ok(result.files.has("index.html"));
  assert.equal(result.report.counts.objects, result.state.added.length);
  assert.equal(result.report.counts.slides, 1);
  const { validateState } = await import("../src/deck.js");
  assert.deepEqual(validateState(result.state, result), result.state);
});

test("imports simple editable tables and cached bar, line and pie chart data", async () => {
  const buffer = await fixture((slide, ppt) => {
    slide.addTable([["이름", "값"], ["가", "12"], ["나", "24"]], { x: 1, y: 1, w: 4, h: 2, fontSize: 12, border: { color: "112233", pt: 1 }, fill: "FFFFFF", color: "123456" });
    for (const [i, type] of ["bar", "line", "pie"].entries()) slide.addChart(ppt.ChartType[type], [{ name: "실적", labels: ["가", "나"], values: [12, 24] }], { x: 1 + i * 4, y: 4, w: 3, h: 2, showTitle: false, showLegend: false });
  });
  const result = await api(buffer);
  const table = result.state.added.find(o => o.kind === "table");
  assert.deepEqual(table.table.rows, [["이름", "값"], ["가", "12"], ["나", "24"]]);
  const charts = result.state.added.filter(o => o.kind === "chart");
  assert.deepEqual(charts.map(o => o.chart.type), ["bar", "line", "pie"]);
  assert.equal(charts[2].chart.colors.length, 2, "pie slices retain distinct point colors");
  for (const chart of charts) {
    assert.deepEqual(chart.chart.categories, ["가", "나"]);
    assert.deepEqual(chart.chart.series, [{ name: "실적", values: [12, 24] }]);
  }
  const { validateState } = await import("../src/deck.js");
  assert.deepEqual(validateState(result.state, result), result.state);
});

test("rejects non widescreen presentations rather than silently stretching them", async () => {
  await assert.rejects(api(await fixture(() => {}, "LAYOUT_4x3")), /16:9/);
});

test("reports unsupported group, custom shape, effects and inherited content on its owning slide", async () => {
  let buffer = await fixture((slide, ppt) => { slide.addText("keep", { x: 1, y: 1, w: 2, h: 1 }); slide.addShape(ppt.ShapeType.star5, { x: 4, y: 1, w: 2, h: 2 }); });
  buffer = await change(buffer, slidePart, xml => xml.replace("</p:spTree>", '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:txBody><a:p><a:r><a:t>group text</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp></p:spTree>').replace("</p:sld>", '<p:timing/><p:transition><p:wipe/></p:transition></p:sld>'));
  buffer = await change(buffer, "ppt/slideLayouts/slideLayout1.xml", xml => xml.replace("</p:spTree>", '<p:sp><p:txBody><a:p><a:r><a:t>inherited</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>'));
  const result = await api(buffer);
  for (const code of ["unsupported-group", "unsupported-shape", "unsupported-animation", "unsupported-transition", "inherited-layout"]) assert.ok(result.report.warnings.some(w => w.slide === 1 && w.code === code), code);
  assert.ok(result.state.added.some(o => o.text === "keep"));
});

test("never imports an external image and reports the missing visible object", async () => {
  let buffer = await fixture(slide => slide.addImage({ data: "image/png;base64," + pixel.toString("base64"), x: 1, y: 1, w: 2, h: 2 }));
  buffer = await change(buffer, "ppt/slides/_rels/slide1.xml.rels", xml => xml.replace(/Target="\.\.\/media\/[^"]+"/g, 'Target="https://example.invalid/private.png" TargetMode="External"'));
  const result = await api(buffer);
  assert.equal(result.state.added.filter(o => o.kind === "image").length, 0);
  assert.ok(result.report.warnings.some(w => w.slide === 1 && w.code === "external-image"));
  assert.equal([...result.files.keys()].filter(p => p !== "index.html").length, 0);
});

test("rejects DTD, entity declarations, malformed XML and unsafe internal relationship targets", async () => {
  const original = await fixture();
  for (const xml of ['<!DOCTYPE p:sld [<!ENTITY x "bad">]><p:sld/>', '<p:sld><a></p:sld>', '<p:sld a="1" a="2"/>']) await assert.rejects(api(await change(original, slidePart, () => xml)), /XML|DTD|엔티티/);
  await assert.rejects(api(await change(original, "ppt/_rels/presentation.xml.rels", xml => xml.replace(/Target="slides\/slide1.xml"/, 'Target="../../../outside.xml"'))), /관계|경로/);
});

test("rejects invalid geometry and too many slide or editable objects", async () => {
  let buffer = await fixture(slide => slide.addText("x", { x: 1, y: 1, w: 1, h: 1 }));
  buffer = await change(buffer, slidePart, xml => xml.replace('cx="914400"', 'cx="NaN"'));
  await assert.rejects(api(buffer), /위치|크기|geometry|도형/);
  const tooMany = await fixture((slide, ppt) => { for (let i = 1; i < 81; i++) ppt.addSlide(); });
  await assert.rejects(api(tooMany), /80/);
  const objects = await fixture(slide => { for (let i = 0; i < 501; i++) slide.addText("x", { x: 1, y: 1, w: 1, h: 1 }); });
  await assert.rejects(api(objects), /500/);
});

test("rejects ZIP64, duplicate or traversal names, excessive entries and dishonest expanded sizes before import", async () => {
  const original = await fixture();
  const zip64 = Buffer.from(original); zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
  await assert.rejects(api(zip64), /ZIP64/);
  for (const name of ["../escape.xml", "ppt/../../escape.xml", "ppt\\escape.xml"]) {
    const zip = await JSZip.loadAsync(original); zip.file(name, "bad");
    await assert.rejects(api(await zip.generateAsync({ type: "nodebuffer" })), /경로/);
  }
  const zip = await JSZip.loadAsync(original);
  for (let i = 0; i < 2001; i++) zip.file(`junk/x${i}`, "");
  await assert.rejects(api(await zip.generateAsync({ type: "nodebuffer" })), /2,?000/);
  const oversized = Buffer.from(original); const directory = oversized.readUInt32LE(oversized.length - 22 + 16); oversized.writeUInt32LE(65 * 1024 * 1024, directory + 24);
  await assert.rejects(api(oversized), /64MB|크기/);
});

test("rejects duplicate ZIP records, CRC corruption and compressed XML bombs", async () => {
  const original = await fixture();
  const zip = await JSZip.loadAsync(original);
  zip.file("duplicate-a.xml", "<a/>"); zip.file("duplicate-b.xml", "<a/>");
  const duplicate = await zip.generateAsync({ type: "nodebuffer" });
  for (let at = 0; (at = duplicate.indexOf("duplicate-b.xml", at)) !== -1; at += 15) duplicate.write("duplicate-a.xml", at);
  await assert.rejects(api(duplicate), /중복/);
  const corrupt = Buffer.from(original), token = corrupt.indexOf("<p:presentation"); assert.ok(token > 0);
  corrupt[token + 3] = 120;
  await assert.rejects(api(corrupt), /CRC/);
  const bomb = await JSZip.loadAsync(original); bomb.file("bomb.xml", "<a>" + "x".repeat(2 * 1024 * 1024) + "</a>");
  await assert.rejects(api(await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })), /압축 비율/);
});

test("preserves line breaks in table cells and notes and warns about embedded video posters", async () => {
  let buffer = await fixture(slide => {
    slide.addTable([["one", "two"]], { x: 1, y: 1, w: 3, h: 1 });
    slide.addNotes("before");
    slide.addImage({ data: "image/png;base64," + pixel.toString("base64"), x: 6, y: 1, w: 1, h: 1 });
  });
  buffer = await change(buffer, slidePart, xml => xml.replace("<a:t>one</a:t>", "<a:t>one</a:t></a:r><a:br/><a:r><a:t>after</a:t>").replace(/(<p:pic>[\s\S]*?)<p:nvPr><\/p:nvPr>/, '$1<p:nvPr><a:videoFile r:link="missing"/></p:nvPr>'));
  buffer = await change(buffer, "ppt/notesSlides/notesSlide1.xml", xml => xml.replace("<a:t>before</a:t>", "<a:t>before</a:t></a:r><a:br/><a:r><a:t>after</a:t>"));
  const result = await api(buffer);
  assert.equal(result.state.added.find(o => o.kind === "table").table.rows[0][0], "one\nafter");
  assert.equal(result.state.notes.s0, "before\nafter");
  assert.ok(result.report.warnings.some(w => w.slide === 1 && w.code === "unsupported-media"));
});

test("counts unsupported objects and nested groups against the source object limit", async () => {
  const buffer = await change(await fixture(), slidePart, xml => xml.replace("</p:spTree>", '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>' + '<p:sp/>'.repeat(501) + '</p:grpSp></p:spTree>'));
  await assert.rejects(api(buffer), /500/);
});

test("rejects numeric chart data outside the editable range and reports caches that cannot be trusted", async () => {
  const original = await fixture((slide, ppt) => slide.addChart(ppt.ChartType.pie, [{ name: "실적", labels: ["가", "나"], values: [12, 24] }], { x: 1, y: 1, w: 4, h: 3 }));
  const chartPart = Object.keys((await JSZip.loadAsync(original)).files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const invalid = await change(original, chartPart, xml => xml.replace("<c:v>24</c:v>", "<c:v>1000000001</c:v>"));
  await assert.rejects(api(invalid), /차트 값/);
  const absent = await change(original, chartPart, xml => xml.replace(/<c:numCache>[\s\S]*?<\/c:numCache>/, ""));
  const result = await api(absent);
  assert.equal(result.state.added.filter(o => o.kind === "chart").length, 0);
  assert.ok(result.report.warnings.some(w => w.slide === 1 && w.code === "missing-chart-cache"));
});

test("allows 500 plain text boxes without adding invisible duplicate shapes", async () => {
  const result = await api(await fixture(slide => { for (let i = 0; i < 500; i++) slide.addText("x", { x: 1, y: 1, w: 1, h: 1 }); }));
  assert.equal(result.state.added.length, 500);
  assert.ok(result.state.added.every(o => o.kind === "text"));
});

test("provides the presentation bridge with a single stage and one initial active slide", async () => {
  const result = await api(await fixture((slide, ppt) => { slide.addText("first", { x: 1, y: 1, w: 2, h: 1 }); ppt.addSlide().addText("second", { x: 2, y: 2, w: 2, h: 1 }); }));
  const { document } = parseHTML(result.html);
  const stage = document.getElementById("stage");
  assert.ok(stage, "bridge.go scales the #stage container");
  assert.equal(stage.querySelectorAll(".slide").length, 2);
  assert.equal(stage.querySelectorAll(".slide.active").length, 1);
  assert.equal(stage.querySelector(".slide.active").getAttribute("data-sd-slide"), "s0");
});

test("imports finite chart values written in scientific notation", async () => {
  const result = await api(await fixture((slide, ppt) => slide.addChart(ppt.ChartType.line, [{ name: "tiny", labels: ["A", "B"], values: [1e-7, 2e-7] }], { x: 1, y: 1, w: 4, h: 3 })));
  assert.deepEqual(result.state.added.find(o => o.kind === "chart").chart.series[0].values, [1e-7, 2e-7]);
});

test("preserves line chart colors after PowerPoint moves series color into line properties", async () => {
  const original = await fixture((slide, ppt) => slide.addChart(ppt.ChartType.line, [{ name: "A", labels: ["Q1", "Q2"], values: [21, 34] }], { x: 1, y: 1, w: 4, h: 3, chartColors: ["087E77"] }));
  const chartPart = Object.keys((await JSZip.loadAsync(original)).files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const saved = await change(original, chartPart, xml => xml.replace(/(<c:ser>[\s\S]*?<c:spPr>)<a:solidFill>[\s\S]*?<\/a:solidFill>/, "$1"));
  const result = await api(saved);
  assert.deepEqual(result.state.added.find(o => o.kind === "chart").chart.colors, ["#087e77"]);
});

test("resolves URI encoded Korean media names within the package", async () => {
  const original = await fixture(slide => slide.addImage({ data: "image/png;base64," + pixel.toString("base64"), x: 1, y: 1, w: 1, h: 1 }));
  const zip = await JSZip.loadAsync(original), old = Object.keys(zip.files).find(n => /^ppt\/media\/.*\.png$/.test(n));
  zip.file("ppt/media/참고 그림.png", await zip.file(old).async("nodebuffer")); zip.remove(old);
  const relPart = "ppt/slides/_rels/slide1.xml.rels", rels = await zip.file(relPart).async("string");
  zip.file(relPart, rels.replace(/Target="\.\.\/media\/[^"]+"/, `Target="../media/${encodeURIComponent("참고 그림.png")}"`));
  const result = await api(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const image = result.state.added.find(o => o.kind === "image");
  assert.ok(image);
  assert.ok(result.files.get(image.src).equals(pixel));
  assert.equal(result.report.counts.skipped, 0);
});

test("reports unsupported picture masks, borders, stretch offsets and flipped images while retaining image bytes", async () => {
  let buffer = await fixture(slide => slide.addImage({ data: "image/png;base64," + pixel.toString("base64"), x: 1, y: 1, w: 2, h: 2, rounding: true }));
  buffer = await change(buffer, slidePart, xml => xml.replace(/(<p:pic>[\s\S]*?)<a:xfrm>/, '$1<a:xfrm flipH="1">').replace("</p:spPr>", '<a:ln w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr>').replace("<a:fillRect/>", '<a:fillRect l="10000"/>'));
  const result = await api(buffer), image = result.state.added.find(o => o.kind === "image");
  assert.ok(image);
  assert.ok(result.files.get(image.src).equals(pixel));
  for (const code of ["image-geometry", "image-border", "image-layout", "unsupported-flip"]) assert.ok(result.report.warnings.some(w => w.slide === 1 && w.code === code), code);
});
