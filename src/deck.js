import { parseHTML } from "linkedom";
import { record, normalizeCode, codeIds, renderAuthoring } from "./authoring.js";
import "../public/text-model.js";
import "../public/object-model.js";
import "../public/slide-model.js";
const { normalizeRichText, normalizeTextBox, renderRichText } = globalThis.SDText;
const Objects = globalThis.SDObjects;
const Slides = globalThis.SDSlides;
// Keep states at the former 2 MB boundary editable after adding default fields.
const stateSizeLimit = 2_000_000 + 1024;
const tags = "h1,h2,h3,h4,p,li,td,th,img,blockquote,figcaption,code,span,div";
const num = (x, min, max) =>
  typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
export function extractNotes(slide) {
  const notes = slide.querySelector(".notes")?.cloneNode(true);
  if (!notes) return "";
  for (const br of notes.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of notes.querySelectorAll("p,div,li")) {
    if (block.nextSibling && !block.textContent.endsWith("\n")) block.append("\n");
  }
  return notes.textContent;
}
// Imported notes remain in the immutable source even when they cannot fit the
// editable state. Explicit user edits are still checked by validateState.
export function inheritNotes(state, inherited) {
  const notes = { ...(state.notes || {}) };
  let size = JSON.stringify({ ...state, notes }).length, count = Object.keys(notes).length;
  for (const [id, text] of Object.entries(inherited)) {
    if (Object.hasOwn(notes, id) || typeof text !== "string" || text.length > 20000) continue;
    const extra = (count ? 1 : 0) + JSON.stringify(id).length + 1 + JSON.stringify(text).length;
    if (size + extra > stateSizeLimit) continue;
    notes[id] = text; size += extra; count++;
  }
  return notes;
}
function initialNotes(deck, clones = {}, state = {}) {
  const notes = Object.fromEntries(deck.slides.map(slide => [slide.id, slide.notes ?? ""]));
  for (const [id, source] of Object.entries(clones)) notes[id] = notes[source] ?? "";
  return inheritNotes(state, notes);
}
export function prepareDeck(html) {
  const { document } = parseHTML(html);
  if (!document.body) throw new Error("HTML 문서가 필요합니다.");
  if (document.querySelector("base"))
    throw new Error("base 태그 대신 상대 경로를 사용해 주세요.");
  let slides = [...document.querySelectorAll(".slide")];
  if (!slides.length)
    slides = [...document.querySelectorAll("main > section,body > section")];
  if (!slides.length || slides.length > 80)
    throw new Error("1~80개의 .slide 또는 section 슬라이드가 필요합니다.");
  if (slides.some((s) => s.parentElement !== slides[0].parentElement))
    throw new Error("슬라이드는 같은 부모 안에 있어야 합니다.");
  let n = 0;
  const elements = [];
  for (const [i, s] of slides.entries()) {
    s.classList.add("slide");
    s.setAttribute("data-sd-slide", "s" + i);
    for (const e of s.querySelectorAll(tags)) {
      if (
        e.closest(".notes,script,style") ||
        (e.matches("span,div") && (e.children.length || !e.textContent.trim()))
      )
        continue;
      const id = "e" + n++;
      e.setAttribute("data-sd-id", id);
      elements.push({ id, slide: "s" + i, tag: e.localName });
    }
  }
  return {
    html: document.toString(),
    title: document.title || "새 발표 자료",
    slides: slides.map((s, i) => ({
      id: "s" + i,
      title:
        s.querySelector("h1,h2,h3")?.textContent.trim() ||
        `${i + 1}번 슬라이드`,
      scene: s.getAttribute("data-scene") || "",
      notes: extractNotes(s),
    })),
    elements,
  };
}
export function initialState(deck) {
  const state = {
    schemaVersion: 1,
    order: deck.slides.map((s) => s.id),
    patches: {},
    added: [],
    clones: {},
    scenes: {},
    background: true,
    slideCode: {},
    masters: {},
    slideMasters: {},
    notes: {},
    slideLayouts: {},
    theme: Slides.normalizeTheme(),
  };
  state.notes = initialNotes(deck, {}, state);
  return state;
}
const stateKeys = new Set(["schemaVersion", "order", "patches", "added", "clones", "scenes", "background", "slideCode", "masters", "slideMasters", "notes", "slideLayouts", "theme"]);
function strictRecord(value, label, allowed) {
  record(value, label);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || allowed && !allowed.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error(`허용되지 않는 ${label} 항목입니다.`);
  }
}
export function migrateState(raw) {
  strictRecord(raw, "편집 데이터", stateKeys);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new Error("지원하지 않는 편집 데이터 버전입니다.");
  if (Object.hasOwn(raw, "theme")) Slides.normalizeTheme(raw.theme);
  if (Object.hasOwn(raw, "notes")) strictRecord(raw.notes, "발표자 노트");
  if (Object.hasOwn(raw, "slideLayouts")) {
    strictRecord(raw.slideLayouts, "슬라이드 레이아웃");
    for (const layout of Object.values(raw.slideLayouts)) Slides.normalizeLayout(layout);
  }
  if (Object.hasOwn(raw, "patches")) {
    record(raw.patches, "수정 데이터");
    for (const patch of Object.values(raw.patches)) {
      record(patch, "수정 항목");
      validateTextFields(patch);
    }
  }
  if (Array.isArray(raw.added)) for (const added of raw.added) {
    record(added, "추가 요소");
    validateTextFields(added);
  }
  const state = structuredClone(raw);
  // Earlier rectangles were ordinary DIVs and supported text editing. Preserve
  // those labels as text boxes before introducing the generated SVG shape body.
  for (const added of state.added || []) {
    const patch = state.patches?.[added.id] || {};
    if (added.kind === "shape" && !Object.hasOwn(added, "shape") && !Object.hasOwn(patch, "shape") &&
      ["text", "richText", "textBox"].some(key => Object.hasOwn(added, key) || Object.hasOwn(patch, key))) {
      added.kind = "text";
      if (!Object.hasOwn(added, "fontSize") && !Object.hasOwn(patch, "fontSize")) added.inheritFontSize = true;
    }
  }
  state.schemaVersion = 1;
  for (const key of ["clones", "scenes", "slideCode", "masters", "slideMasters", "notes", "slideLayouts"]) {
    if (!Object.hasOwn(state, key)) state[key] = {};
    record(state[key], key);
  }
  state.theme = Slides.normalizeTheme(state.theme);
  return state;
}
const patchKeys = new Set([
  "text",
  "richText",
  "textBox",
  "src",
  "x",
  "y",
  "w",
  "h",
  "rotate",
  "fontSize",
  "color",
  "fill",
  "hidden",
  "locked",
  "z",
  "layerPosition",
  "image",
  "shape",
  "textMetricsScale",
  "inheritFontSize",
]);
function validateTextFields(patch) {
  if (Object.hasOwn(patch, "richText")) normalizeRichText(patch.richText);
  if (Object.hasOwn(patch, "textBox")) normalizeTextBox(patch.textBox);
  if (Object.hasOwn(patch, "image")) Objects.normalizeImage(patch.image);
  if (Object.hasOwn(patch, "shape")) Objects.normalizeShape(patch.shape);
  if (Object.hasOwn(patch, "group")) Objects.normalizeGroup(patch.group);
}
function validPatch(p) {
  record(p, "편집 데이터");
  for (const [k, v] of Object.entries(p)) {
    if (!patchKeys.has(k)) throw new Error("허용되지 않는 편집 항목입니다.");
    if (k === "richText") p.richText = normalizeRichText(v);
    if (k === "textBox") p.textBox = normalizeTextBox(v);
    if (k === "image") p.image = Objects.normalizeImage(v);
    if (k === "shape") p.shape = Objects.normalizeShape(v);
    if (k === "textMetricsScale" && !num(v, .01, 100)) throw new Error("텍스트 간격 배율 오류");
    if (k === "inheritFontSize" && typeof v !== "boolean") throw new Error("텍스트 글꼴 상속 값 오류");
    if (k === "text" && (typeof v !== "string" || v.length > (Object.hasOwn(p, "richText") ? 100000 : 20000)))
      throw new Error("텍스트가 너무 깁니다.");
    if (k === "src") Objects.safeImageSource(v);
    if (["x", "y"].includes(k) && !num(v, -5000, 5000))
      throw new Error("위치 값 오류");
    if (["w", "h"].includes(k) && !num(v, 1, 5000))
      throw new Error("크기 값 오류");
    if (k === "rotate" && !num(v, -360, 360)) throw new Error("회전 값 오류");
    if (k === "fontSize" && !num(v, 6, 400)) throw new Error("글꼴 크기 오류");
    if (["color", "fill"].includes(k) && !/^#[\da-f]{6}$/i.test(v))
      throw new Error("색상 값 오류");
    if (k === "hidden" && typeof v !== "boolean")
      throw new Error("표시 값 오류");
    if (k === "locked" && typeof v !== "boolean")
      throw new Error("잠금 값 오류");
    if (k === "z" && (!Number.isInteger(v) || !num(v, -100000, 100000)))
      throw new Error("레이어 순서 값 오류");
    if (k === "layerPosition" && v !== "relative")
      throw new Error("레이어 위치 값 오류");
  }
}
export function validateState(raw, deck) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("편집 데이터가 너무 큽니다.");
  const state = migrateState(raw);
  if (JSON.stringify(state).length > stateSizeLimit) throw new Error("편집 데이터가 너무 큽니다.");
  if (!Object.hasOwn(raw, "notes")) state.notes = initialNotes(deck, state.clones, state);
  if (
    !Array.isArray(state.order) ||
    !state.order.length ||
    state.order.length > 80 ||
    new Set(state.order).size !== state.order.length
  )
    throw new Error("슬라이드 순서가 잘못되었습니다.");
  const slideIds = new Set(deck.slides.map((s) => s.id));
  const ids = new Set(deck.elements.map((e) => e.id));
  if (Object.keys(state.clones).length > 80)
    throw new Error("슬라이드가 너무 많습니다.");
  for (const [id, source] of Object.entries(state.clones)) {
    if (
      !/^s-[a-z0-9-]{1,50}$/.test(id) ||
      (source !== null && !slideIds.has(source))
    )
      throw new Error("복제 슬라이드 오류");
    for (const e of deck.elements.filter((e) => e.slide === source))
      ids.add(id + "--" + e.id);
  }
  for (const id of Object.keys(state.clones)) slideIds.add(id);
  if (state.order.some((id) => !slideIds.has(id)))
    throw new Error("알 수 없는 슬라이드입니다.");
  for (const [id, code] of Object.entries(state.slideCode)) {
    if (!slideIds.has(id)) throw new Error("알 수 없는 코드 슬라이드입니다.");
    const source = Object.hasOwn(state.clones, id) ? state.clones[id] : id;
    const originalIds = new Set(deck.elements.filter((element) => element.slide === source).map((element) => source === id ? element.id : id + "--" + element.id));
    state.slideCode[id] = normalizeCode(code, id, originalIds);
    for (const elementId of originalIds) ids.delete(elementId);
    for (const elementId of codeIds(state.slideCode[id].html)) ids.add(elementId);
  }
  if (Object.keys(state.masters).length > 80) throw new Error("마스터는 80개까지 만들 수 있습니다.");
  for (const [id, master] of Object.entries(state.masters)) {
    if (!/^m-[a-z0-9-]{1,50}$/.test(id)) throw new Error("마스터 ID 오류");
    state.masters[id] = normalizeCode(master, id, new Set(), true);
  }
  for (const [id, masterId] of Object.entries(state.slideMasters)) {
    if (!slideIds.has(id) || typeof masterId !== "string" || !Object.hasOwn(state.masters, masterId)) throw new Error("슬라이드 마스터 연결 오류");
  }
  if (!Array.isArray(state.added) || state.added.length > 500)
    throw new Error("추가 요소가 너무 많습니다.");
  for (const a of state.added) {
    if (
      !/^a-[a-z0-9-]{1,50}$/.test(a.id) ||
      ids.has(a.id) ||
      !slideIds.has(a.slide) ||
      !["text", "image", "shape", "html", "group"].includes(a.kind)
    )
      throw new Error("추가 요소 오류");
    ids.add(a.id);
    const { id, slide, kind, html, group, ...p } = a;
    if (kind === "html") {
      a.html = normalizeCode({ name: "object", html, css: "" }, id, new Set(), true).html;
      const { document } = parseHTML("<html><body>" + a.html + "</body></html>");
      for (const element of document.body.querySelectorAll("*")) {
        if ([...element.attributes].some((attribute) => ["id", "data-sd-id"].includes(attribute.name.toLowerCase())))
          throw new Error("복제 개체 내부에는 ID를 사용할 수 없습니다.");
      }
    } else if (Object.hasOwn(a, "html")) throw new Error("HTML은 복제 개체에서만 사용할 수 있습니다.");
    if (kind === "group") a.group = Objects.normalizeGroup(group);
    else if (Object.hasOwn(a, "group")) throw new Error("그룹 속성은 그룹 개체에서만 사용할 수 있습니다.");
    if (Object.hasOwn(p, "image") && kind !== "image" || Object.hasOwn(p, "shape") && kind !== "shape" || ["textMetricsScale", "inheritFontSize"].some(key => Object.hasOwn(p, key)) && kind !== "text") throw new Error("개체 종류와 편집 속성이 다릅니다.");
    validPatch(p);
    Object.assign(a, p);
  }
  if (
    !state.patches ||
    typeof state.patches !== "object" ||
    Array.isArray(state.patches)
  )
    throw new Error("수정 데이터 오류");
  for (const [id, p] of Object.entries(state.patches)) {
    if (!ids.has(id)) throw new Error("알 수 없는 요소입니다.");
    validPatch(p);
    const added = state.added.find(item => item.id === id);
    if (Object.hasOwn(p, "image") && added?.kind !== "image" || Object.hasOwn(p, "shape") && added?.kind !== "shape" || ["textMetricsScale", "inheritFontSize"].some(key => Object.hasOwn(p, key)) && added?.kind !== "text") throw new Error("개체 종류와 편집 속성이 다릅니다.");
  }
  let total = 0;
  const count = object => { total++; for (const child of object.group?.children || []) count(child); };
  for (const a of state.added) {
    count(a);
    const effective = { ...a, ...(state.patches[a.id] || {}) };
    if (a.kind === "image") Objects.safeImageSource(effective.src);
    if (a.kind === "shape" && ["text", "richText", "textBox"].some(key => Object.hasOwn(effective, key))) throw new Error("도형 라벨은 텍스트 상자를 추가해 사용해 주세요.");
    if (a.kind === "group") {
      const { id, slide, ...object } = effective;
      Objects.normalizeObject(object);
    }
  }
  if (total > 500) throw new Error("그룹 내부를 포함한 추가 요소는 500개까지 사용할 수 있습니다.");
  for (const [id, notes] of Object.entries(state.notes)) {
    if (!slideIds.has(id) || typeof notes !== "string" || notes.length > 20000)
      throw new Error("발표자 노트는 유효한 슬라이드의 20,000자 이내 텍스트여야 합니다.");
  }
  const placeholderIds = new Set();
  for (const [id, rawLayout] of Object.entries(state.slideLayouts)) {
    if (!slideIds.has(id)) throw new Error("알 수 없는 레이아웃 슬라이드입니다.");
    const layout = Slides.normalizeLayout(rawLayout);
    for (const objectId of Object.values(layout.placeholders)) {
      const object = state.added.find(item => item.id === objectId);
      if (!object || object.slide !== id || object.kind !== "text" || placeholderIds.has(objectId))
        throw new Error("자리표시자는 해당 슬라이드의 서로 다른 추가 텍스트 개체여야 합니다.");
      placeholderIds.add(objectId);
    }
    state.slideLayouts[id] = layout;
  }
  for (const [id, scene] of Object.entries(state.scenes)) {
    if (
      !slideIds.has(id) ||
      typeof scene !== "string" ||
      scene.length > 80 ||
      !/^[\w-]*$/.test(scene)
    )
      throw new Error("장면 오류");
  }
  if (typeof state.background !== "boolean") throw new Error("배경 표시 오류");
  if (JSON.stringify(state).length > stateSizeLimit) throw new Error("편집 데이터가 너무 큽니다.");
  return {
    schemaVersion: state.schemaVersion,
    order: state.order,
    patches: state.patches,
    added: state.added,
    clones: state.clones,
    scenes: state.scenes,
    background: state.background,
    slideCode: state.slideCode,
    masters: state.masters,
    slideMasters: state.slideMasters,
    notes: state.notes,
    slideLayouts: state.slideLayouts,
    theme: state.theme,
  };
}
export function applyPatch(e, p) {
  if (p.text !== undefined && p.richText === undefined) {
    e.textContent = p.text;
    e.removeAttribute("data-sd-rich");
    e.removeAttribute("data-sd-rich-text");
  }
  if (p.src) e.setAttribute("src", p.src);
  if (p.x !== undefined || p.y !== undefined)
    e.style.setProperty("translate", `${p.x || 0}px ${p.y || 0}px`);
  if (p.w) e.style.width = p.w + "px";
  if (p.h) e.style.height = p.h + "px";
  if (p.rotate !== undefined) e.style.rotate = p.rotate + "deg";
  if (p.fontSize) e.style.fontSize = p.fontSize + "px";
  if (p.color) {
    e.style.color = p.color;
    e.style.webkitTextFillColor = p.color;
  }
  if (p.fill) e.style.background = p.fill;
  if (p.textMetricsScale !== undefined) e.setAttribute("data-sd-text-metrics-scale", String(p.textMetricsScale));
  if (p.richText !== undefined || p.textBox !== undefined) renderRichText(e, p.richText, p.textBox);
  if (p.layerPosition === "relative") {
    e.style.position = "relative";
    for (const property of ["inset", "left", "top", "right", "bottom"])
      e.style.setProperty(property, "auto");
  }
  if (p.z !== undefined) e.style.zIndex = String(p.z);
  if (p.hidden !== undefined) {
    if (p.hidden) e.style.display = "none";
    else {
      let vertical;
      try { vertical = normalizeTextBox(JSON.parse(e.getAttribute("data-sd-text-box"))).vertical; } catch { /* Legacy markup can carry unrelated attributes. */ }
      if (vertical !== undefined) e.style.display = "flex";
      else e.style.removeProperty("display");
    }
  }
}
export function renderDeck(html, state) {
  const { document } = parseHTML(html);
  const originals = [...document.querySelectorAll("[data-sd-slide]")];
  const parent = originals[0].parentElement;
  const all = new Map(
    originals.map((s) => [s.getAttribute("data-sd-slide"), s]),
  );
  for (const [id, source] of Object.entries(state.clones || {})) {
    let s = source
      ? all.get(source)?.cloneNode(true)
      : document.createElement("section");
    if (!s) continue;
    s.setAttribute("data-sd-slide", id);
    s.classList.add("slide");
    if (source)
      for (const e of s.querySelectorAll("[data-sd-id]"))
        e.setAttribute("data-sd-id", id + "--" + e.getAttribute("data-sd-id"));
    all.set(id, s);
  }
  originals.forEach((s) => s.remove());
  for (const id of state.order) {
    const s = all.get(id);
    if (s) parent.append(s);
  }
  renderAuthoring(document, all, state);
  const theme = Slides.normalizeTheme(state.theme);
  for (const [id, slide] of all) {
    slide.style.setProperty("--sd-theme-heading-font", theme.fonts.heading);
    slide.style.setProperty("--sd-theme-body-font", theme.fonts.body);
    slide.style.setProperty("--sd-theme-text", theme.colors.text);
    slide.style.setProperty("--sd-theme-accent", theme.colors.accent);
    if (Object.hasOwn(state.slideLayouts || {}, id)) slide.style.background = theme.colors.background;
    if (Object.hasOwn(state.notes || {}, id)) {
      const existing = [...slide.querySelectorAll(".notes")];
      const notes = existing.shift() || document.createElement("aside");
      existing.forEach(element => element.remove());
      notes.classList.add("notes");
      notes.textContent = state.notes[id];
      notes.style.whiteSpace = "pre-wrap";
      notes.setAttribute("hidden", "");
      if (!notes.parentElement) slide.append(notes);
    }
  }
  for (const a of state.added || []) {
    const s = all.get(a.slide);
    if (!s) continue;
    const effective = { ...a, ...(state.patches[a.id] || {}) };
    let e = ["image", "shape", "group"].includes(a.kind) ? Objects.createElement(document, effective) : document.createElement("div");
    if (a.kind === "html") {
      e.innerHTML = a.html;
      const content = [...e.childNodes].filter(node => node.nodeType === 1 || node.textContent.trim());
      // Keep the snapshot root's typography and image semantics on the editable element.
      if (content.length === 1 && content[0].nodeType === 1) e = content[0];
    }
    e.setAttribute("data-sd-id", a.id);
    e.setAttribute("data-sd-added", "true");
    e.setAttribute("data-sd-kind", a.kind);
    e.style.cssText += ";" + (
      a.kind === "html"
        ? "position:absolute;left:0px;top:0px;margin:0px;box-sizing:border-box;z-index:20;"
        : "position:absolute;left:0;top:0;z-index:20;white-space:pre-wrap;");
    if (a.kind === "text" && !effective.inheritFontSize) e.style.fontSize = "48px";
    applyPatch(e, effective);
    if (["image", "shape", "group"].includes(a.kind)) Objects.applyVisual(e, effective);
    s.append(e);
  }
  for (const e of document.querySelectorAll("[data-sd-id]")) {
    if (e.hasAttribute("data-sd-added")) continue;
    const p = state.patches[e.getAttribute("data-sd-id")];
    if (p) applyPatch(e, p);
  }
  for (const [id, scene] of Object.entries(state.scenes || {}))
    all.get(id)?.setAttribute("data-scene", scene);
  if (!state.background) {
    const style = document.createElement("style");
    style.textContent = "#bg,canvas[data-background]{display:none!important}";
    document.head.append(style);
  }
  return document.toString();
}
