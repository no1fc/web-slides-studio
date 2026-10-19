import JSZip from "jszip";
import path from "node:path";
import { parseHTML } from "linkedom";
import { prepareDeck } from "./deck.js";
export const MAX_EXPANDED = 64 * 1024 * 1024;
const allowed = new Set([
  ".html",
  ".css",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".json",
  ".mp4",
  ".webm",
  ".ico",
]);
export function safePath(p) {
  if (
    typeof p !== "string" ||
    !p ||
    p.length > 240 ||
    /[\\:\x00-\x1f]/.test(p) ||
    p.startsWith("/") ||
    p.split("/").some((s) => !s || s === ".." || s.startsWith("."))
  )
    throw new Error("허용되지 않는 파일 경로입니다.");
  return p;
}
function inspectDirectory(buffer) {
  let end = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65557);
    i--
  ) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP 디렉터리를 읽을 수 없습니다.");
  const count = buffer.readUInt16LE(end + 10),
    offset = buffer.readUInt32LE(end + 16),
    size = buffer.readUInt32LE(end + 12);
  if (
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6) ||
    count === 65535 ||
    offset === 0xffffffff ||
    offset + size > end
  )
    throw new Error("분할 또는 ZIP64 파일은 지원하지 않습니다.");
  let pos = offset,
    total = 0,
    files = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || buffer.readUInt32LE(pos) !== 0x02014b50)
      throw new Error("ZIP 항목 오류");
    const nameLength = buffer.readUInt16LE(pos + 28),
      extra = buffer.readUInt16LE(pos + 30),
      comment = buffer.readUInt16LE(pos + 32);
    if (pos + 46 + nameLength + extra + comment > end)
      throw new Error("ZIP 항목 오류");
    const name = buffer
      .subarray(pos + 46, pos + 46 + nameLength)
      .toString("utf8");
    const normalized = name.normalize("NFC");
    if (names.has(normalized)) throw new Error("중복 ZIP 파일 경로입니다.");
    names.add(normalized);
    if (!name.endsWith("/")) {
      safePath(name);
      files++;
      total += buffer.readUInt32LE(pos + 24);
    }
    if (files > 300) throw new Error("파일은 300개까지 올릴 수 있습니다.");
    if (total > MAX_EXPANDED)
      throw new Error("압축 해제 크기는 64MB까지입니다.");
    if (((buffer.readUInt32LE(pos + 38) >>> 16) & 0o170000) === 0o120000)
      throw new Error("심볼릭 링크는 허용되지 않습니다.");
    pos += 46 + nameLength + extra + comment;
  }
  if (pos !== offset + size) throw new Error("ZIP 디렉터리 크기 오류");
}
export function readBounded(entry, limit) {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream("nodebuffer");
    const chunks = [];
    let total = 0,
      failed = false;
    stream.on("data", (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > limit) {
        failed = true;
        stream.pause();
        reject(new Error("압축 해제 크기는 64MB까지입니다."));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks, total));
    });
    stream.resume();
  });
}
export async function importArchive(buffer) {
  if (buffer.length > 40 * 1024 * 1024)
    throw new Error("ZIP은 40MB까지 올릴 수 있습니다.");
  inspectDirectory(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && !f.name.startsWith("__MACOSX/"),
  );
  if (entries.length > 300)
    throw new Error("파일은 300개까지 올릴 수 있습니다.");
  let total = 0,
    actual = 0;
  const files = new Map();
  for (const f of entries) {
    const raw = f.unsafeOriginalName || f.name;
    safePath(raw);
    if (
      f.unixPermissions &&
      (Number(f.unixPermissions) & 0o170000) === 0o120000
    )
      throw new Error("심볼릭 링크는 허용되지 않습니다.");
    total += f._data?.uncompressedSize || 0;
    if (total > MAX_EXPANDED)
      throw new Error("압축 해제 크기는 64MB까지입니다.");
    if (!allowed.has(path.extname(raw).toLowerCase())) continue;
    const bytes = await readBounded(f, MAX_EXPANDED - actual);
    actual += bytes.length;
    if (files.has(raw)) throw new Error("중복 파일 경로입니다.");
    files.set(raw, bytes);
  }
  let entry = files.has("index.html") ? "index.html" : null;
  if (!entry) {
    const candidates = [...files.keys()].filter((p) =>
      p.endsWith("/index.html"),
    );
    if (candidates.length === 1) entry = candidates[0];
  }
  if (!entry) throw new Error("발표 자료의 index.html 하나를 포함해 주세요.");
  const prefix = entry.slice(0, -"index.html".length);
  const normalized = new Map();
  for (const [p, b] of files) {
    if (!p.startsWith(prefix)) continue;
    normalized.set(p.slice(prefix.length), b);
  }
  const html = normalized.get("index.html").toString("utf8");
  const { document } = parseHTML(html);
  const refs = [];
  for (const e of document.querySelectorAll("[src],link[href]")) {
    const ref = e.getAttribute("src") || e.getAttribute("href");
    if (ref) refs.push(ref);
  }
  for (const m of html.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/g))
    refs.push(m[1]);
  const missing = refs
    .filter((r) => !r.startsWith("#") && !/^(data:|https?:|blob:)/i.test(r))
    .filter((r) => {
      try {
        return !normalized.has(
          decodeURIComponent(r.split(/[?#]/)[0].replace(/^\.\//, "")),
        );
      } catch {
        return true;
      }
    });
  if (missing.length)
    throw new Error("자산 누락: " + missing.slice(0, 5).join(", "));
  const prepared = prepareDeck(html);
  normalized.set("index.html", Buffer.from(prepared.html));
  return { ...prepared, files: normalized };
}
