(() => {
  "use strict";
  const T = globalThis.SDText;
  const round = n => Math.round(n * 100) / 100;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const blocks = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"]);
  const color = value => {
    const rgb = value.match(/[\d.]+/g);
    return rgb?.length >= 3 ? "#" + rgb.slice(0, 3).map(n => Math.round(Number(n)).toString(16).padStart(2, "0")).join("") : "#000000";
  };
  function eligible(el) {
    return !!el && !["IMG", "SVG", "CANVAS", "VIDEO", "IFRAME", "INPUT", "TEXTAREA", "BUTTON", "SELECT"].includes(el.tagName) &&
      !el.querySelector("[data-sd-id],img,svg,canvas,video,audio,iframe,input,textarea,button,select,table,script,style");
  }
  function runStyle(node, scale = 1, root = node) {
    const c = getComputedStyle(node);
    let underline = false;
    for (let parent = node; parent; parent = parent.parentElement) {
      underline ||= getComputedStyle(parent).textDecorationLine.includes("underline");
      if (parent === root) break;
    }
    return { fontFamily: c.fontFamily, fontSize: round(parseFloat(c.fontSize) / scale), color: color(c.color), bold: Number(c.fontWeight) >= 600, italic: c.fontStyle === "italic" || c.fontStyle === "oblique", underline };
  }
  function paragraphStyle(node, scale = 1) {
    const c = getComputedStyle(node), size = parseFloat(c.fontSize) || 16;
    const lineHeight = c.lineHeight === "normal" ? 1.2 : parseFloat(c.lineHeight) / size;
    const parent = node.parentElement;
    return { align: ["left", "center", "right", "justify"].includes(c.textAlign) ? c.textAlign : "left", lineHeight: round(clamp(lineHeight, 0.5, 4)), spaceAfter: round(clamp(parseFloat(c.marginBottom) / scale || 0, 0, 200)), indent: clamp(Number(node.dataset.sdIndent) || 0, 0, 8), list: node.dataset.sdList || (node.tagName === "LI" ? parent?.tagName === "OL" ? "number" : "bullet" : "none") };
  }
  function scan(el) {
    const scale = Number(el.dataset.sdFontScale) || 1;
    const container = el.querySelector(":scope > [data-sd-text-content]") || el;
    const paragraphs = [], positions = new WeakMap();
    let current = { ...paragraphStyle(el, scale), runs: [], pieces: [], node: el };
    const nonempty = () => current.runs.some(r => r.text.length);
    function flush(force = false) {
      if (force || nonempty()) {
        if (!current.runs.length) current.runs.push({ text: "", ...runStyle(current.node, scale, el) });
        paragraphs.push(current);
      }
      current = { ...paragraphStyle(current.node, scale), runs: [], pieces: [], node: current.node };
    }
    function text(node) {
      const raw = node.nodeValue || "", style = runStyle(node.parentElement, scale, el);
      const pre = /pre|break-spaces/.test(getComputedStyle(node.parentElement).whiteSpace);
      let content = pre ? raw : raw.replace(/[ \t\r\n\f]+/g, " ");
      if (!pre && current.runs.at(-1)?.text.endsWith(" ")) content = content.replace(/^ /, "");
      if (!content || (!pre && /^[ \t\r\n\f]*$/.test(content) && !nonempty())) return;
      let rawOffset = 0;
      const parts = current.node.hasAttribute("data-sd-paragraph") ? [content] : content.split("\n");
      for (const [i, part] of parts.entries()) {
        if (i) flush(true);
        const offset = current.runs.reduce((sum, run) => sum + run.text.length, 0);
        if (part) current.runs.push({ text: part, ...style });
        current.pieces.push({ node, rawStart: rawOffset, rawEnd: rawOffset + part.length, offset });
        rawOffset += part.length + 1;
      }
    }
    function walk(node) {
      if (node.nodeType === 3) { text(node); return; }
      if (node.nodeType !== 1 || node.hasAttribute("data-sd-marker") || ["SCRIPT", "STYLE"].includes(node.tagName)) return;
      if (node.tagName === "BR") { flush(true); return; }
      const block = node.hasAttribute("data-sd-paragraph") || blocks.has(node.tagName);
      if (block) {
        flush();
        current = { ...paragraphStyle(node, scale), runs: [], pieces: [], node };
      }
      const children = [...node.childNodes].filter(child => !(child.nodeType === 1 && child.hasAttribute("data-sd-marker")));
      if (!(children.length === 1 && children[0].nodeName === "BR")) children.forEach(walk);
      if (block) flush(true);
    }
    [...container.childNodes].forEach(walk);
    flush(!paragraphs.length);
    let base = 0;
    for (const p of paragraphs) {
      const length = p.runs.reduce((sum, r) => sum + r.text.length, 0);
      if (!positions.has(p.node)) positions.set(p.node, { start: base, end: base + length });
      for (const piece of p.pieces) {
        const list = positions.get(piece.node) || [];
        list.push({ ...piece, start: base + piece.offset, end: base + piece.offset + piece.rawEnd - piece.rawStart });
        positions.set(piece.node, list);
      }
      base += length + 1;
    }
    const rich = T.normalizeRichText({ paragraphs: paragraphs.map(({ pieces, node, ...p }) => p) });
    return { rich, positions, length: T.plainText(rich).length };
  }
  function read(el) { return scan(el).rich; }
  function model(el) {
    if (!el.isContentEditable && el.dataset.sdRichText) {
      try { return T.normalizeRichText(JSON.parse(el.dataset.sdRichText)); } catch { /* Read current DOM if an old marker is invalid. */ }
    }
    return read(el);
  }
  function box(el) {
    try { return T.normalizeTextBox(JSON.parse(el.dataset.sdTextBox || "{}")); } catch { return {}; }
  }
  function resolve(el) {
    if (el.isContentEditable || !el.dataset.sdRichText) return read(el);
    const rich = model(el), scale = Number(el.dataset.sdFontScale) || 1;
    const nodes = [...el.querySelectorAll("[data-sd-paragraph]")];
    return T.normalizeRichText({ paragraphs: rich.paragraphs.map((paragraph, i) => {
      const node = nodes[i]; if (!node) return paragraph;
      const runs = [...node.querySelectorAll("[data-sd-run]")];
      return { ...paragraph, ...paragraphStyle(node, scale), runs: paragraph.runs.map((run, j) =>
        runs[j] ? { ...run, ...runStyle(runs[j], scale, el), text: run.text } : run) };
    }) });
  }
  function offsetAt(root, node, offset, data) {
    const point = data.positions.get(node);
    if (node.nodeType === 3 && Array.isArray(point)) {
      const piece = point.find(p => offset >= p.rawStart && offset <= p.rawEnd) || point.at(-1);
      return piece ? clamp(piece.start + offset - piece.rawStart, piece.start, piece.end) : 0;
    }
    if (node.nodeType === 1) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const nodes = []; while (walker.nextNode()) if (data.positions.has(walker.currentNode)) nodes.push(walker.currentNode);
      const after = [...node.childNodes].slice(offset);
      for (const child of after) {
        const first = nodes.find(text => child === text || child.contains?.(text));
        if (first) return data.positions.get(first)[0].start;
        const p = data.positions.get(child); if (p && !Array.isArray(p)) return p.start;
      }
      if (nodes.length) return data.positions.get(nodes.at(-1)).at(-1).end;
      if (point && !Array.isArray(point)) return point.start;
      if (node === root) return offset ? data.length : 0;
    }
    return data.length;
  }
  function capture(el) {
    const selection = getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
    const data = scan(el);
    return { start: offsetAt(el, range.startContainer, range.startOffset, data), end: offsetAt(el, range.endContainer, range.endOffset, data) };
  }
  function restore(el, offsets) {
    if (!offsets) return;
    const data = scan(el), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), entries = [];
    while (walker.nextNode()) {
      const points = data.positions.get(walker.currentNode);
      if (Array.isArray(points)) for (const point of points) entries.push({ ...point, node: walker.currentNode });
    }
    const locate = value => {
      const empty = [...el.querySelectorAll("[data-sd-paragraph]")].find(node => {
        const p = data.positions.get(node); return p && p.start === p.end && p.start === value;
      });
      if (empty) return [empty.querySelector("[data-sd-run]") || empty, 0];
      const point = entries.find(p => value >= p.start && value <= p.end) || entries.find(p => p.start > value) || entries.at(-1);
      if (!point) return [el, 0];
      return [point.node, clamp(point.rawStart + value - point.start, point.rawStart, point.rawEnd)];
    };
    const range = document.createRange(); range.setStart(...locate(offsets.start)); range.setEnd(...locate(offsets.end));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  function styleAt(rich, range) {
    const offset = range?.start || 0;
    let base = 0;
    for (const paragraph of rich.paragraphs) {
      let cursor = base;
      for (const run of paragraph.runs) {
        if (offset < cursor + run.text.length || (offset === cursor + run.text.length && (range?.start === range?.end || !run.text.length))) return { ...paragraph, ...run };
        cursor += run.text.length;
      }
      base = cursor + 1;
    }
    const p = rich.paragraphs.at(-1); return { ...p, ...p.runs.at(-1) };
  }
  function fit(el, rich = model(el), options = box(el)) {
    const content = el.querySelector(":scope > [data-sd-text-content]");
    if (!content || el.isContentEditable) return;
    const pNodes = [...content.children].filter(n => n.hasAttribute("data-sd-paragraph"));
    const rootStyle = getComputedStyle(el), rootSize = parseFloat(rootStyle.fontSize) || 16;
    const width = el.clientWidth - (parseFloat(rootStyle.paddingLeft) || 0) - (parseFloat(rootStyle.paddingRight) || 0);
    const height = el.clientHeight - (parseFloat(rootStyle.paddingTop) || 0) - (parseFloat(rootStyle.paddingBottom) || 0);
    const setScale = scale => {
      el.dataset.sdFontScale = String(scale);
      rich.paragraphs.forEach((p, i) => {
        const node = pNodes[i]; if (!node) return;
        const firstSize = p.runs[0]?.fontSize || rootSize;
        node.style.fontSize = firstSize * scale + "px";
        node.style.marginBottom = (p.spaceAfter || 0) * scale + "px";
        node.style.paddingLeft = ((p.indent || 0) * 32 + (p.list && p.list !== "none" ? 24 : 0)) * scale + "px";
        [...node.querySelectorAll("[data-sd-run]")].forEach((run, j) => { run.style.fontSize = (p.runs[j]?.fontSize || rootSize) * scale + "px"; });
        const marker = node.querySelector("[data-sd-marker]");
        if (marker) { marker.style.left = (p.indent || 0) * 32 * scale + "px"; marker.style.width = 24 * scale + "px"; }
      });
    };
    const overflows = () => content.scrollWidth > width + 1 || content.offsetHeight > height + 1;
    setScale(1);
    if (options.autoFit === "shrink" && width > 0 && height > 0 && overflows()) {
      const sizes = rich.paragraphs.flatMap(p => p.runs.map(r => r.fontSize || rootSize));
      let lo = Math.min(1, 6 / Math.min(...sizes)), hi = 1;
      setScale(lo);
      if (!overflows()) {
        for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; setScale(mid); if (overflows()) hi = mid; else lo = mid; }
      }
      setScale(lo);
    }
    el.dataset.sdTextOverflowing = String(overflows());
  }
  function render(el, rich, options = box(el)) {
    T.renderRichText(el, rich, options);
    el.dataset.sdFontScale = "1";
    fit(el, rich, options);
  }
  function replaceText(rich, text) {
    text = text.replace(/\r\n?/g, "\n");
    const old = T.plainText(rich);
    let prefix = 0, suffix = 0;
    while (prefix < old.length && prefix < text.length && old[prefix] === text[prefix]) prefix++;
    while (suffix < old.length - prefix && suffix < text.length - prefix && old[old.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
    let newOffset = 0;
    const paragraphs = text.split("\n").map((line, i) => {
      const base = rich.paragraphs[Math.min(i, rich.paragraphs.length - 1)], runs = [];
      let lastStyle;
      for (const char of line) {
        const at = newOffset < prefix ? newOffset : newOffset >= text.length - suffix ? old.length - (text.length - newOffset) : prefix;
        const { runs: ignored, align, lineHeight, spaceAfter, indent, list, text: ignoredText, ...style } = styleAt(rich, { start: at });
        const key = JSON.stringify(style);
        if (key === lastStyle) runs[runs.length - 1].text += char;
        else { runs.push({ text: char, ...style }); lastStyle = key; }
        newOffset += char.length;
      }
      if (!runs.length) runs.push({ ...base.runs[0], text: "" });
      newOffset++;
      return { ...base, runs };
    });
    return T.normalizeRichText({ paragraphs });
  }
  globalThis.SDTextEditor = { eligible, read, model, box, resolve, capture, restore, styleAt, fit, render, replaceText };
})();
