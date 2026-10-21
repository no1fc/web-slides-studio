import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import JSZip from "jszip";
import { DOMParser } from "linkedom";
import { startStudio } from "../src/server.js";
import { prepareDeck } from "../src/deck.js";
import { exportDeck } from "../src/export.js";

// This is a service integration fixture, not a separate PPTX generator.
// Run sequentially with other browser tests. --base-only excludes stage 7.
const options = process.argv.slice(2);
const option = name => options.includes(name) ? options[options.indexOf(name) + 1] : undefined;
const output = resolve(option("--output") || join(dirname(fileURLToPath(import.meta.url)), "../output/powerpoint"));
const full = !options.includes("--base-only");
const executablePath = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
process.env.CHROME_PATH = executablePath;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(name, bytes) {
  const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([length, type, bytes, crc]);
}
function testPng() {
  const width = 400, height = 240, header = Buffer.alloc(13), pixels = Buffer.alloc((width * 3 + 1) * height);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    const rgb = x < 100 ? [225, 80, 65] : x > 300 ? [30, 125, 190] : y < 70 ? [246, 194, 65] : [34, 151, 113];
    pixels.set(rgb, offset);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}
const shape = (id, slide, type, x, y, w, h, fill, extra = {}) => ({ id, slide, kind: "shape", x, y, w, h, shape: { type, fill, stroke: "#123456", strokeWidth: 4, dash: "solid" }, ...extra });
const text = (id, slide, value, x, y, w, h, extra = {}) => ({ id, slide, kind: "text", text: value, x, y, w, h, fontSize: 44, color: "#142c45", ...extra });
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>PowerPoint service compatibility fixture</title><style>
html,body{margin:0;background:#f3f6fa;font-family:Arial,"Malgun Gothic",sans-serif}
main{position:relative;width:1920px;height:1080px;transform-origin:0 0}
.slide{position:absolute;inset:0;display:none;background:var(--sd-theme-background,#f3f6fa)}
.slide.active{display:block}.notes{display:none}
</style></head><body><main id="stage"><section class="slide active"></section>${full ? '<section class="slide"></section>' : ""}</main></body></html>`;

await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "sd-powerpoint-qa-"));
let app, browser;
try {
  app = await startStudio({ port: 0, contentPort: 0, root: scratch });
  const prepared = prepareDeck(html);
  let deck = await app.store.create({ ...prepared, files: new Map([["index.html", Buffer.from(prepared.html)], ["assets/crop-source.png", testPng()]]) });
  deck.state.theme = { colors: { background: "#f3f6fa", text: "#142c45", accent: "#087e77" }, fonts: { heading: "Malgun Gothic", body: "Malgun Gothic" } };
  deck.state.notes.s0 = "PowerPoint 검증 발표자 노트 — 한글과 Unicode Ω ✓, 첫 번째 슬라이드.";
  deck.state.added.push(
    text("a-qa-title", "s0", "PowerPoint 호환성 — 한글 Ω ✓", 90, 70, 1740, 100, { fontSize: 72 }),
    text("a-qa-rich", "s0", "", 90, 220, 940, 280, { fontSize: 42, richText: { paragraphs: [
      { runs: [{ text: "굵게 Bold", bold: true, colorTheme: "accent", fontTheme: "heading", fontSize: 52 }, { text: " / italic", italic: true, fontSize: 42 }], spaceAfter: 16, lineHeight: 1.2 },
      { runs: [{ text: "목록 1: 한국어, English, 숫자 123", fontSize: 40 }], list: "bullet", indent: 0, spaceAfter: 12 },
      { runs: [{ text: "목록 2: 밑줄 및 정렬", underline: true, fontSize: 40 }], list: "number", indent: 0 },
    ] }, textBox: { autoFit: "none", overflow: "visible" } }),
    shape("a-qa-rect", "s0", "rect", 90, 590, 360, 160, "#e3a14f", { rotate: 12 }),
    shape("a-qa-ellipse", "s0", "ellipse", 500, 590, 270, 160, "#67b3c5"),
    shape("a-qa-arrow", "s0", "arrow", 820, 645, 210, 50, "none", { shape: { type: "arrow", fill: "none", stroke: "#087e77", strokeWidth: 9, dash: "dash" } }),
    { id: "a-qa-image", slide: "s0", kind: "image", x: 1140, y: 235, w: 620, h: 330, src: "assets/crop-source.png", image: { mode: "stretch", crop: { left: .12, right: .08, top: .08, bottom: .12 } } },
    { id: "a-qa-group", slide: "s0", kind: "group", x: 1130, y: 660, w: 600, h: 240, rotate: -5, group: { width: 600, height: 240, children: [
      { kind: "shape", x: 0, y: 0, w: 600, h: 240, shape: { type: "rect", fill: "#d9e9df", stroke: "#087e77", strokeWidth: 3, dash: "solid" } },
      { kind: "text", x: 50, y: 65, w: 500, h: 110, text: "그룹 안의 편집 가능한 글", fontSize: 40, color: "#142c45" },
    ] } },
    shape("a-qa-layer", "s0", "rect", 90, 850, 850, 110, "#dee5f2", { z: 30 }),
    text("a-qa-layer-text", "s0", "레이어 위의 글 / editable overlay", 120, 875, 800, 75, { fontSize: 36, z: 31 }),
  );
  if (full) {
    deck.state.notes.s1 = "표, 막대/꺾은선/원형 차트는 PowerPoint에서 셀과 데이터 수정 후 저장을 검증합니다.";
    deck.state.added.push(
      text("a-qa-data-title", "s1", "네이티브 표와 차트 데이터", 90, 55, 1740, 100, { fontSize: 65 }),
      { id: "a-qa-table", slide: "s1", kind: "table", x: 90, y: 185, w: 1740, h: 260, table: { rows: [["구분", "2025", "2026"], ["한국", "21", "34"], ["Japan", "13", "29"]], header: true, fontSize: 36, color: "#142c45", fill: "#ffffff", headerFill: "#d9e9df", border: "#8696a5" } },
      ...["bar", "line", "pie"].map((type, i) => ({ id: `a-qa-${type}`, slide: "s1", kind: "chart", x: 90 + i * 590, y: 540, w: 560, h: 420, chart: { type, categories: ["Q1", "Q2", "Q3"], series: type === "pie" ? [{ name: "Share", values: [21, 34, 18] }] : [{ name: "Alpha", values: [21, 34, 18] }, { name: "Beta", values: [13, 26, 31] }], colors: ["#087e77", "#e3a14f", "#67b3c5"], fontSize: 25 } })),
    );
    deck.state.transitions = { s0: "fade", s1: "push" };
    deck.state.animations = { "a-qa-title": "appear", "a-qa-table": "fade", "a-qa-bar": "appear" };
  }
  deck = await app.store.save(deck.id, deck.revision, deck.state);
  const url = `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html?rev=${deck.revision}`;
  const artifact = await exportDeck({ store: app.store, deck, format: "pptx-editable", url, contentOrigin: app.contentOrigin });
  const pptxPath = join(output, "fixture.pptx");
  await writeFile(pptxPath, artifact.buffer);
  await writeFile(join(output, "fixture-state.json"), JSON.stringify(deck.state, null, 2));
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__sd));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.__sd.clean());
  const slides = [];
  for (let i = 0; i < deck.state.order.length; i++) {
    await page.evaluate(n => window.__sd.go(n), i);
    await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode().catch(() => {}))); window.SDObjects?.refresh(document); });
    await page.screenshot({ path: join(output, `browser-slide-${i + 1}.png`) });
    slides.push({ index: i + 1, id: deck.state.order[i], objects: await page.evaluate(() => window.__sd.collect()) });
  }
  const zip = await JSZip.loadAsync(artifact.buffer);
  const slideDoc = new DOMParser().parseFromString(await zip.file("ppt/slides/slide1.xml").async("string"), "text/xml");
  const nativeShapes = [...slideDoc.getElementsByTagName("p:sp")];
  const title = nativeShapes.find(node => [...node.getElementsByTagName("a:t")].some(t => t.textContent.includes("PowerPoint 호환성")));
  const rotated = nativeShapes.find(node => [...node.getElementsByTagName("a:solidFill")].some(fill => fill.getElementsByTagName("a:srgbClr")[0]?.getAttribute("val")?.toLowerCase() === "e3a14f"));
  if (!title || !rotated) throw new Error("Production export did not create expected editable native objects.");
  const manifest = {
    generatedAt: new Date().toISOString(), generator: "production startStudio + Store.save + exportDeck(pptx-editable)",
    pptx: pptxPath, sha256: createHash("sha256").update(artifact.buffer).digest("hex"), revision: deck.revision,
    full, slideCount: deck.state.order.length, slideSizePoints: { width: 960, height: 540 },
    required: { nativeText: full ? 5 : 4, nativeShapes: 5, croppedImages: 1, tables: full ? 1 : 0, charts: full ? 3 : 0, transitions: full ? 2 : 0, animations: full ? 3 : 0 },
    expectedGeometry: [
      { slide: 1, name: title.getElementsByTagName("p:cNvPr")[0].getAttribute("name"), x: 45, y: 35, w: 870, h: 50, rotation: 0 },
      { slide: 1, name: rotated.getElementsByTagName("p:cNvPr")[0].getAttribute("name"), x: 46, y: 296, w: 178, h: 78, rotation: 12 },
    ],
    notesMarker: "PowerPoint 검증 발표자 노트", richTextMarker: "굵게 Bold", groupTextMarker: "그룹 안의 편집 가능한 글",
    expectedEffects: full ? [{ slide: 1, transition: [1793, 3849], animationTypes: [1] }, { slide: 2, transition: [3853], animationTypes: [1, 10] }] : [],
    exportWarnings: artifact.warnings || [], slides,
  };
  await writeFile(join(output, "fixture-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ pptxPath, manifest: join(output, "fixture-manifest.json"), slides: slides.length, full }, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith("sd-powerpoint-qa-")) throw new Error("Unexpected scratch path; refusing recursive cleanup.");
  await rm(scratch, { recursive: true, force: true });
}
