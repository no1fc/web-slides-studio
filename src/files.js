import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import JSZip from "jszip";
export async function collectFiles(root, dir = "") {
  const paths = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const p = dir ? dir + "/" + e.name : e.name;
    if (e.isDirectory()) paths.push(...(await collectFiles(root, p)));
    else if (e.isFile()) paths.push(p);
  }
  return paths.sort();
}
export async function inventory(store, id) {
  const meta = await store.meta(id),
    root = store.path(id, "assets");
  const paths = await collectFiles(root);
  const references = [];
  let revisionBytes = 0;
  for (const p of await collectFiles(store.path(id, "revisions"))) {
    const b = await readFile(store.path(id, "revisions", p));
    revisionBytes += b.length;
    references.push(b.toString("utf8"));
  }
  for (const p of paths)
    if ([".html", ".css", ".js", ".json"].includes(extname(p).toLowerCase()))
      references.push(await readFile(join(root, p), "utf8"));
  const files = [];
  for (const p of paths) {
    const original = !(meta.uploadedFiles || []).includes(p);
    const referenced = references.some(
      (t) => t.includes(p) || t.includes(basename(p)),
    );
    files.push({
      path: p,
      bytes: (await stat(join(root, p))).size,
      canDelete: !original && !referenced,
      reason: original
        ? "원본 파일 보호"
        : referenced
          ? "저장 버전에서 사용 중"
          : "사용하지 않는 추가 이미지",
    });
  }
  return {
    files,
    assetBytes: files.reduce((n, f) => n + f.bytes, 0),
    revisionBytes,
    totalBytes:
      files.reduce((n, f) => n + f.bytes, 0) +
      revisionBytes +
      (await stat(store.path(id, "meta.json"))).size,
    archiveRetained: false,
  };
}
export async function sourceArchive(store, id) {
  const zip = new JSZip();
  for (const path of await collectFiles(store.path(id, "assets")))
    zip.file(path, await readFile(store.path(id, "assets", path)));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
