import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { DOMParser } from "linkedom";
import * as textExport from "../src/text-export.js";

const element = {
  id: "e1", kind: "text", text: "legacy", x: 144, y: 288, w: 720, h: 288,
  fontSize: 40, fontFamily: "Arial", color: "112233", bold: false, align: "left", rotate: 30,
};
async function nativeXml(value) {
  assert.equal(typeof textExport.pptxText, "function", "native rich text mapper is available");
  assert.equal(typeof textExport.finalizeTextPptx, "function", "native paragraphs are preserved in the package");
  const ppt = new pptxgen();
  ppt.layout = "LAYOUT_WIDE";
  const mapped = textExport.pptxText(value, "sd-native-text-0");
  ppt.addSlide().addText(mapped.runs, mapped.options);
  const buffer = await textExport.finalizeTextPptx(await ppt.write({ outputType: "nodebuffer" }), [[mapped]]);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  return { xml, document: new DOMParser().parseFromString(xml, "text/xml") };
}
function tags(node, name) { return Array.from(node.getElementsByTagName(name)); }
test("measured browser line height exports as exact points to avoid cumulative font-metric drift", async () => {
  const { document } = await nativeXml({...element,renderedLineHeights:[76.8],richText:{paragraphs:[{runs:[{text:'Measured',fontSize:64}],lineHeight:1.2}]}});
  const spacing=tags(document,'a:lnSpc')[0];
  assert.equal(tags(spacing,'a:spcPts')[0].getAttribute('val'),'3840');
  assert.equal(tags(spacing,'a:spcPct').length,0);
});

test("PPTX preserves mixed runs, paragraph formatting and the displayed font scale", async () => {
  const { xml, document } = await nativeXml({
    ...element, fontScale: 0.75, padding: { top: 10, right: 20, bottom: 30, left: 40 },
    textBox: { vertical: "middle", autoFit: "shrink", overflow: "visible" },
    richText: { paragraphs: [
      { runs: [
        { text: "한글 ", fontFamily: "맑은 고딕", fontSize: 48, color: "#FF0000", bold: true },
        { text: "styled 😀", fontFamily: "Arial", fontSize: 32, color: "#00AAFF", italic: true, underline: true },
      ], align: "justify", lineHeight: 1.5, spaceAfter: 12, indent: 2, list: "none" },
      { runs: [{ text: "다음", fontSize: 40 }], align: "right", lineHeight: 2, spaceAfter: 0, indent: 0, list: "none" },
    ] },
  });
  const paragraphs = tags(document, "a:p");
  assert.equal(paragraphs.length, 2);
  assert.deepEqual(paragraphs.map(p => tags(p, "a:pPr").length), [1, 1], "one properties node per paragraph");
  const runs = tags(paragraphs[0], "a:r");
  assert.deepEqual(runs.map(r => tags(r, "a:t")[0].textContent), ["한글 ", "styled 😀"]);
  assert.equal(tags(runs[0], "a:rPr")[0].getAttribute("sz"), "1800");
  assert.equal(tags(runs[1], "a:rPr")[0].getAttribute("sz"), "1200");
  assert.equal(tags(runs[0], "a:rPr")[0].getAttribute("b"), "1");
  assert.equal(tags(runs[1], "a:rPr")[0].getAttribute("i"), "1");
  assert.equal(tags(runs[1], "a:rPr")[0].getAttribute("u"), "sng");
  assert.equal(tags(runs[0], "a:ea")[0].getAttribute("typeface"), "맑은 고딕");
  assert.equal(tags(runs[1], "a:srgbClr")[0].getAttribute("val"), "00AAFF");
  assert.equal(tags(paragraphs[0], "a:pPr")[0].getAttribute("algn"), "just");
  assert.equal(tags(paragraphs[1], "a:pPr")[0].getAttribute("algn"), "r");
  assert.equal(tags(paragraphs[0], "a:spcPct")[0].getAttribute("val"), "150000");
  assert.equal(tags(paragraphs[0], "a:spcAft")[0].firstElementChild.getAttribute("val"), "450");
  assert.equal(tags(paragraphs[0], "a:pPr")[0].getAttribute("marL"), "304800", "ordinary paragraph indentation uses the displayed shrink scale");
  assert.equal(tags(document, "a:bodyPr")[0].getAttribute("anchor"), "ctr");
  assert.equal(tags(document, "a:bodyPr")[0].getAttribute("lIns"), "254000");
  assert.equal(tags(document, "a:bodyPr")[0].getAttribute("tIns"), "63500");
  assert.equal(tags(document, "a:xfrm")[1].getAttribute("rot"), "1800000");
  assert.doesNotMatch(xml, /<a:normAutofit/);
});

test("PPTX preserves empty paragraphs and continues numbered lists after nested items", async () => {
  const { document } = await nativeXml({ ...element, richText: { paragraphs: [
    { runs: [{ text: "first" }], list: "number", indent: 0 },
    { runs: [{ text: "nested " }, { text: "bold", bold: true }], list: "bullet", indent: 1 },
    { runs: [{ text: "second" }], list: "number", indent: 0 },
    { runs: [{ text: "" }], list: "none" },
    { runs: [{ text: "restart" }], list: "number", indent: 0 },
  ] } });
  const paragraphs = tags(document, "a:p");
  assert.equal(paragraphs.length, 5);
  assert.deepEqual(tags(document, "a:buAutoNum").map(e => e.getAttribute("startAt")), ["1", "2", "1"]);
  assert.equal(tags(paragraphs[1], "a:buChar").length, 1);
  assert.equal(tags(paragraphs[1], "a:pPr")[0].getAttribute("lvl"), "1");
  assert.equal(tags(paragraphs[1], "a:pPr")[0].getAttribute("marL"), "355600");
  assert.equal(tags(paragraphs[1], "a:pPr")[0].getAttribute("indent"), "-152400");
  assert.equal(tags(paragraphs[3], "a:r").length, 0);
  assert.equal(tags(paragraphs[3], "a:endParaRPr")[0].getAttribute("sz"), "2000");
});

test("PPTX legacy text retains newlines and inherited styles when richText is absent", async () => {
  const { document } = await nativeXml({ ...element, text: "legacy\n\nlast", bold: true, italic: true, underline: true });
  const paragraphs = tags(document, "a:p");
  assert.equal(paragraphs.length, 3);
  assert.deepEqual(tags(document, "a:t").map(e => e.textContent), ["legacy", "last"]);
  assert.equal(tags(document, "a:rPr")[0].getAttribute("sz"), "2000");
  assert.equal(tags(document, "a:rPr")[0].getAttribute("b"), "1");
  assert.equal(tags(document, "a:rPr")[0].getAttribute("i"), "1");
  assert.equal(tags(document, "a:rPr")[0].getAttribute("u"), "sng");
});

test("clipped overflowing text remains in the raster background", () => {
  assert.equal(typeof textExport.canExportNativeText, "function");
  assert.equal(textExport.canExportNativeText({ ...element, textBox: { overflow: "clip" }, textOverflowing: true }), false);
  assert.equal(textExport.canExportNativeText({ ...element, textBox: { overflow: "clip" }, textOverflowing: false }), true);
  assert.equal(textExport.canExportNativeText({ ...element, textBox: { overflow: "visible" }, textOverflowing: true }), true);
  assert.equal(textExport.canExportNativeText(element), true);
});

test("HTML ZIP loads its shared text scripts before the offline viewer for legacy decks", { timeout: 30000 }, async () => {
  const { mkdtemp, readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { chromium } = await import("playwright");
  const { startStudio } = await import("../src/server.js");
  const { importArchive } = await import("../src/archive.js");
  const { exportDeck } = await import("../src/export.js");
  const app = await startStudio({ port: 0, contentPort: 0, root: await mkdtemp(join(tmpdir(), "studio-text-export-")) });
  let browser;
  try {
    const archive = new JSZip();
    archive.file("index.html", '<html><head><title>Text output</title><style>body{margin:0}.slide{position:absolute;width:1920px;height:1080px}h1{font-size:64px}</style></head><body><main id="stage"><section class="slide"><h1>Original</h1></section></main></body></html>');
    let deck = await app.store.create(await importArchive(await archive.generateAsync({ type: "nodebuffer" })));
    deck.state.patches.e0 = { text: "Saved legacy title" };
    deck = await app.store.save(deck.id, 1, deck.state);
    const output = await exportDeck({ store: app.store, deck, format: "html" });
    const zip = await JSZip.loadAsync(output.buffer);
    const html = await zip.file("index.html").async("string");
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(scripts.slice(-3), ["assets/studio-text-model.js", "assets/studio-text-editor.js", "assets/studio-viewer.js"]);
    for (const [source, target] of [["text-model.js", "studio-text-model.js"], ["text-editor.js", "studio-text-editor.js"], ["bridge.js", "studio-viewer.js"]]) {
      assert.equal(await zip.file("assets/" + target).async("string"), await readFile(new URL("../public/" + source, import.meta.url), "utf8"));
    }
    const extracted = await mkdtemp(join(tmpdir(), "studio-text-offline-"));
    for (const file of Object.values(zip.files).filter(file => !file.dir)) {
      const path = join(extracted, file.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await file.async("nodebuffer"));
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(pathToFileURL(join(extracted, "index.html")).href);
    await page.waitForFunction(() => !!window.__sd && !!window.SDText && !!window.SDTextEditor);
    assert.equal(await page.locator('[data-sd-id="e0"]').innerText(), "Saved legacy title");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
  }
});

test("PPTX keeps run newlines as soft breaks inside their source paragraph", async () => {
  const { document } = await nativeXml({ ...element, richText: { paragraphs: [
    { runs: [{ text: "line 1\nline 2\n", bold: false, fontSize: 24 }], list: "number", align: "left" },
    { runs: [{ text: "<&>" }], list: "number", align: "left" },
  ] } });
  const paragraphs = tags(document, "a:p");
  assert.equal(paragraphs.length, 2);
  assert.equal(tags(paragraphs[0], "a:br").length, 2);
  assert.deepEqual(tags(paragraphs[0], "a:t").map(e => e.textContent), ["line 1", "line 2"]);
  assert.equal(tags(paragraphs[1], "a:t")[0].textContent, "<&>");
  assert.equal(tags(paragraphs[0], "a:endParaRPr")[0].getAttribute("sz"), "1200");
});

test("saved rich text reaches offline HTML and editable PPTX while clipped text stays raster", { timeout: 60000 }, async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { chromium } = await import("playwright");
  const { startStudio } = await import("../src/server.js");
  const { importArchive } = await import("../src/archive.js");
  const { exportDeck } = await import("../src/export.js");
  const app = await startStudio({ port: 0, contentPort: 0, root: await mkdtemp(join(tmpdir(), "studio-rich-export-")) });
  let browser;
  try {
    const archive = new JSZip();
    archive.file("index.html", '<html><head><title>Rich output</title><style>body{margin:0}main{width:1920px;height:1080px;position:relative}.slide{position:absolute;inset:0}h1{position:absolute;left:80px;top:80px;width:800px;height:300px;margin:0;font:40px Arial}p{position:absolute;left:80px;top:500px;width:200px;height:20px;margin:0;font:60px Arial}</style></head><body><main id="stage"><section class="slide"><h1>Original</h1><p>Clipped</p></section></main></body></html>');
    let deck = await app.store.create(await importArchive(await archive.generateAsync({ type: "nodebuffer" })));
    deck.state.patches.e0 = {
      richText: { paragraphs: [
        { runs: [
          { text: "첫 번째 ", fontSize: 40, fontFamily: "Arial", color: "#ff0000", bold: true },
          { text: "styled", fontSize: 32, fontFamily: "Arial", color: "#00aaff", bold: false, italic: true, underline: true },
        ], align: "justify", lineHeight: 1.5, spaceAfter: 12, indent: 1, list: "none" },
        { runs: [{ text: "Numbered\nsame item", fontSize: 28, bold: false }], align: "right", lineHeight: 2, list: "number", indent: 0 },
      ] },
      textBox: { vertical: "bottom", autoFit: "none", overflow: "visible" },
    };
    deck.state.patches.e1 = { richText: { paragraphs: [{ runs: [{ text: "Clipped output stays raster", fontSize: 60 }] }] }, textBox: { overflow: "clip", autoFit: "none" } };
    deck = await app.store.save(deck.id, 1, deck.state);
    const args = { store: app.store, deck, url: `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html?rev=${deck.revision}`, contentOrigin: app.contentOrigin };
    const htmlResult = await exportDeck({ ...args, format: "html" });
    const htmlZip = await JSZip.loadAsync(htmlResult.buffer);
    const extracted = await mkdtemp(join(tmpdir(), "studio-rich-offline-"));
    for (const file of Object.values(htmlZip.files).filter(file => !file.dir)) {
      const path = join(extracted, file.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await file.async("nodebuffer"));
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(pathToFileURL(join(extracted, "index.html")).href);
    await page.waitForFunction(() => !!window.__sd);
    assert.equal(await page.locator('[data-sd-id="e0"] [data-sd-run]').count(), 3);
    assert.deepEqual(await page.locator('[data-sd-id="e0"] [data-sd-run]').evaluateAll(runs => runs.map(run => ({ text: run.textContent, italic: getComputedStyle(run).fontStyle, color: getComputedStyle(run).color }))), [
      { text: "첫 번째 ", italic: "normal", color: "rgb(255, 0, 0)" },
      { text: "styled", italic: "italic", color: "rgb(0, 170, 255)" },
      { text: "Numbered\nsame item", italic: "normal", color: "rgb(0, 0, 0)" },
    ]);
    const pptResult = await exportDeck({ ...args, format: "pptx-editable" });
    const pptZip = await JSZip.loadAsync(pptResult.buffer);
    const xml = await pptZip.file("ppt/slides/slide1.xml").async("string");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    assert.equal(tags(doc, "a:buAutoNum").length, 1, "a soft line break inside a numbered paragraph does not create another numbered item");
    assert.equal(tags(doc, "a:br").length, 1);
    assert.deepEqual(tags(doc, "a:t").map(node => node.textContent), ["첫 번째 ", "styled", "Numbered", "same item"]);
    assert.equal(tags(doc, "a:rPr")[1].getAttribute("i"), "1");
    assert.equal(tags(doc, "a:rPr")[1].getAttribute("u"), "sng");
    assert.equal(tags(doc, "a:rPr")[1].getAttribute("sz"), "1600");
    assert.equal(tags(doc, "a:bodyPr")[0].getAttribute("anchor"), "b");
    assert.equal(tags(doc, "a:pPr").length, 2);
  } finally {
    await browser?.close();
    await app.close();
  }
});

test("PPTX safely records a quoted first font family containing a comma and quotes", async () => {
  const { xml, document } = await nativeXml({ ...element, richText: { paragraphs: [{ runs: [{ text: "safe", fontFamily: "'Team, \"Mono\"', Arial" }] }] } });
  assert.equal(tags(document, "a:latin")[0].getAttribute("typeface"), 'Team, "Mono"');
  assert.match(xml, /typeface="Team, &quot;Mono&quot;"/);
});


test("PPTX shrink scales paragraph spacing and list gutters without changing the saved model", async () => {
  const richText = { paragraphs: [{ runs: [{ text: "scaled", fontSize: 40 }], list: "bullet", indent: 1, spaceAfter: 16, lineHeight: 1.5 }] };
  const before = structuredClone(richText);
  const { document } = await nativeXml({ ...element, richText, fontScale: 0.5 });
  const properties = tags(document, "a:pPr")[0];
  assert.equal(properties.getAttribute("marL"), "177800");
  assert.equal(properties.getAttribute("indent"), "-76200");
  assert.equal(tags(document, "a:spcAft")[0].firstElementChild.getAttribute("val"), "400");
  assert.equal(tags(document, "a:spcPct")[0].getAttribute("val"), "150000");
  assert.deepEqual(richText, before);
});

test("editable PPTX resolves omitted rich styles from the rendered element", { timeout: 30000 }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startStudio } = await import("../src/server.js");
  const { importArchive } = await import("../src/archive.js");
  const { exportDeck } = await import("../src/export.js");
  const app = await startStudio({ port: 0, contentPort: 0, root: await mkdtemp(join(tmpdir(), "studio-inherited-export-")) });
  try {
    const archive = new JSZip();
    archive.file("index.html", '<html><head><style>body{margin:0}main{width:1920px;height:1080px;position:relative}.slide{position:absolute;inset:0}h1{position:absolute;left:80px;top:80px;width:1000px;height:200px;margin:0;font:italic bold 40px Georgia;color:#123456;line-height:1.75}</style></head><body><main id="stage"><section class="slide"><h1>Original</h1></section></main></body></html>');
    let deck = await app.store.create(await importArchive(await archive.generateAsync({ type: "nodebuffer" })));
    deck.state.patches.e0 = { richText: { paragraphs: [{ runs: [{ text: "Inherited " }, { text: "Plain", bold: false, italic: false }] }] } };
    deck = await app.store.save(deck.id, 1, deck.state);
    const result = await exportDeck({ store: app.store, deck, format: "pptx-editable", url: `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html?rev=${deck.revision}`, contentOrigin: app.contentOrigin });
    const zip = await JSZip.loadAsync(result.buffer);
    const document = new DOMParser().parseFromString(await zip.file("ppt/slides/slide1.xml").async("string"), "text/xml");
    const runs = tags(document, "a:r");
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(run => tags(run, "a:latin")[0].getAttribute("typeface")), ["Georgia", "Georgia"]);
    assert.deepEqual(runs.map(run => tags(run, "a:rPr")[0].getAttribute("sz")), ["2000", "2000"]);
    assert.deepEqual(runs.map(run => tags(run, "a:srgbClr")[0].getAttribute("val")), ["123456", "123456"]);
    assert.equal(tags(runs[0], "a:rPr")[0].getAttribute("i"), "1");
    assert.equal(tags(runs[0], "a:rPr")[0].getAttribute("b"), "1");
    assert.notEqual(tags(runs[1], "a:rPr")[0].getAttribute("i"), "1");
    assert.notEqual(tags(runs[1], "a:rPr")[0].getAttribute("b"), "1");
    assert.equal(tags(document, "a:spcPct")[0].getAttribute("val"), "175000");
  } finally { await app.close(); }
});
