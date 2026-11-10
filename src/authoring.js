import { parseHTML } from "linkedom";

const allowedTags = new Set("h1 h2 h3 h4 h5 h6 p div span section article header footer aside main ul ol li table thead tbody tfoot tr td th colgroup col caption img a br hr strong em b i u s small sub sup blockquote figcaption figure pre code".split(" "));
const editableTags = "h1,h2,h3,h4,h5,h6,p,li,td,th,img,blockquote,figcaption,code,span,div";
const commonAttributes = new Set("id class style title role aria-label aria-hidden alt width height colspan rowspan scope start type target rel href src data-sd-id".split(" "));
const isRecord = (value) => !!value && typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function record(value, label) {
  if (!isRecord(value)) throw new Error(`${label}는 객체여야 합니다.`);
  return value;
}

function localAsset(value) {
  if (typeof value !== "string" || !value || /[\\?#:%\x00-\x1f]/.test(value) || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")))
    throw new Error("코드의 자산 경로는 자료 안의 상대 경로를 사용해 주세요.");
  return value;
}

function cssAssets(css) {
  const result = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"\(]+))\s*\)/gi))
    result.push(localAsset(match[1] ?? match[2] ?? match[3]));
  if ((css.match(/url\s*\(/gi) || []).length !== result.length)
    throw new Error("CSS url() 경로를 확인해 주세요.");
  return result;
}

function checkCSS(css, inline = false) {
  if (typeof css !== "string" || css.length > 100_000 || /[<\\\x00]/.test(css) || /@(?:import|namespace)|expression\s*\(|behavior\s*:|-moz-binding/i.test(css))
    throw new Error("CSS에는 외부 가져오기나 실행 코드를 사용할 수 없습니다.");
  if (inline && /[{}@]/.test(css)) throw new Error("style 속성에는 CSS 선언만 입력해 주세요.");
  // A balanced fragment cannot close the @scope wrapper supplied by the renderer.
  let depth = 0, quote = "", comment = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i], next = css[i + 1];
    if (comment) { if (c === "*" && next === "/") { comment = false; i++; } continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "/" && next === "*") { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth < 0) throw new Error("CSS 중괄호를 확인해 주세요.");
  }
  if (depth || quote || comment) throw new Error("CSS의 괄호·문자열·주석을 닫아 주세요.");
  cssAssets(css);
  return css;
}

export function normalizeCode(raw, slide, allowedIds = new Set(), master = false) {
  record(raw, "코드");
  const keys = master ? ["name", "html", "css"] : ["html", "css", "js"];
  if (Object.keys(raw).some((key) => !keys.includes(key))) throw new Error("허용되지 않는 코드 항목입니다.");
  if (typeof raw.html !== "string" || raw.html.length > 200_000 || /<!doctype|<\/?(?:html|head|body)\b/i.test(raw.html))
    throw new Error("HTML에는 200,000자 이내의 슬라이드 내부 구성만 입력해 주세요.");
  if (master && (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 100))
    throw new Error("마스터 이름은 1~100자로 입력해 주세요.");
  const css = checkCSS(raw.css);
  // Slide JS is emitted inside an inline <script>; it must not be able to close it.
  const js = raw.js ?? "";
  if (typeof js !== "string" || js.length > 100_000 || /<\/script|<!--|\x00/i.test(js))
    throw new Error("JavaScript는 100,000자 이내로 입력하고 </script 와 <!-- 는 사용하지 마세요.");
  const { document } = parseHTML("<html><head></head><body></body></html>");
  document.body.innerHTML = raw.html;
  const used = new Set();
  const codePrefix = `c-${slide}--e`;
  for (const element of document.body.querySelectorAll("*")) {
    if (!allowedTags.has(element.localName)) throw new Error(`지원하지 않는 HTML 태그: ${element.localName}`);
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase(), value = attr.value;
      if (!commonAttributes.has(name) && !/^aria-[a-z-]+$/.test(name))
        throw new Error(`지원하지 않는 HTML 속성: ${name}`);
      if (name === "id" && (/^(?:sd-|studio-)/i.test(value) || ["stage", "hud", "help", "progress", "notes"].includes(value)))
        throw new Error("편집기 예약 ID는 사용할 수 없습니다.");
      if (name === "class" && value.split(/\s+/).some((part) => part === "slide" || part.startsWith("sd-")))
        throw new Error("편집기 예약 class는 사용할 수 없습니다.");
      if (name === "style") checkCSS(value, true);
      if (name === "src") localAsset(value);
      if (name === "href" && !/^#[\w-]+$/.test(value)) throw new Error("코드 링크에는 문서 안의 #대상만 사용할 수 있습니다.");
      if (name === "target" && value !== "_self") throw new Error("링크 대상은 _self만 사용할 수 있습니다.");
    }
    const id = element.getAttribute("data-sd-id");
    if (id !== null) {
      const ownCodeId = id.startsWith(codePrefix) && /^\d+$/.test(id.slice(codePrefix.length));
      if (master || used.has(id) || (!allowedIds.has(id) && !ownCodeId))
        throw new Error("코드 개체 ID가 중복되거나 다른 슬라이드에 속합니다.");
      used.add(id);
    }
  }
  if (!master) {
    let number = 0;
    for (const element of document.body.querySelectorAll(editableTags)) {
      if (element.closest(".notes") || (element.matches("span,div") && (element.children.length || !element.textContent.trim()))) continue;
      if (!element.hasAttribute("data-sd-id")) {
        while (used.has(codePrefix + number)) number++;
        const id = codePrefix + number++;
        element.setAttribute("data-sd-id", id);
        used.add(id);
      }
    }
  }
  return { ...(master ? { name: raw.name.trim() } : {}), html: document.body.innerHTML, css, ...(js.trim() ? { js } : {}) };
}

export function codeIds(html) {
  const { document } = parseHTML("<html><body>" + html + "</body></html>");
  return [...document.querySelectorAll("[data-sd-id]")].map((element) => element.getAttribute("data-sd-id"));
}

export function authoringAssets(state) {
  const refs = new Set();
  const snapshots = (state.added || []).filter((element) => element.kind === "html");
  for (const code of [...Object.values(state.slideCode || {}), ...Object.values(state.masters || {}), ...snapshots]) {
    const { document } = parseHTML("<html><body>" + code.html + "</body></html>");
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        const name = attribute.name.toLowerCase();
        if (name === "src") refs.add(localAsset(attribute.value));
        if (name === "style") for (const asset of cssAssets(attribute.value)) refs.add(asset);
      }
    }
    for (const asset of cssAssets(code.css || "")) refs.add(asset);
  }
  return [...refs];
}

export function authoringSource(html, state, slide) {
  if (!state.order.includes(slide)) throw new Error("알 수 없는 슬라이드입니다.");
  if (state.slideCode?.[slide]) return { slide, ...state.slideCode[slide] };
  const { document } = parseHTML(html);
  const source = Object.hasOwn(state.clones || {}, slide) ? state.clones[slide] : slide;
  const element = source === null ? null : [...document.querySelectorAll("[data-sd-slide]")].find((item) => item.getAttribute("data-sd-slide") === source);
  if (element && source !== slide) for (const child of element.querySelectorAll("[data-sd-id]")) child.setAttribute("data-sd-id", slide + "--" + child.getAttribute("data-sd-id"));
  return { slide, html: element?.innerHTML || "", css: "" };
}

export function renderAuthoring(document, slides, state) {
  if (Object.keys(state.slideMasters || {}).length) {
    const defaults = document.createElement("style");
    defaults.textContent = ":where([data-sd-slide]){position:relative}";
    document.head.append(defaults);
  }
  for (const [id, code] of Object.entries(state.slideCode || {})) {
    const slide = slides.get(id);
    if (!slide) continue;
    slide.innerHTML = code.html;
    const style = document.createElement("style");
    style.textContent = `@scope ([data-sd-slide="${id}"]) to ([data-sd-master]) {${code.css}}`;
    document.head.append(style);
    if (code.js) {
      // Registered only; effects.js calls it with the slide element when the slide is shown.
      const script = document.createElement("script");
      script.setAttribute("data-sd-slide-js", id);
      script.textContent = `(globalThis.SDSlideScripts||={})[${JSON.stringify(id)}]=function(slide){\n${code.js}\n};`;
      document.head.append(script);
    }
  }
  for (const [id, masterId] of Object.entries(state.slideMasters || {})) {
    const slide = slides.get(id), master = state.masters?.[masterId];
    if (!slide || !master) continue;
    slide.style.isolation = "isolate";
    const layer = document.createElement("div");
    layer.setAttribute("data-sd-master", masterId);
    layer.setAttribute("data-sd-master-instance", id);
    layer.style.cssText = "position:absolute;inset:0;z-index:-1;pointer-events:none;";
    layer.innerHTML = master.html;
    slide.prepend(layer);
    const style = document.createElement("style");
    style.textContent = `@scope ([data-sd-master-instance="${id}"]) {${master.css}}`;
    document.head.append(style);
  }
}

// Scope for JavaScript proposed by AI (review proposals only). It may work with the
// `slide` element subtree, Web Animations, timers and plain values. Anything that
// reaches the page, other frames, storage, the network, navigation or code
// generation is refused. This is a static tripwire for reviewers, not a sandbox:
// the content origin's CSP/sandbox and the human review remain the real boundary.
const aiScriptLimit = 20_000;
const aiScriptAnywhere = "window globalThis document ownerDocument getRootNode defaultView contentWindow contentDocument currentScript baseURI fetch XMLHttpRequest WebSocket EventSource sendBeacon RTCPeerConnection Worker SharedWorker serviceWorker importScripts eval Function import require cookie localStorage sessionStorage indexedDB caches postMessage BroadcastChannel MessageChannel innerHTML outerHTML insertAdjacentHTML setHTMLUnsafe srcdoc createContextualFragment DOMParser Range setAttribute setAttributeNS setAttributeNode attributes href src srcset action dispatchEvent click submit constructor __proto__ prototype Reflect Proxy this arguments caller callee parentNode parentElement offsetParent closest SDSlideScripts SDEffects __sd".split(" ");
// Ambient globals that are also ordinary property names (style.top, {top: ...}).
const aiScriptBare = "top parent opener location history navigator open close frames self origin name status".split(" ");
export function checkAiScript(js) {
  if (js.length > aiScriptLimit) throw new Error(`AI가 작성하는 JavaScript는 ${aiScriptLimit.toLocaleString("en-US")}자까지 허용합니다.`);
  if (/\\[ux]/i.test(js)) throw new Error("AI JavaScript 범위 밖: \\u·\\x 이스케이프는 사용할 수 없습니다.");
  const found = new Set();
  for (const word of js.match(/[A-Za-z_$][\w$]*/g) || []) if (aiScriptAnywhere.includes(word)) found.add(word);
  for (const match of js.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?!\s*:)/g)) if (aiScriptBare.includes(match[1])) found.add(match[1]);
  if (/\.\s*view\b/.test(js)) found.add(".view");
  if (found.size) throw new Error("AI JavaScript 범위 밖: " + [...found].slice(0, 12).join(", ") + " 은(는) 사용할 수 없습니다. slide 요소 내부의 DOM·애니메이션·타이머만 다루세요.");
}

// Deck-wide ("common") code: the imported package's inline <style>/<script> blocks in
// index.html and the local .css/.js files it links. The source stays immutable; the
// state stores text overrides keyed by style:N / script:N (document order in the
// source) or file:<path>. It is the same trust level as the uploaded package.
const commonLimit = 300_000;
const commonKey = /^(?:style:\d{1,3}|script:\d{1,3}|file:[\w./-]{1,200}\.(?:css|js))$/i;
const inlineBlocks = (document) => ({
  style: [...document.querySelectorAll("style")],
  script: [...document.querySelectorAll("script")].filter((script) => !script.hasAttribute("src") && /^(?:|text\/javascript|module)$/i.test(script.getAttribute("type") || "")),
});
export function normalizeCommon(raw) {
  record(raw, "공통 코드");
  const entries = Object.entries(raw);
  if (entries.length > 50) throw new Error("공통 코드는 50개 항목까지 수정할 수 있습니다.");
  for (const [key, text] of entries) {
    if (!commonKey.test(key)) throw new Error("공통 코드 항목 이름 오류");
    if (key.startsWith("file:")) localAsset(key.slice(5));
    if (typeof text !== "string" || text.length > commonLimit || text.includes("\x00")) throw new Error("공통 코드는 항목마다 300,000자까지 입력할 수 있습니다.");
    if (key.startsWith("style:") && /<\/style/i.test(text)) throw new Error("공통 CSS에는 </style 을 쓸 수 없습니다.");
    if (key.startsWith("script:") && /<\/script|<!--/i.test(text)) throw new Error("공통 JavaScript에는 </script 와 <!-- 를 쓸 수 없습니다.");
  }
  return raw;
}
export function applyCommon(document, state) {
  const blocks = inlineBlocks(document);
  for (const [key, text] of Object.entries(state.common || {})) {
    const [kind, index] = key.split(":");
    if (kind !== "file" && blocks[kind][index]) blocks[kind][index].textContent = text;
  }
}
// read(path) resolves to the file text, or null when it is missing or too large to edit.
export async function commonSources(html, state, read) {
  const { document } = parseHTML(html), blocks = inlineBlocks(document), common = [], skipped = [];
  const add = (key, label, kind, original) => common.push({ key, label, kind, original, text: state.common?.[key] ?? original });
  blocks.style.forEach((element, index) => add("style:" + index, `index.html <style> ${index + 1}`, "css", element.textContent));
  const linked = new Set();
  for (const element of document.querySelectorAll('link[rel~="stylesheet"][href],script[src]')) {
    const path = (element.getAttribute("href") ?? element.getAttribute("src")).replace(/[?#].*$/, "").replace(/^\.\//, "");
    try { localAsset(path); } catch { continue; }
    if (!/\.(?:css|js)$/i.test(path) || linked.has(path)) continue;
    linked.add(path);
    const original = /\.min\./i.test(path) ? null : await read(path);
    if (original === null || original.length > commonLimit) skipped.push(path);
    else add("file:" + path, path, /\.css$/i.test(path) ? "css" : "js", original);
  }
  blocks.script.forEach((element, index) => add("script:" + index, `index.html <script> ${index + 1}`, "js", element.textContent));
  return { common, skipped };
}
