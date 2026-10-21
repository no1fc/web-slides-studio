import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, relative, isAbsolute } from "node:path";
import JSZip from "jszip";
import "../public/text-model.js";
import "../public/object-model.js";
import { canExportNativeText, pptxText } from "./text-export.js";

const Objects = globalThis.SDObjects;
const number = value => typeof value === "number" && Number.isFinite(value);
const color = value => String(value).replace(/^#/, "").toUpperCase();
const rotation = value => ((value || 0) % 360 + 360) % 360;
function frameBounds(object) {
  if (![object.x, object.y, object.w, object.h].every(number) || object.w <= 0 || object.h <= 0) return null;
  const angle = object.nativeObject ? rotation(object.rotate) * Math.PI / 180 : 0;
  const halfW = (Math.abs(Math.cos(angle)) * object.w + Math.abs(Math.sin(angle)) * object.h) / 2;
  const halfH = (Math.abs(Math.sin(angle)) * object.w + Math.abs(Math.cos(angle)) * object.h) / 2;
  const cx = object.x + object.w / 2, cy = object.y + object.h / 2;
  return { left: cx - halfW, top: cy - halfH, right: cx + halfW, bottom: cy + halfH };
}
function insideSlide(object) {
  // Native canonical shapes rotate around their unrotated box. A partially
  // clipped object stays in the background so it cannot escape the slide.
  const bounds = frameBounds(object);
  return bounds && bounds.left >= -0.01 && bounds.top >= -0.01 && bounds.right <= 1922 && bounds.bottom <= 1082;
}
function paintedBounds(object) {
  // Visible overflowing text can paint far beyond its declared box. Its full
  // glyph bounds are not part of collect(), so conservatively retain lower
  // objects in the slide background when this text's root becomes raster.
  if (object.kind === "text" && object.textOverflowing && object.textBox?.overflow !== "clip")
    return { left: 0, top: 0, right: 1920, bottom: 1080 };
  const bounds = [], frame = frameBounds(object);
  if (frame) bounds.push(frame);
  // Collected group children are already in slide coordinates. Their painted
  // area can extend beyond the group's own frame, including after rotation.
  if (object.kind === "group" && Array.isArray(object.children)) {
    for (const child of object.children) bounds.push(paintedBounds(child));
  }
  if (!bounds.length) return { left: 0, top: 0, right: 1920, bottom: 1080 };
  return {
    left: Math.min(...bounds.map(b => b.left)), top: Math.min(...bounds.map(b => b.top)),
    right: Math.max(...bounds.map(b => b.right)), bottom: Math.max(...bounds.map(b => b.bottom)),
  };
}
function overlaps(a, b) {
  // Only the portion painted inside the slide can cover another object.
  return Math.max(0, a.left, b.left) < Math.min(1920, a.right, b.right) &&
    Math.max(0, a.top, b.top) < Math.min(1080, a.bottom, b.bottom);
}

function imageSourcePath(source, context) {
  if (typeof source !== "string") throw new Error("이미지 원본 경로가 필요합니다.");
  let path = source;
  if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
    const url = new URL(source), base = new URL(context.url);
    const prefix = base.pathname.replace(/index\.html$/, "");
    if (url.origin !== context.contentOrigin || !url.pathname.startsWith(prefix) || url.search || url.hash)
      throw new Error("이 자료의 이미지 원본만 내보낼 수 있습니다.");
    path = decodeURIComponent(url.pathname.slice(prefix.length));
  }
  return Objects.safeImageSource(path);
}

async function sourceImage(object, context) {
  const path = imageSourcePath(object.src, context);
  const root = await realpath(context.root), target = await realpath(resolve(root, path));
  const child = relative(root, target);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith("..\\") || child.startsWith("../"))
    throw new Error("이미지 경로가 자료 폴더 밖입니다.");
  const extension = extname(path).toLowerCase();
  // PowerPoint cannot reliably read WebP. Convert the full uncropped image,
  // never the displayed/cropped frame, so the source crop remains reversible.
  if (extension === ".webp") {
    if (!context.convertSourceImage) throw new Error("WebP 원본 변환을 사용할 수 없습니다.");
    return { data: await context.convertSourceImage(object.src) };
  }
  const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" })[extension];
  if (!mime) throw new Error("지원하지 않는 이미지 형식입니다.");
  return { data: mime + ";base64," + (await readFile(target)).toString("base64") };
}

/** Map the visible source rectangle to a PPTX picture while retaining all pixels. */
export function pptxImage(object, source, objectName) {
  if (!(object.naturalWidth > 0 && object.naturalHeight > 0)) throw new Error("이미지 원본 크기를 읽을 수 없습니다.");
  const layout = Objects.imageLayout(object.w, object.h, object.naturalWidth, object.naturalHeight, Objects.normalizeImage(object.image));
  const frame = layout.frame;
  // Fit centers its visible frame. Keep the general rotated-center mapping so
  // future asymmetric frame placement still rotates about the original object.
  const a = rotation(object.rotate) * Math.PI / 180;
  const dx = frame.x + frame.w / 2 - object.w / 2, dy = frame.y + frame.h / 2 - object.h / 2;
  const cx = object.x + object.w / 2 + dx * Math.cos(a) - dy * Math.sin(a);
  const cy = object.y + object.h / 2 + dx * Math.sin(a) + dy * Math.cos(a);
  return { crop: layout.crop, options: {
    objectName, ...source,
    x: (cx - frame.w / 2) / 144, y: (cy - frame.h / 2) / 144,
    w: frame.w / 144, h: frame.h / 144, rotate: rotation(object.rotate),
  } };
}

export function pptxShape(object, objectName) {
  const shape = Objects.normalizeShape(object.shape, object.fill);
  const inset = Math.min(shape.strokeWidth / 2, object.w / 2, object.h / 2);
  const line = ["line", "arrow"].includes(shape.type);
  // Generated SVG keeps the stroke inside the frame; PPTX centers it on the
  // geometry path, so inset the same amount on each side.
  const w = Math.max(0, object.w - inset * 2), h = Math.max(0, object.h - inset * 2);
  const options = {
    objectName, x: (object.x + inset) / 144,
    y: (object.y + (line ? object.h / 2 : inset)) / 144,
    w: w / 144, h: line ? 0 : h / 144, rotate: rotation(object.rotate),
    line: { color: color(shape.stroke), width: shape.strokeWidth / 2, transparency: shape.strokeWidth === 0 ? 100 : 0, dashType: ({ solid: "solid", dash: "dash", dot: "sysDot" })[shape.dash], ...(shape.type === "arrow" ? { endArrowType: "arrow" } : {}) },
    ...(!line && shape.fill !== "none" ? { fill: { color: color(shape.fill) } } : {}),
  };
  return { type: line ? "line" : shape.type, options };
}

/** Prepare complete roots before hiding anything. A failed child keeps its group raster. */
export async function prepareNativeObjects(objects, context) {
  const entries = [], hideIds = [];
  const roots = [];
  async function leaf(object, groupChild) {
    if (!insideSlide(object) || object.unsupported || object.nativeSupported === false) throw new Error("이 개체는 배경에 보존합니다.");
    if (object.kind === "text") {
      if (!canExportNativeText(object)) throw new Error("잘린 텍스트는 배경에 보존합니다.");
      return { kind: "text", object: { ...object, groupChild } };
    }
    if (object.kind === "shape") return { kind: "shape", object, mapped: pptxShape(object, "prepared") };
    if (object.kind === "image") {
      if (object.nativeObject) {
        const source = await sourceImage(object, context);
        // Compute now so invalid crop/dimensions cannot fail after hiding.
        const mapped = pptxImage(object, source, "prepared");
        return { kind: "image", object, mapped };
      }
      if (groupChild || !context.captureLegacyImage) throw new Error("이미지 원본을 읽을 수 없습니다.");
      const bytes = await context.captureLegacyImage(object);
      return { kind: "image", object, mapped: { options: { data: "image/png;base64," + bytes.toString("base64"), x: object.x / 144, y: object.y / 144, w: object.w / 144, h: object.h / 144 } } };
    }
    throw new Error("지원하지 않는 개체입니다.");
  }
  for (const object of objects) {
    const root = { object, bounds: paintedBounds(object), entries: null };
    roots.push(root);
    try {
      const items = object.kind === "group"
        ? await (async () => {
          if (object.unsupported || object.nativeSupported === false || !Array.isArray(object.children) || !object.children.length) throw new Error("그룹 원본이 필요합니다.");
          const children = [];
          for (const child of object.children) children.push(await leaf(child, true));
          return children;
        })()
        : [await leaf(object, false)];
      root.entries = items;
    } catch { /* Preserve the complete visual in the background on any failure. */ }
  }
  // Native objects are appended above one background picture. A lower native
  // root must therefore remain raster when any higher raster root covers it.
  // Propagate backwards: newly retained roots can themselves cover lower ones.
  const rasterBounds = [];
  for (let index = roots.length - 1; index >= 0; index--) {
    const root = roots[index];
    if (root.entries && rasterBounds.some(bounds => overlaps(root.bounds, bounds))) root.entries = null;
    if (!root.entries) rasterBounds.push(root.bounds);
  }
  for (const root of roots) if (root.entries) {
    entries.push(...root.entries); hideIds.push(root.object.id);
  }
  return { entries, hideIds };
}

export function addNativeObjects(slide, entries, textShapes, pictures) {
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === "text") {
      const mapped = pptxText(entry.object, `sd-native-text-${textShapes.length}`);
      if (entry.object.groupChild && /^#[\da-f]{6}$/i.test(entry.object.fill)) mapped.options.fill = { color: color(entry.object.fill) };
      slide.addText(mapped.runs, mapped.options); textShapes.push(mapped);
    } else if (entry.kind === "shape") {
      slide.addShape(entry.mapped.type, { ...entry.mapped.options, objectName: `sd-native-shape-${index}` });
    } else {
      if (entry.object.nativeObject && /^#[\da-f]{6}$/i.test(entry.object.fill)) {
        const e = entry.object;
        slide.addShape("rect", {
          objectName: `sd-native-image-background-${pictures.length}`,
          x: e.x / 144, y: e.y / 144, w: e.w / 144, h: e.h / 144, rotate: rotation(e.rotate),
          fill: { color: color(e.fill) }, line: { transparency: 100 },
        });
      }
      const mapped = { ...entry.mapped, options: { ...entry.mapped.options, objectName: `sd-native-image-${pictures.length}` } };
      slide.addImage(mapped.options); pictures.push(mapped);
    }
  }
}

/** Write explicit asymmetric crop values, which addImage cannot express directly. */
export async function finalizeObjectPptx(buffer, slides) {
  if (!slides.some(pictures => pictures.some(picture => picture.crop))) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  for (const [index, pictures] of slides.entries()) {
    const models = new Map(pictures.filter(p => p.crop).map(p => [p.options.objectName, p.crop]));
    if (!models.size) continue;
    const path = `ppt/slides/slide${index + 1}.xml`;
    const xml = await zip.file(path).async("string");
    zip.file(path, xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/g, picture => {
      const name = picture.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/)?.[1], crop = models.get(name);
      if (!crop) return picture;
      const srcRect = `<a:srcRect l="${Math.round(crop.left * 100000)}" t="${Math.round(crop.top * 100000)}" r="${Math.round(crop.right * 100000)}" b="${Math.round(crop.bottom * 100000)}"/>`;
      return picture.replace(/<p:blipFill>[\s\S]*?<\/p:blipFill>/, fill => {
        if (/<a:srcRect\b/.test(fill)) return fill.replace(/<a:srcRect\b[^>]*(?:\/>|>[\s\S]*?<\/a:srcRect>)/, srcRect);
        return fill.replace(/<a:stretch\b/, srcRect + "<a:stretch");
      });
    }));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
