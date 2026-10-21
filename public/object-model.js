(function (global) {
  "use strict";
  const finite = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const sides = ["left", "top", "right", "bottom"];
  const own = (o, k) => Object.hasOwn(o, k);
  const round = n => Math.round(n * 1e6) / 1e6;
  function record(value, keys, label) {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} 형식 오류`);
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !keys.includes(key) || !d.enumerable || !own(d, "value")) throw new Error(`허용되지 않는 ${label} 항목입니다.`);
    }
    return value;
  }
  function array(value, label) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 500 || Reflect.ownKeys(value).length !== value.length + 1) throw new Error(`${label} 배열 오류`);
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !d.enumerable || !own(d, "value")) throw new Error(`${label} 배열 오류`);
    }
    return value;
  }
  function color(value, none = false) {
    if (none && value === "none") return value;
    if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) throw new Error("색상 값 오류");
    return value.toLowerCase();
  }
  function safeImageSource(value) {
    if (typeof value !== "string" || value.length > 1000 || /[\\?#:%\x00-\x1f\x7f]/.test(value) || value.startsWith("/") || !/\.(png|jpe?g|webp|gif)$/i.test(value) || value.split("/").some(part => !part || part.startsWith(".") || part !== part.trim())) throw new Error("허용되지 않는 이미지 경로입니다.");
    return value;
  }
  function normalizeImage(value = {}) {
    record(value, ["mode", "crop"], "이미지");
    const mode = own(value, "mode") ? value.mode : "stretch";
    if (!["fill", "fit", "stretch"].includes(mode)) throw new Error("이미지 맞춤 값 오류");
    const raw = own(value, "crop") ? value.crop : {};
    record(raw, sides, "이미지 자르기");
    const crop = Object.fromEntries(sides.map(key => {
      const v = own(raw, key) ? raw[key] : 0;
      if (!finite(v, 0, .99)) throw new Error("이미지 자르기는 0~99% 사이여야 합니다.");
      return [key, v];
    }));
    if (crop.left + crop.right > .99 + 1e-10 || crop.top + crop.bottom > .99 + 1e-10) throw new Error("마주 보는 자르기 합은 99% 이하여야 합니다.");
    return { mode, crop };
  }
  function normalizeShape(value = {}, legacyFill = "#087e77") {
    record(value, ["type", "fill", "stroke", "strokeWidth", "dash"], "도형");
    const result = { type: own(value, "type") ? value.type : "rect", fill: color(own(value, "fill") ? value.fill : legacyFill, true), stroke: color(own(value, "stroke") ? value.stroke : "#087e77"), strokeWidth: own(value, "strokeWidth") ? value.strokeWidth : 0, dash: own(value, "dash") ? value.dash : "solid" };
    if (!["rect", "ellipse", "line", "arrow"].includes(result.type) || !finite(result.strokeWidth, 0, 40) || !["solid", "dash", "dot"].includes(result.dash)) throw new Error("도형 값 오류");
    return result;
  }
  function imageLayout(width, height, naturalWidth, naturalHeight, value) {
    if (![width, height, naturalWidth, naturalHeight].every(v => finite(v, .000001, 1e8))) throw new Error("이미지 크기 오류");
    const { mode, crop } = normalizeImage(value), cw = naturalWidth * (1 - crop.left - crop.right), ch = naturalHeight * (1 - crop.top - crop.bottom);
    let sx = width / cw, sy = height / ch;
    if (mode !== "stretch") sx = sy = mode === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
    const w = naturalWidth * sx, h = naturalHeight * sy;
    const dx = (width - cw * sx) / 2, dy = (height - ch * sy) / 2;
    const frame = { x: Math.max(0, dx), y: Math.max(0, dy), w: Math.min(width, cw * sx), h: Math.min(height, ch * sy) };
    return { x: dx - crop.left * w, y: dy - crop.top * h, w, h, crop: { left: crop.left + Math.max(0, -dx) / w, top: crop.top + Math.max(0, -dy) / h, right: crop.right + Math.max(0, -dx) / w, bottom: crop.bottom + Math.max(0, -dy) / h }, frame };
  }
  const objectKeys = ["kind", "x", "y", "w", "h", "rotate", "z", "hidden", "locked", "text", "richText", "textBox", "fontSize", "textMetricsScale", "inheritFontSize", "color", "fill", "src", "image", "shape", "group"];
  function normalizeObject(value, depth = 0, budget = { count: 0 }) {
    record(value, objectKeys, "개체");
    if (++budget.count > 500) throw new Error("그룹 내부를 포함한 추가 요소는 500개까지 사용할 수 있습니다.");
    if (!["text", "image", "shape", "group"].includes(value.kind)) throw new Error("그룹은 추가한 텍스트·이미지·도형만 지원합니다.");
    const result = { kind: value.kind, x: own(value, "x") ? value.x : 0, y: own(value, "y") ? value.y : 0, w: value.w, h: value.h };
    if (!finite(result.x, -5000, 5000) || !finite(result.y, -5000, 5000) || !finite(result.w, 1, 5000) || !finite(result.h, 1, 5000)) throw new Error("개체 위치·크기 값 오류");
    for (const key of ["rotate", "z", "hidden", "locked", "fontSize", "textMetricsScale", "inheritFontSize", "color", "fill", "text", "richText", "textBox", "src", "image", "shape", "group"]) {
      if (!own(value, key)) continue;
      const v = value[key];
      if (key === "rotate" && !finite(v, -360, 360)) throw new Error("회전 값 오류");
      if (key === "z" && (!Number.isInteger(v) || !finite(v, -100000, 100000))) throw new Error("레이어 순서 값 오류");
      if (["hidden", "locked"].includes(key) && typeof v !== "boolean") throw new Error("개체 표시·잠금 값 오류");
      if (key === "fontSize" && !finite(v, 6, 400)) throw new Error("글꼴 크기 오류");
      if (key === "textMetricsScale" && (!finite(v, .01, 100) || value.kind !== "text")) throw new Error("텍스트 간격 배율 오류");
      if (key === "inheritFontSize" && (typeof v !== "boolean" || value.kind !== "text" || v && !own(value, "fontSize"))) throw new Error("그룹화 전에 상속한 글꼴 크기를 확인해 주세요.");
      if (key === "text" && (typeof v !== "string" || v.length > (value.richText ? 100000 : 20000))) throw new Error("텍스트가 너무 깁니다.");
      result[key] = ["color", "fill"].includes(key) ? color(v) : key === "richText" ? global.SDText.normalizeRichText(v) : key === "textBox" ? global.SDText.normalizeTextBox(v) : v;
    }
    if (own(value, "image") && value.kind !== "image" || own(value, "shape") && value.kind !== "shape" || own(value, "group") && value.kind !== "group") throw new Error("개체 종류와 편집 속성이 다릅니다.");
    if (value.kind === "shape" && ["text", "richText", "textBox"].some(key => own(value, key))) throw new Error("도형 라벨은 텍스트 상자를 추가해 사용해 주세요.");
    if (value.kind === "group" && ["text", "richText", "textBox", "fontSize", "color", "fill", "src"].some(key => own(value, key))) throw new Error("그룹에는 위치·크기·회전·표시 속성만 적용할 수 있습니다.");
    if (value.kind === "image") { result.src = safeImageSource(value.src); result.image = normalizeImage(value.image); }
    if (value.kind === "shape") result.shape = normalizeShape(value.shape, value.fill);
    if (value.kind === "group") {
      if (++depth > 4) throw new Error("그룹 중첩은 4단계까지 지원합니다.");
      result.group = groupValue(value.group, depth, budget);
      assertUniform(result);
    }
    return result;
  }
  function groupValue(value, depth, budget) {
    record(value, ["width", "height", "children"], "그룹");
    if (!finite(value.width, 1, 5000) || !finite(value.height, 1, 5000)) throw new Error("그룹 내부 크기 오류");
    array(value.children, "그룹");
    if (value.children.length < 2) throw new Error("그룹에는 두 개 이상의 개체가 필요합니다.");
    return { width: value.width, height: value.height, children: value.children.map(child => normalizeObject(child, depth, budget)) };
  }
  function normalizeGroup(value) { return groupValue(value, 1, { count: 1 }); }
  function assertUniform(object) {
    const sx = object.w / object.group.width, sy = object.h / object.group.height;
    if (!finite(sx, .000001, 5000) || !finite(sy, .000001, 5000) || Math.abs(object.h - object.group.height * sx) > .05 || Math.abs(object.w - object.group.width * sy) > .05) throw new Error("그룹 크기는 가로·세로 비율을 유지해야 합니다.");
    return sx;
  }
  const turn = degrees => { const n = ((degrees + 180) % 360 + 360) % 360 - 180; return round(n); };
  function groupObjects(values) {
    array(values, "선택 개체");
    if (values.length < 2) throw new Error("그룹으로 묶을 개체를 두 개 이상 선택해 주세요.");
    const budget = { count: 1 }, objects = values.map(v => normalizeObject(v, 1, budget));
    const boxes = objects.map(o => { const a = (o.rotate || 0) * Math.PI / 180, w = Math.abs(Math.cos(a)) * o.w + Math.abs(Math.sin(a)) * o.h, h = Math.abs(Math.sin(a)) * o.w + Math.abs(Math.cos(a)) * o.h; return { x: o.x + (o.w - w) / 2, y: o.y + (o.h - h) / 2, w, h }; });
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    const w = Math.max(...boxes.map(b => b.x + b.w)) - x, h = Math.max(...boxes.map(b => b.y + b.h)) - y;
    return normalizeObject({ kind: "group", x: round(x), y: round(y), w: round(w), h: round(h), rotate: 0, z: Math.max(...objects.map(o => o.z ?? 20)), group: { width: round(w), height: round(h), children: objects.map(o => ({ ...o, x: round(o.x - x), y: round(o.y - y) })) } });
  }
  function ungroup(value) {
    const o = normalizeObject(value);
    if (o.kind !== "group") throw new Error("선택한 개체가 그룹이 아닙니다.");
    const scale = assertUniform(o), a = (o.rotate || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    return o.group.children.map(child => {
      const dx = (child.x + child.w / 2 - o.group.width / 2) * scale, dy = (child.y + child.h / 2 - o.group.height / 2) * scale;
      const next = structuredClone(child);
      next.w = round(child.w * scale); next.h = round(child.h * scale);
      next.x = round(o.x + o.w / 2 + dx * cos - dy * sin - next.w / 2);
      next.y = round(o.y + o.h / 2 + dx * sin + dy * cos - next.h / 2);
      next.rotate = turn((child.rotate || 0) + (o.rotate || 0));
      if (next.kind === "text") {
        next.fontSize = round((next.fontSize ?? 48) * scale);
        next.textMetricsScale = round((next.textMetricsScale ?? 1) * scale);
        if (next.richText) for (const p of next.richText.paragraphs) {
          if (p.spaceAfter !== undefined) p.spaceAfter = round(p.spaceAfter * scale);
          for (const r of p.runs) if (r.fontSize !== undefined) r.fontSize = round(r.fontSize * scale);
        }
      }
      if (next.kind === "shape") next.shape.strokeWidth = round(next.shape.strokeWidth * scale);
      return normalizeObject(next);
    });
  }
  function position(element, object) {
    Object.assign(element.style, { position: "absolute", left: "0px", top: "0px", margin: "0px", boxSizing: "border-box", whiteSpace: "pre-wrap", zIndex: String(object.z ?? 20) });
    element.style.setProperty("translate", `${object.x ?? 0}px ${object.y ?? 0}px`);
    if (object.w !== undefined) element.style.width = object.w + "px";
    if (object.h !== undefined) element.style.height = object.h + "px";
    if (object.rotate !== undefined) element.style.setProperty("rotate", object.rotate + "deg");
    if (object.fontSize !== undefined || object.kind === "text" && !object.inheritFontSize) element.style.fontSize = (object.fontSize ?? 48) + "px";
    if (object.color) { element.style.color = object.color; element.style.webkitTextFillColor = object.color; }
    if (object.fill && object.kind !== "shape") element.style.background = object.fill;
    if (object.hidden) element.style.display = "none";
  }
  function createElement(document, object) {
    const element = document.createElement("div");
    position(element, object);
    element.setAttribute("data-sd-kind", object.kind);
    if (object.kind === "text") {
      element.setAttribute("data-sd-text-metrics-scale", String(object.textMetricsScale ?? 1));
      element.textContent = object.text || "";
      if (object.richText !== undefined || object.textBox !== undefined) global.SDText.renderRichText(element, object.richText, object.textBox);
    } else applyVisual(element, object);
    return element;
  }
  const observed = new WeakSet();
  function layoutImage(element) {
    const img = element.querySelector(":scope > [data-sd-image-window] > img"), window = img?.parentElement;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const width = parseFloat(element.style.width) || element.clientWidth, height = parseFloat(element.style.height) || element.clientHeight;
    if (!width || !height) return;
    const layout = imageLayout(width, height, img.naturalWidth, img.naturalHeight, JSON.parse(element.getAttribute("data-sd-image")));
    Object.assign(window.style, { left: layout.frame.x + "px", top: layout.frame.y + "px", width: layout.frame.w + "px", height: layout.frame.h + "px" });
    Object.assign(img.style, { left: (layout.x - layout.frame.x) + "px", top: (layout.y - layout.frame.y) + "px", width: layout.w + "px", height: layout.h + "px" });
  }
  function watchImage(element) {
    const img = element.querySelector(":scope > [data-sd-image-window] > img");
    if (!img) return;
    if (!observed.has(img)) { img.addEventListener("load", () => layoutImage(element)); observed.add(img); }
    if (typeof global.ResizeObserver === "function" && !observed.has(element)) {
      const observer = new global.ResizeObserver(() => layoutImage(element)); observer.observe(element); observed.add(element);
    }
    layoutImage(element);
  }
  function applyVisual(element, object) {
    const document = element.ownerDocument;
    if (object.kind === "image") {
      element.setAttribute("data-sd-kind", "image");
      element.setAttribute("data-sd-image", JSON.stringify(normalizeImage(object.image)));
      element.style.overflow = "hidden";
      let window = element.querySelector(":scope > [data-sd-image-window]"), img = window?.querySelector("img");
      if (!img) {
        window = document.createElement("div"); window.setAttribute("data-sd-image-window", "");
        window.style.cssText = "position:absolute;left:0px;top:0px;width:100%;height:100%;overflow:hidden;padding:0px;margin:0px;border:0px;";
        img = document.createElement("img"); img.setAttribute("data-sd-image-source", ""); img.setAttribute("alt", ""); img.setAttribute("draggable", "false");
        img.style.cssText = "position:absolute;display:block;left:0px;top:0px;width:100%;height:100%;max-width:none;max-height:none;min-width:0px;min-height:0px;margin:0px;padding:0px;border:0px;object-fit:fill;pointer-events:none;";
        window.append(img); element.replaceChildren(window);
      }
      if (img.getAttribute("src") !== object.src) img.setAttribute("src", safeImageSource(object.src));
      watchImage(element);
    } else if (object.kind === "shape") {
      const shape = normalizeShape(object.shape, object.fill), width = object.w || parseFloat(element.style.width) || 100, height = object.h || parseFloat(element.style.height) || 100;
      element.setAttribute("data-sd-kind", "shape"); element.setAttribute("data-sd-shape", JSON.stringify(shape));
      element.style.background = "transparent";
      const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%"); svg.setAttribute("aria-hidden", "true");
      svg.style.cssText = "display:block;overflow:visible;pointer-events:none;";
      const inset = Math.min(shape.strokeWidth / 2, width / 2, height / 2), node = document.createElementNS(ns, shape.type === "rect" ? "rect" : shape.type === "ellipse" ? "ellipse" : "path");
      const attr = (name, v) => node.setAttribute(name, String(v));
      if (shape.type === "rect") { attr("x", inset); attr("y", inset); attr("width", Math.max(0, width - 2 * inset)); attr("height", Math.max(0, height - 2 * inset)); }
      else if (shape.type === "ellipse") { attr("cx", width / 2); attr("cy", height / 2); attr("rx", Math.max(0, width / 2 - inset)); attr("ry", Math.max(0, height / 2 - inset)); }
      else {
        const right = width - inset, mid = height / 2, head = Math.min(width / 2, Math.max(8, shape.strokeWidth * 3)), half = Math.min(Math.max(0, height / 2 - inset), head / 2);
        attr("d", `M ${inset} ${mid} L ${right} ${mid}`);
        if (shape.type === "arrow") {
          const tip=document.createElementNS(ns,"path");
          tip.setAttribute("d",`M ${right-head} ${mid-half} L ${right} ${mid} L ${right-head} ${mid+half}`);
          for(const [key,value] of Object.entries({fill:"none",stroke:shape.stroke,"stroke-width":shape.strokeWidth,"stroke-linejoin":"round"})) tip.setAttribute(key,String(value));
          svg.append(tip);
        }
      }
      attr("fill", ["line", "arrow"].includes(shape.type) ? "none" : shape.fill); attr("stroke", shape.stroke); attr("stroke-width", shape.strokeWidth);
      attr("stroke-linejoin", "round");
      if (shape.dash !== "solid") attr("stroke-dasharray", shape.dash === "dash" ? `${shape.strokeWidth * 4} ${shape.strokeWidth * 3}` : `${shape.strokeWidth} ${shape.strokeWidth * 2}`);
      svg.append(node); element.replaceChildren(svg);
    } else if (object.kind === "group") {
      const group = normalizeGroup(object.group), scale = assertUniform({ ...object, group });
      const serialized = JSON.stringify(group), existing = element.querySelector(":scope > [data-sd-group-content]");
      if (existing && element.getAttribute("data-sd-group") === serialized) {
        existing.style.transform = `scale(${scale})`;
        return element;
      }
      element.setAttribute("data-sd-kind", "group"); element.setAttribute("data-sd-group", serialized);
      const inner = document.createElement("div"); inner.setAttribute("data-sd-group-content", "");
      inner.style.cssText = `position:absolute;left:0px;top:0px;width:${group.width}px;height:${group.height}px;transform-origin:0 0;transform:scale(${scale});margin:0px;padding:0px;border:0px;`;
      for (const child of group.children) inner.append(createElement(document, child));
      element.replaceChildren(inner);
      refresh(element);
    }
    return element;
  }
  function refresh(root) {
    const elements = [root, ...(root?.querySelectorAll?.('[data-sd-kind="image"],[data-sd-rich="true"]') || [])];
    for (const element of elements) {
      if (element?.getAttribute?.("data-sd-kind") === "image") watchImage(element);
      if (element?.getAttribute?.("data-sd-rich") === "true" && global.SDTextEditor) global.SDTextEditor.fit(element);
    }
  }
  global.SDObjects = Object.freeze({ normalizeImage, normalizeShape, normalizeGroup, normalizeObject, safeImageSource, imageLayout, groupObjects, ungroup, assertUniform, createElement, applyVisual, refresh });
})(globalThis);
