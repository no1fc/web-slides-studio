import JSZip from "jszip";
import path from "node:path";
import { DOMParser } from "linkedom";
import { readBounded, MAX_EXPANDED } from "./archive.js";
import { prepareDeck, initialState, validateState } from "./deck.js";
import "../public/data-model.js";

const MAX_ZIP = 40 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const local = node => (node?.localName || node?.nodeName || "").split(":").at(-1);
const children = (node, name) => [...(node?.children || [])].filter(child => !name || local(child) === name);
const one = (node, name) => children(node, name)[0];
const descendants = (node, name) => [...(node?.querySelectorAll("*") || [])].filter(child => local(child) === name);
const first = (node, name) => descendants(node, name)[0];
const attr = (node, name) => node?.getAttribute(name);
const truth = value => value === "1" || value === "true";
const bodyText = body => children(body, "p").map(p => children(p).map(n => local(n) === "br" ? "\n" : ["r", "fld"].includes(local(n)) ? one(n, "t")?.textContent || "" : "").join("")).join("\n");
const round = value => Math.round(value * 1e6) / 1e6;
const esc = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";

function entryPath(name) {
  if (!name || name.length > 240 || /[\\:%?#\x00-\x1f\x7f]/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("PPTX ZIP 파일 경로 오류");
  return name;
}

// JSZip normalizes ../ names and overwrites duplicates: inspect the untrusted
// central directory and local records before it sees any bytes.
function inspectZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ZIP) throw new Error("PPTX는 40MB까지 올릴 수 있습니다.");
  let end = -1;
  for (let pos = buffer.length - 22; pos >= Math.max(0, buffer.length - 65557); pos--) {
    if (buffer.readUInt32LE(pos) === 0x06054b50 && pos + 22 + buffer.readUInt16LE(pos + 20) === buffer.length) { end = pos; break; }
  }
  if (end < 0) throw new Error("PPTX ZIP 디렉터리 오류");
  const count = buffer.readUInt16LE(end + 10), offset = buffer.readUInt32LE(end + 16), size = buffer.readUInt32LE(end + 12);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || count === 0xffff || offset === 0xffffffff || size === 0xffffffff || end >= 20 && buffer.readUInt32LE(end - 20) === 0x07064b50) throw new Error("분할 ZIP 또는 ZIP64는 지원하지 않습니다.");
  if (count !== buffer.readUInt16LE(end + 8) || offset + size !== end) throw new Error("PPTX ZIP 디렉터리 크기 오류");
  if (count > MAX_ENTRIES) throw new Error("PPTX ZIP 항목은 2,000개까지입니다.");
  let pos = offset, expanded = 0;
  const names = new Set(), records = new Map(), ranges = [];
  const extras = (start, length) => {
    for (let p = start; p < start + length;) {
      if (p + 4 > start + length) throw new Error("PPTX ZIP 추가 필드 오류");
      const id = buffer.readUInt16LE(p), n = buffer.readUInt16LE(p + 2); p += 4;
      if (id === 1) throw new Error("ZIP64는 지원하지 않습니다.");
      if (p + n > start + length) throw new Error("PPTX ZIP 추가 필드 오류");
      p += n;
    }
  };
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error("PPTX ZIP 항목 오류");
    const flags = buffer.readUInt16LE(pos + 8), method = buffer.readUInt16LE(pos + 10), compressed = buffer.readUInt32LE(pos + 20), uncompressed = buffer.readUInt32LE(pos + 24);
    const n = buffer.readUInt16LE(pos + 28), extra = buffer.readUInt16LE(pos + 30), comment = buffer.readUInt16LE(pos + 32), start = buffer.readUInt32LE(pos + 42);
    if (pos + 46 + n + extra + comment > end || buffer.readUInt16LE(pos + 34)) throw new Error("PPTX ZIP 항목 오류");
    if ([compressed, uncompressed, start].includes(0xffffffff)) throw new Error("ZIP64는 지원하지 않습니다.");
    if (flags & 0x41 || ![0, 8].includes(method)) throw new Error("암호화 또는 지원하지 않는 ZIP 압축 방식입니다.");
    const nameBytes = buffer.subarray(pos + 46, pos + 46 + n), name = nameBytes.toString("utf8");
    if (!Buffer.from(name).equals(nameBytes)) throw new Error("PPTX ZIP 파일 이름 인코딩 오류");
    entryPath(name.endsWith("/") ? name.slice(0, -1) : name);
    const key = name.normalize("NFC").toLowerCase();
    if (names.has(key)) throw new Error("중복 PPTX ZIP 파일 경로입니다."); names.add(key);
    if (((buffer.readUInt32LE(pos + 38) >>> 16) & 0o170000) === 0o120000) throw new Error("PPTX 심볼릭 링크는 허용되지 않습니다.");
    expanded += uncompressed;
    if (expanded > MAX_EXPANDED) throw new Error("PPTX 압축 해제 크기는 64MB까지입니다.");
    if (uncompressed > 1024 * 1024 && uncompressed > Math.max(1, compressed) * 200) throw new Error("PPTX ZIP 압축 비율이 너무 높습니다.");
    extras(pos + 46 + n, extra);
    if (start + 30 > offset || buffer.readUInt32LE(start) !== 0x04034b50) throw new Error("PPTX ZIP 로컬 항목 오류");
    const ln = buffer.readUInt16LE(start + 26), le = buffer.readUInt16LE(start + 28), data = start + 30 + ln + le;
    if (data + compressed > offset || flags !== buffer.readUInt16LE(start + 6) || method !== buffer.readUInt16LE(start + 8) || !nameBytes.equals(buffer.subarray(start + 30, start + 30 + ln))) throw new Error("PPTX ZIP 로컬 항목 불일치");
    if (!(flags & 8) && (buffer.readUInt32LE(start + 18) !== compressed || buffer.readUInt32LE(start + 22) !== uncompressed)) throw new Error("PPTX ZIP 압축 크기 불일치");
    extras(start + 30 + ln, le); ranges.push([start, data + compressed]);
    records.set(name, { size: uncompressed, crc: buffer.readUInt32LE(pos + 16) });
    pos += 46 + n + extra + comment;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i && range[0] < ranges[i - 1][1]) || pos !== end) throw new Error("PPTX ZIP 항목 범위 오류");
  return records;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

function parseXml(bytes, part) {
  if (bytes.length > 8 * 1024 * 1024) throw new Error("PPTX XML 파일은 8MB까지입니다.");
  const xml = bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("PPTX XML DTD 또는 엔티티 선언은 허용되지 않습니다.");
  const entities = text => {
    if (/&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[\da-fA-F]+);)/.test(text)) throw new Error("PPTX XML 엔티티 오류");
    for (const entity of text.matchAll(/&#(x[\da-fA-F]+|\d+);/g)) {
      const n = entity[1][0] === "x" ? parseInt(entity[1].slice(1), 16) : Number(entity[1]);
      if (!(n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 0xfffe && n !== 0xffff)) throw new Error("PPTX XML 문자 엔티티 오류");
    }
  };
  // linkedom deliberately repairs malformed markup. Validate XML nesting,
  // quoted attributes and entities before using it as a read-only tree.
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/[A-Za-z_][\w.:-]*\s*>|<[A-Za-z_][\w.:-]*(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
  let match, position = 0, roots = 0, nodes = 0; const stack = [];
  while ((match = token.exec(xml))) {
    position = token.lastIndex; const value = match[0];
    if (++nodes > 200000) throw new Error("PPTX XML 항목이 너무 많습니다.");
    if (value.startsWith("<!--") || value.startsWith("<?")) continue;
    if (value.startsWith("<![CDATA[")) { if (!stack.length) throw new Error("PPTX XML CDATA 위치 오류"); continue; }
    if (value.startsWith("</")) { if (stack.pop() !== value.slice(2, -1).trim()) throw new Error("PPTX XML 닫는 태그 오류"); continue; }
    if (value.startsWith("<")) {
      entities(value); const name = /^<([^\s/>]+)/.exec(value)[1];
      const attributes = [...value.matchAll(/\s+([A-Za-z_][\w.:-]*)\s*=/g)].map(m => m[1]);
      if (new Set(attributes).size !== attributes.length) throw new Error("PPTX XML 중복 속성 오류");
      if (!stack.length && ++roots > 1) throw new Error("PPTX XML 루트 오류");
      if (!value.endsWith("/>")) stack.push(name);
      if (stack.length > 128) throw new Error("PPTX XML 중첩 깊이가 너무 큽니다.");
    } else { entities(value); if (!stack.length && value.trim()) throw new Error("PPTX XML 루트 밖 텍스트 오류"); }
  }
  if (position !== xml.length || stack.length || roots !== 1) throw new Error(`PPTX XML 형식 오류: ${part}`);
  return new DOMParser().parseFromString(xml, "text/xml");
}

function relationshipTarget(part, target) {
  if (typeof target !== "string" || !target || /[\\:#?\x00-\x20\x7f]/.test(target)) throw new Error("PPTX 내부 관계 경로 오류");
  let decoded; try { decoded = decodeURIComponent(target); } catch { throw new Error("PPTX 관계 경로 인코딩 오류"); }
  if (/[\\:%#?\x00-\x1f\x7f]/.test(decoded)) throw new Error("PPTX 내부 관계 경로 오류");
  const resolved = path.posix.normalize(decoded.startsWith("/") ? decoded.slice(1) : path.posix.join(path.posix.dirname(part), decoded));
  return entryPath(resolved);
}

function numeric(value, label, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, exponent = false) {
  const syntax = exponent ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/ : /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (typeof value !== "string" || !syntax.test(value) || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`PPTX ${label} 값 오류`);
  return Number(value);
}

export async function importPptx(buffer) {
  const records = inspectZip(buffer), zip = await JSZip.loadAsync(buffer), parts = new Map(), xmls = new Map();
  let expanded = 0;
  for (const [name, record] of records) {
    const entry = zip.files[name];
    if (!entry) throw new Error("PPTX ZIP 항목 불일치");
    const bytes = await readBounded(entry, MAX_EXPANDED - expanded); expanded += bytes.length;
    if (bytes.length !== record.size || crc32(bytes) !== record.crc) throw new Error("PPTX ZIP 압축 해제 크기 또는 CRC 오류");
    if (entry.dir) continue;
    parts.set(name, bytes);
    if (/\.(xml|rels)$/i.test(name) || name === "[Content_Types].xml") xmls.set(name, parseXml(bytes, name));
  }
  if (!xmls.has("[Content_Types].xml") || attr(xmls.get("[Content_Types].xml").documentElement, "xmlns") !== contentTypes || !xmls.has("ppt/presentation.xml")) throw new Error("올바른 PPTX 프레젠테이션이 아닙니다.");
  const warnings = [], counts = { slides: 0, objects: 0, texts: 0, shapes: 0, images: 0, tables: 0, charts: 0, notes: 0, skipped: 0 };
  const warn = (slide, code, message) => { warnings.push({ slide, code, message }); if (warnings.length > 10000) throw new Error("PPTX 경고 항목이 너무 많습니다."); };
  const rels = new Map();
  for (const [name, doc] of xmls) {
    if (!name.endsWith(".rels")) continue;
    const part = name === "_rels/.rels" ? "" : name.replace(/(^|\/)\_rels\//, "$1").slice(0, -5), map = new Map();
    for (const rel of children(doc.documentElement, "Relationship")) {
      const id = attr(rel, "Id"), type = attr(rel, "Type")?.split("/").at(-1), external = attr(rel, "TargetMode") === "External", target = attr(rel, "Target");
      if (!id || map.has(id) || !type || !target) throw new Error("PPTX 중복 또는 잘못된 관계입니다.");
      const resolved = external ? null : relationshipTarget(part, target);
      map.set(id, { type, external, target: resolved });
      if (external) warn(null, "external-relationship", `${part || "프레젠테이션"}: 외부 ${type} 연결을 읽거나 가져오지 않습니다.`);
      if (!external && !parts.has(resolved)) warn(null, "missing-part", `${part || "프레젠테이션"}: 연결된 ${type} 파일이 없습니다.`);
    }
    rels.set(part, map);
  }
  const presentation = xmls.get("ppt/presentation.xml"), size = first(presentation, "sldSz");
  const width = numeric(attr(size, "cx"), "슬라이드 크기", 1), height = numeric(attr(size, "cy"), "슬라이드 크기", 1);
  if (Math.abs(width / height - 16 / 9) > 0.0001) throw new Error("PPTX 가져오기는 16:9 슬라이드만 지원합니다.");
  const scale = 1920 / width, pointScale = 12700 * scale;
  const slideIds = children(first(presentation, "sldIdLst"), "sldId");
  if (!slideIds.length || slideIds.length > 80) throw new Error("PPTX 슬라이드는 1~80개까지입니다.");
  counts.slides = slideIds.length;
  const theme = [...xmls.entries()].find(([name]) => /^ppt\/theme\/theme\d+\.xml$/.test(name))?.[1];
  const palette = { dk1: "#000000", lt1: "#ffffff", dk2: "#1f497d", lt2: "#eeece1", tx1: "#000000", bg1: "#ffffff", accent1: "#4472c4", accent2: "#ed7d31", accent3: "#a5a5a5", accent4: "#ffc000", accent5: "#5b9bd5", accent6: "#70ad47", hlink: "#0563c1", folHlink: "#954f72" };
  for (const entry of children(first(theme, "clrScheme"))) { const c = children(entry)[0], value = attr(c, "val"); const rgb = local(c) === "srgbClr" ? value : attr(c, "lastClr"); if (/^[\da-f]{6}$/i.test(rgb || "")) palette[local(entry)] = "#" + rgb.toLowerCase(); }
  palette.tx1 = palette.dk1; palette.bg1 = palette.lt1; palette.tx2 = palette.dk2; palette.bg2 = palette.lt2;
  const fonts = { major: attr(first(first(theme, "majorFont"), "latin"), "typeface") || "Arial", minor: attr(first(first(theme, "minorFont"), "latin"), "typeface") || "Arial" };
  const files = new Map(), objects = [], notes = [], backgrounds = [], titles = [];
  const imageNames = new Map(); let currentSlide = 0;
  const issue = (code, message) => warn(currentSlide, code, `${currentSlide}번 슬라이드: ${message}`);
  const add = object => {
    if (objects.length >= 500) throw new Error("PPTX 추가 객체는 500개까지입니다.");
    object.id = `a-pptx-${objects.length + 1}`; object.slide = `s${currentSlide - 1}`; object.z = objects.length + 1;
    objects.push(object); counts[{ text: "texts", shape: "shapes", image: "images", table: "tables", chart: "charts" }[object.kind]]++;
  };
  const color = (parent, fallback = "#000000") => {
    const node = children(parent).find(c => ["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"].includes(local(c)));
    if (!node) return fallback;
    const value = attr(node, "val"), kind = local(node);
    let result = kind === "schemeClr" ? palette[value] : kind === "sysClr" ? "#" + attr(node, "lastClr") : kind === "srgbClr" ? "#" + value : null;
    if (!/^#[\da-f]{6}$/i.test(result || "")) { issue("unsupported-color", "지원하지 않는 색상을 기본 색상으로 바꿨습니다."); result = fallback; }
    const transforms = children(node);
    if (transforms.length) issue("color-adjustment", "색조·밝기·투명도 색상 보정은 기본 색상으로 단순화했습니다.");
    return result.toLowerCase();
  };
  const fill = (parent, fallback = "none") => {
    if (one(parent, "noFill")) return "none";
    if (one(parent, "solidFill")) return color(one(parent, "solidFill"), fallback === "none" ? "#ffffff" : fallback);
    if (children(parent).some(c => ["gradFill", "blipFill", "pattFill", "grpFill"].includes(local(c)))) issue("unsupported-fill", "그라데이션·그림·패턴 채우기는 단색으로 단순화했습니다.");
    return fallback;
  };
  const geometry = (node, line = false) => {
    const xfrm = one(one(node, "spPr"), "xfrm") || one(node, "xfrm");
    if (!xfrm) { issue("inherited-geometry", "직접 위치가 없는 자리표시자 또는 객체를 생략했습니다."); counts.skipped++; return null; }
    const offset = one(xfrm, "off"), extent = one(xfrm, "ext");
    const x = numeric(attr(offset, "x"), "위치") * scale, y = numeric(attr(offset, "y"), "위치") * scale, w = numeric(attr(extent, "cx"), "크기", line ? 0 : 1) * scale, h = numeric(attr(extent, "cy"), "크기", line ? 0 : 1) * scale;
    const rotate = xfrm.hasAttribute("rot") ? numeric(attr(xfrm, "rot"), "회전", -21600000, 21600000) / 60000 : 0;
    if (Math.abs(x) > 5000 || Math.abs(y) > 5000 || w > 5000 || h > 5000 || !line && (w < 1 || h < 1)) throw new Error("PPTX 객체 위치 또는 크기 범위 오류");
    if (line) {
      let dx = w * (truth(attr(xfrm, "flipH")) ? -1 : 1), dy = h * (truth(attr(xfrm, "flipV")) ? -1 : 1);
      const length = Math.hypot(dx, dy); if (length < 1 || length > 5000) throw new Error("PPTX 선 크기 오류");
      const lh = 12, angle = Math.atan2(dy, dx) * 180 / Math.PI + rotate;
      return { x: round(x + w / 2 - length / 2), y: round(y + h / 2 - lh / 2), w: round(length), h: lh, rotate: round(((angle + 180) % 360 + 360) % 360 - 180) };
    }
    if (truth(attr(xfrm, "flipH")) || truth(attr(xfrm, "flipV"))) issue("unsupported-flip", "객체 좌우·상하 반전은 가져오지 않았습니다.");
    return { x: round(x), y: round(y), w: round(w), h: round(h), rotate: round(rotate) };
  };
  const fontStyle = (node, base = {}) => {
    const style = { ...base };
    if (!node) return style;
    for (const [attribute, field] of [["b", "bold"], ["i", "italic"]]) if (node.hasAttribute(attribute)) style[field] = truth(attr(node, attribute));
    if (node.hasAttribute("u")) { style.underline = attr(node, "u") !== "none"; if (!["none", "sng"].includes(attr(node, "u"))) issue("text-underline", "밑줄 모양을 단일 밑줄로 단순화했습니다."); }
    if (node.hasAttribute("sz")) {
      const size = numeric(attr(node, "sz"), "글꼴 크기", 1) / 100 * pointScale;
      style.fontSize = round(Math.min(400, Math.max(6, size)));
      if (size < 6 || size > 400) issue("text-font-size", "글꼴 크기를 편집 범위인 6~400픽셀로 조정했습니다.");
    }
    const face = attr(one(node, "latin"), "typeface") || attr(one(node, "ea"), "typeface");
    if (face) {
      const family = face.startsWith("+mj") ? fonts.major : face.startsWith("+mn") ? fonts.minor : face;
      try { globalThis.SDText.normalizeRichText({ paragraphs: [{ runs: [{ text: "", fontFamily: family }] }] }); style.fontFamily = family; }
      catch { issue("unsupported-font", "글꼴 이름을 기본 글꼴로 바꿨습니다."); style.fontFamily = "Arial"; }
    }
    if (one(node, "solidFill")) style.color = color(one(node, "solidFill"));
    if ([...node.attributes].some(a => ["strike", "baseline", "spc", "caps"].includes(a.name) && !["0", "none"].includes(a.value)) || children(node).some(n => ["highlight", "effectLst", "gradFill", "hlinkClick"].includes(local(n)))) issue("unsupported-text-format", "취소선·자간·위첨자·강조·링크 등 일부 문자 서식은 생략했습니다.");
    return style;
  };
  const richText = body => {
    const paragraphs = children(body, "p").map(paragraph => {
      const props = one(paragraph, "pPr"), defaultStyle = fontStyle(one(props, "defRPr"), { fontSize: round(18 * pointScale), fontFamily: "Arial", color: "#000000" });
      const runs = children(paragraph).filter(n => ["r", "fld", "br"].includes(local(n))).map(run => ({ text: local(run) === "br" ? "\n" : one(run, "t")?.textContent || "", ...fontStyle(one(run, "rPr"), defaultStyle) }));
      if (!runs.length) runs.push({ text: "", ...fontStyle(one(paragraph, "endParaRPr"), defaultStyle) });
      const result = { runs };
      const align = attr(props, "algn"); if (align) { result.align = { l: "left", ctr: "center", r: "right", just: "justify" }[align] || "left"; if (!["l", "ctr", "r", "just"].includes(align)) issue("text-alignment", "지원하지 않는 문단 정렬을 왼쪽 정렬로 바꿨습니다."); }
      if (props?.hasAttribute("lvl")) result.indent = numeric(attr(props, "lvl"), "들여쓰기", 0, 8);
      if (one(props, "buChar") || one(props, "buBlip")) { result.list = "bullet"; if (one(props, "buBlip") || !["•", "●"].includes(attr(one(props, "buChar"), "char"))) issue("text-bullet", "사용자 지정 글머리표를 기본 글머리표로 바꿨습니다."); }
      else if (one(props, "buAutoNum")) { result.list = "number"; if (attr(one(props, "buAutoNum"), "type") !== "arabicPeriod" || Number(attr(one(props, "buAutoNum"), "startAt") || 1) !== 1) issue("text-numbering", "번호 목록을 1부터 시작하는 숫자로 바꿨습니다."); }
      const spacing = one(one(props, "lnSpc"), "spcPct"); if (spacing) result.lineHeight = Math.min(4, Math.max(.5, numeric(attr(spacing, "val"), "줄 간격", 0) / 100000));
      const after = one(one(props, "spcAft"), "spcPts"); if (after) result.spaceAfter = Math.min(200, numeric(attr(after, "val"), "문단 간격", 0) / 100 * pointScale);
      if (one(props, "tabLst") || one(props, "spcBef") || one(one(props, "lnSpc"), "spcPts") || props?.hasAttribute("marL") || props?.hasAttribute("indent")) issue("text-paragraph-format", "탭·고정 줄 간격·문단 앞 간격·사용자 지정 들여쓰기는 단순화했습니다.");
      return result;
    });
    return globalThis.SDText.normalizeRichText({ paragraphs });
  };
  const addText = (node, frame) => {
    const body = one(node, "txBody"); if (!body || !descendants(body, "t").some(n => n.textContent)) return;
    const rich = richText(body), bodyPr = one(body, "bodyPr"), bounds = { ...frame };
    const margin = (name, fallback) => bodyPr?.hasAttribute(name) ? numeric(attr(bodyPr, name), "텍스트 여백", 0) * scale : fallback;
    const left = margin("lIns", 91440 * scale), right = margin("rIns", 91440 * scale), top = margin("tIns", 45720 * scale), bottom = margin("bIns", 45720 * scale);
    if (!bounds.rotate && bounds.w - left - right >= 1 && bounds.h - top - bottom >= 1) { bounds.x = round(bounds.x + left); bounds.y = round(bounds.y + top); bounds.w = round(bounds.w - left - right); bounds.h = round(bounds.h - top - bottom); }
    else if (left || right || top || bottom) issue("text-margin", "회전되었거나 좁은 텍스트 상자의 여백을 생략했습니다.");
    const vertical = { t: "top", ctr: "middle", b: "bottom" }[attr(bodyPr, "anchor")] || "top";
    if (bodyPr && ((attr(bodyPr, "vert") && attr(bodyPr, "vert") !== "horz") || Number(attr(bodyPr, "numCol") || 1) !== 1 || one(bodyPr, "prstTxWarp"))) issue("text-direction", "세로쓰기·다단·워드아트는 가로쓰기 텍스트로 가져왔습니다.");
    if (children(one(body, "lstStyle")).length) issue("text-list-style", "상속된 목록 서식은 직접 지정된 문단 서식만 가져왔습니다.");
    add({ kind: "text", ...bounds, fontSize: round(18 * pointScale), text: globalThis.SDText.plainText(rich), richText: rich, textBox: { vertical, overflow: attr(bodyPr, "vertOverflow") === "clip" ? "clip" : "visible", autoFit: one(bodyPr, "normAutofit") ? "shrink" : "none" } });
  };
  const shape = node => {
    const props = one(node, "spPr"), preset = attr(one(props, "prstGeom"), "prst") || "rect", isLine = preset === "line" || local(node) === "cxnSp", frame = geometry(node, isLine);
    if (!frame) return;
    const lineStyle = one(props, "ln"), text = one(node, "txBody"), styled = children(props).some(n => ["solidFill", "gradFill", "blipFill", "pattFill"].includes(local(n))) || lineStyle && !one(lineStyle, "noFill") && (lineStyle.hasAttribute("w") || children(lineStyle).length) || one(node, "style"), hasText = descendants(text, "t").some(n => n.textContent);
    if (one(props, "custGeom") || !["rect", "ellipse", "line"].includes(preset)) { issue("unsupported-shape", `${preset} 사용자 지정 도형의 외형을 생략했습니다${hasText ? "; 텍스트는 유지합니다" : ""}.`); counts.skipped++; }
    else if (!hasText || styled || isLine) {
      const line = one(props, "ln"), stroke = fill(line, "#000000"), head = one(line, "headEnd"), tail = one(line, "tailEnd"), arrow = [head, tail].some(n => attr(n, "type") && attr(n, "type") !== "none");
      const strokeWidth = line && one(line, "noFill") ? 0 : line?.hasAttribute("w") ? numeric(attr(line, "w"), "선 두께", 0) * scale : isLine ? pointScale : 0;
      const dash = attr(one(line, "prstDash"), "val") || "solid";
      if (strokeWidth > 40) issue("shape-stroke", "선 두께를 40픽셀로 제한했습니다.");
      if (arrow) issue("arrow-style", "화살표 끝 모양은 기본 열린 화살표로 단순화했습니다.");
      if (isLine && attr(head, "type") && attr(head, "type") !== "none" && (!attr(tail, "type") || attr(tail, "type") === "none")) frame.rotate = round(frame.rotate > 0 ? frame.rotate - 180 : frame.rotate + 180);
      if (one(node, "style")) issue("shape-theme-style", "테마 기반 도형 서식은 직접 지정한 색상과 선만 가져왔습니다.");
      add({ kind: "shape", ...frame, shape: globalThis.SDObjects.normalizeShape({ type: isLine ? arrow ? "arrow" : "line" : preset, fill: fill(props), stroke: stroke === "none" ? "#000000" : stroke, strokeWidth: Math.min(40, round(strokeWidth)), dash: /dot/i.test(dash) ? "dot" : dash === "solid" ? "solid" : "dash" }) });
    }
    addText(node, frame);
  };
  const image = (node, relationships) => {
    const frame = geometry(node); if (!frame) return;
    const properties = one(node, "spPr"), preset = attr(one(properties, "prstGeom"), "prst"), border = one(properties, "ln"), stretch = first(one(node, "blipFill"), "fillRect");
    if (one(properties, "custGeom") || preset && preset !== "rect") issue("image-geometry", "타원·둥근 모서리·사용자 지정 이미지 마스크는 사각형 이미지로 가져왔습니다.");
    if (border && !one(border, "noFill") && (border.hasAttribute("w") || children(border).length)) issue("image-border", "이미지의 테두리 선은 가져오지 않았습니다.");
    if (stretch && [...stretch.attributes].some(a => a.value !== "0")) issue("image-layout", "이미지 늘이기 영역의 여백은 생략하고 객체 전체 크기에 맞췄습니다.");
    const blip = first(one(node, "blipFill"), "blip"), id = attr(blip, "r:embed") || attr(blip, "r:link"), rel = relationships.get(id);
    if (!rel || rel.type !== "image" || rel.external || !parts.has(rel.target)) { issue(rel?.external ? "external-image" : "missing-image", "외부 연결 또는 누락된 이미지 객체를 생략했습니다."); counts.skipped++; return; }
    const ext = path.posix.extname(rel.target).toLowerCase(), bytes = parts.get(rel.target);
    const valid = ext === ".png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || [".jpg", ".jpeg"].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 || ext === ".gif" && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"));
    if (!valid) { issue("unsupported-image", "PNG/JPEG/GIF 형식이 아닌 이미지 객체를 생략했습니다."); counts.skipped++; return; }
    let src = imageNames.get(rel.target);
    if (!src) { src = `media/image-${imageNames.size + 1}${ext}`; imageNames.set(rel.target, src); files.set(src, bytes); }
    const source = first(one(node, "blipFill"), "srcRect"), crop = {};
    for (const [short, side] of [["l", "left"], ["t", "top"], ["r", "right"], ["b", "bottom"]]) crop[side] = source?.hasAttribute(short) ? numeric(attr(source, short), "이미지 자르기", 0, 99000) / 100000 : 0;
    if (one(one(node, "blipFill"), "tile") || children(blip).some(n => local(n) !== "extLst") || first(node, "alphaModFix")) issue("image-effects", "이미지 타일링·투명도·색상 효과는 생략했습니다.");
    add({ kind: "image", ...frame, src, image: globalThis.SDObjects.normalizeImage({ mode: "stretch", crop }) });
  };
  const table = (node, frame) => {
    const tbl = first(node, "tbl"), trs = children(tbl, "tr"), rows = trs.map(row => children(row, "tc").map(cell => bodyText(one(cell, "txBody"))));
    if (rows.length > 20 || rows.some(row => row.length > 10)) throw new Error("PPTX 표는 20행, 10열까지입니다.");
    if (descendants(tbl, "tc").some(c => ["gridSpan", "rowSpan", "hMerge", "vMerge"].some(name => c.hasAttribute(name)))) issue("table-merged-cells", "병합된 표 셀은 일반 셀로 단순화했습니다.");
    const firstCell = first(tbl, "tc"), props = one(firstCell, "tcPr"), style = fontStyle(first(firstCell, "rPr")), firstRow = truth(attr(one(tbl, "tblPr"), "firstRow"));
    const headerColor = fill(props, "#eef2f7"), bodyColor = fill(one(children(trs[1], "tc")[0], "tcPr"), "#ffffff");
    const normalized = globalThis.SDData.normalizeTable({ rows, header: firstRow, fontSize: style.fontSize || round(12 * pointScale), color: style.color || "#111827", fill: bodyColor === "none" ? "#ffffff" : bodyColor, headerFill: headerColor === "none" ? "#eef2f7" : headerColor, border: color(one(one(props, "lnL"), "solidFill"), "#cbd5e1") });
    issue("table-format", "표는 동일한 열 너비·행 높이와 일반 텍스트 셀로 가져왔습니다. 셀별 서식과 표 스타일은 단순화했습니다.");
    if (frame.rotate) issue("table-rotation", "표의 회전은 생략했습니다.");
    add({ kind: "table", ...frame, rotate: 0, table: normalized });
  };
  const chart = (node, frame, relationships) => {
    const id = attr(first(node, "chart"), "r:id"), rel = relationships.get(id), doc = rel && !rel.external && rel.type === "chart" && xmls.get(rel.target);
    if (!doc) { issue("missing-chart", "연결된 차트 파일을 읽을 수 없어 차트를 생략했습니다."); counts.skipped++; return; }
    const plot = first(doc, "plotArea"), chartNodes = children(plot).filter(n => /Chart$/.test(local(n))), supported = { barChart: "bar", lineChart: "line", pieChart: "pie" };
    if (chartNodes.length !== 1 || !supported[local(chartNodes[0])]) { issue("unsupported-chart", "복합·3D 또는 지원하지 않는 종류의 차트를 생략했습니다."); counts.skipped++; return; }
    const chartNode = chartNodes[0], type = supported[local(chartNode)], seriesNodes = children(chartNode, "ser");
    const cache = (parent, numericValues = false) => {
      const data = first(parent, numericValues ? "numCache" : "strCache") || first(parent, numericValues ? "numLit" : "strLit") || (!numericValues && (first(parent, "numCache") || first(parent, "multiLvlStrCache")));
      if (!data) return null;
      const levels = children(data, "lvl");
      if (levels.length > 1) issue("chart-category-levels", "다단계 차트 범주는 가장 안쪽 범주 이름으로 단순화했습니다.");
      const pts = children(levels[0] || data, "pt"), count = one(data, "ptCount")?.getAttribute("val");
      if (count && numeric(count, "차트 항목 수", 0, 20) !== pts.length) return null;
      const indexed = pts.map(p => ({ idx: numeric(attr(p, "idx"), "차트 인덱스", 0, 19), text: one(p, "v")?.textContent ?? "" })).sort((a, b) => a.idx - b.idx);
      if (indexed.some((p, i) => p.idx !== i)) return null;
      return indexed.map(p => numericValues ? numeric(p.text, "차트 값", -1e9, 1e9, true) : p.text);
    };
    if (seriesNodes.length > 5) throw new Error("PPTX 차트는 5계열까지입니다.");
    let categories; const series = [], colors = [];
    for (const [index, seriesNode] of seriesNodes.entries()) {
      const cats = cache(one(seriesNode, "cat")), values = cache(one(seriesNode, "val"), true), tx = one(seriesNode, "tx");
      if (!cats || !values || cats.length !== values.length || categories && JSON.stringify(cats) !== JSON.stringify(categories)) { issue("missing-chart-cache", "완전한 범주·수치 캐시가 없는 차트는 가져오지 않았습니다. 외부 또는 포함된 통합 문서를 실행하지 않습니다."); counts.skipped++; return; }
      categories = cats; series.push({ name: one(tx, "v")?.textContent || first(tx, "v")?.textContent || `계열 ${index + 1}`, values });
      const seriesStyle = one(seriesNode, "spPr");
      colors.push(color(type === "line" ? one(one(seriesStyle, "ln"), "solidFill") || one(seriesStyle, "solidFill") : one(seriesStyle, "solidFill"), palette[`accent${index + 1}`]));
    }
    if (!series.length) { issue("empty-chart", "데이터 계열이 없는 차트를 생략했습니다."); counts.skipped++; return; }
    if (type === "pie" && (series.length !== 1 || series[0].values.some(v => v < 0) || series[0].values.reduce((a,b) => a+b, 0) <= 0)) { issue("unsupported-pie-data", "원형 차트는 양수 합계를 가진 하나의 비음수 계열만 가져올 수 있습니다."); counts.skipped++; return; }
    if (type === "pie") {
      const points = new Map(children(seriesNodes[0], "dPt").map(point => [numeric(attr(one(point, "idx"), "val"), "차트 색상 인덱스", 0, 19), point]));
      colors.splice(0, colors.length, ...categories.map((_, i) => color(one(one(points.get(i), "spPr"), "solidFill"), palette[`accent${i % 6 + 1}`])));
    }
    issue("chart-format", "차트는 저장된 데이터 캐시로 가져왔습니다. 축·범례·제목·레이블·방향·누적 및 세부 서식은 기본 차트로 단순화했습니다.");
    if (frame.rotate) issue("chart-rotation", "차트의 회전은 생략했습니다.");
    add({ kind: "chart", ...frame, rotate: 0, chart: globalThis.SDData.normalizeChart({ type, categories, series, colors, fontSize: 18 }) });
  };

  const inherited = (part, kind, visited = new Set()) => {
    if (!part || visited.has(part)) return; visited.add(part);
    const doc = xmls.get(part), tree = first(doc, "spTree"), visible = children(tree).filter(n => !["nvGrpSpPr", "grpSpPr", "extLst"].includes(local(n)));
    if (visible.length || first(doc, "bg")) issue(`inherited-${kind}`, `${kind === "layout" ? "레이아웃" : "마스터"}의 상속 객체·자리표시자·배경 ${visible.length}개는 가져오지 않았습니다.`);
    if (first(doc, "txStyles") || first(doc, "clrMap")) issue("inherited-theme", "마스터의 상속 텍스트·색상 매핑은 직접 지정한 서식과 기본 테마로 단순화했습니다.");
    for (const rel of rels.get(part)?.values() || []) if (rel.type === "slideMaster" && !rel.external) inherited(rel.target, "master", visited);
  };
  let sourceObjects = 0;
  for (const [index, slideId] of slideIds.entries()) {
    currentSlide = index + 1;
    const rel = rels.get("ppt/presentation.xml")?.get(attr(slideId, "r:id")), slide = rel && rel.type === "slide" && !rel.external && xmls.get(rel.target);
    if (!slide) throw new Error("PPTX 슬라이드 관계 또는 파일이 없습니다.");
    const relationships = rels.get(rel.target) || new Map(), tree = first(slide, "spTree");
    if (!tree) throw new Error("PPTX 슬라이드 객체 트리가 없습니다.");
    sourceObjects += [...tree.querySelectorAll("*")].filter(n => ["sp", "pic", "graphicFrame", "cxnSp", "grpSp", "contentPart"].includes(local(n))).length;
    if (sourceObjects > 500) throw new Error("PPTX 원본 객체는 그룹 내부를 포함하여 500개까지입니다.");
    const bg = one(first(slide, "bg"), "bgPr"); backgrounds.push(fill(bg, "#ffffff"));
    const title = first(slide, "t")?.textContent?.trim(); titles.push(title || `${currentSlide}번 슬라이드`);
    if (first(slide, "timing")) issue("unsupported-animation", "PowerPoint 객체 애니메이션을 가져오지 않았습니다.");
    if (first(slide, "transition")) issue("unsupported-transition", "PowerPoint 슬라이드 전환 효과를 가져오지 않았습니다.");
    if (truth(attr(slide.documentElement, "show")) === false && attr(slide.documentElement, "show") === "0") issue("hidden-slide", "숨김 슬라이드를 일반 슬라이드로 가져왔습니다.");
    for (const node of children(tree)) {
      const kind = local(node);
      if (["nvGrpSpPr", "grpSpPr"].includes(kind)) continue;
      if (["videoFile", "audioFile", "wavAudioFile", "media"].some(name => first(node, name))) issue("unsupported-media", "동영상·오디오는 가져오지 않았습니다. 표시 가능한 미리보기 이미지만 유지합니다.");
      if (first(node, "effectLst") || first(node, "effectDag") || first(node, "scene3d") || first(node, "sp3d")) issue("unsupported-effects", "객체 그림자·광선·3D 효과는 생략했습니다.");
      if (first(node, "ph")) issue("placeholder-style", "자리표시자는 직접 지정된 위치와 서식만 가져옵니다.");
      if (kind === "sp" || kind === "cxnSp") shape(node);
      else if (kind === "pic") image(node, relationships);
      else if (kind === "graphicFrame") {
        const frame = geometry(node); if (!frame) continue;
        if (first(node, "tbl")) table(node, frame);
        else if (first(node, "chart")) chart(node, frame, relationships);
        else { issue("unsupported-graphic", "SmartArt·OLE·기타 그래픽 프레임을 생략했습니다."); counts.skipped++; }
      } else if (kind === "grpSp") { issue("unsupported-group", "그룹 객체와 그 안의 콘텐츠를 생략했습니다."); counts.skipped++; }
      else { issue("unsupported-object", `${kind} 객체 또는 확장 콘텐츠를 생략했습니다.`); counts.skipped++; }
    }
    let note = "";
    for (const relationship of relationships.values()) {
      if (relationship.external) continue;
      if (relationship.type === "slideLayout") inherited(relationship.target, "layout");
      if (relationship.type === "notesSlide") {
        const noteDoc = xmls.get(relationship.target);
        if (!noteDoc) { issue("missing-notes", "발표자 노트 파일이 없습니다."); continue; }
        const textShapes = descendants(noteDoc, "sp").filter(node => !["sldNum", "hdr", "ftr", "dt"].includes(attr(first(node, "ph"), "type")));
        note = textShapes.map(node => bodyText(one(node, "txBody"))).filter(Boolean).join("\n");
        if (note.length > 20000) throw new Error("PPTX 발표자 노트는 슬라이드당 20,000자까지입니다.");
        if (note) counts.notes++;
        if (descendants(noteDoc, "pic").length || descendants(noteDoc, "graphicFrame").length) issue("notes-graphics", "노트의 이미지·그래픽은 생략하고 텍스트만 가져왔습니다.");
      }
    }
    notes.push(note);
  }
  counts.objects = objects.length;
  const core = xmls.get("docProps/core.xml"), title = first(core, "title")?.textContent?.slice(0, 500) || "가져온 PowerPoint";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>html,body{margin:0;padding:0;overflow:hidden}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;display:none;width:1920px;height:1080px;overflow:hidden;box-sizing:border-box;font-family:Arial,sans-serif}.slide.active{display:block}.notes{display:none}</style></head><body><main id="stage">${slideIds.map((_, i) => `<section class="slide${i === 0 ? " active" : ""}" style="background:${backgrounds[i] === "none" ? "#ffffff" : backgrounds[i]}"><aside class="notes">${esc(notes[i])}</aside></section>`).join("")}</main></body></html>`;
  const prepared = prepareDeck(html); prepared.slides.forEach((slide, i) => { slide.title = titles[i].slice(0, 500); });
  const state = initialState(prepared); state.added = objects;
  const canonical = validateState(state, prepared);
  files.set("index.html", Buffer.from(prepared.html));
  return { ...prepared, files, state: canonical, report: { format: "pptx", version: 1, warnings, counts, canvas: { width: 1920, height: 1080 }, compressedBytes: buffer.length, expandedBytes: expanded } };
}
