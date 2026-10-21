(() => {
  "use strict";
  const config = JSON.parse(
    document.getElementById("sd-config")?.textContent || "{}",
  );
  const edit = config.edit === true;
  const slides = [...document.querySelectorAll("[data-sd-slide]")];
  let current = 0,
    selected = null,
    selection = [],
    drag = null,
    nudge = null,
    lockAspect = false,
    textEdit = null,
    composing = false;
  const patches = config.state?.patches || {};
  const added = new Map((config.state?.added || []).map((a) => [a.id, a]));
  const effective = (id) => ({ ...(added.get(id) || {}), ...(patches[id] || {}) });
  const Text = globalThis.SDText, TextEditor = globalThis.SDTextEditor, Objects = globalThis.SDObjects;
  const textRanges = new WeakMap();
  const pendingTextCommands = [];
  const displays = new Map();
  const editRequests = new Set();
  const activeTarget = (target) => {
    const e = target instanceof Element ? target.closest("[data-sd-id]") : null;
    return e && slides[current]?.contains(e) ? e : null;
  };
  const formTarget = (target) => target instanceof Element && target.closest("input,textarea,select,button");
  const tell = (type, data = {}) => {
    if (window.parent !== window)
      parent.postMessage({ studio: true, type, editorSession: new URLSearchParams(location.search).get("editorSession"), ...data }, config.managerOrigin);
  };
  const scale = () =>
    slides[current]?.getBoundingClientRect().width / 1920 || 1;
  const style = document.createElement("style");
  style.textContent = edit
    ? "[data-sd-id]{cursor:move}.sd-selected{outline:3px solid #4cddc9!important;outline-offset:5px}#hud,#help,#progress{display:none!important}[contenteditable=true]{cursor:text}.sd-selected img{pointer-events:none}"
    : "";
  document.head.append(style);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const round = (v) => Math.round(v * 100) / 100;
  const handles = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], rotate: [0, -1] };
  let overlay, marquee;
  if (edit) {
    style.textContent += `
      html,body{overflow:hidden!important}
      #sd-selection-overlay{position:fixed;box-sizing:border-box;border:1px solid #159b88;pointer-events:none;z-index:2147483647;transform-origin:center}
      #sd-selection-overlay[hidden]{display:none!important}
      #sd-selection-overlay button{position:absolute;display:block;box-sizing:border-box;width:12px;height:12px;min-width:0;min-height:0;margin:0;padding:0;background:#fff;border:2px solid #159b88;border-radius:2px;transform:translate(-50%,-50%);pointer-events:auto;touch-action:none}
      #sd-selection-overlay button[data-sd-handle=rotate]{border-radius:50%;background:#4cddc9;cursor:grab}
      [data-sd-id]{touch-action:none}[contenteditable=true]{touch-action:auto}
      #sd-marquee{position:fixed;border:1px solid #159b88;background:#4cddc925;pointer-events:none;z-index:2147483646}
      #sd-marquee[hidden]{display:none!important}
    `;
    overlay = document.createElement("div");
    overlay.id = "sd-selection-overlay";
    overlay.hidden = true;
    for (const [name, [x, y]] of Object.entries(handles)) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.sdHandle = name;
      button.setAttribute("aria-label", name === "rotate" ? "회전" : `${name} 크기 조절`);
      button.style.left = `${(x + 1) * 50}%`;
      button.style.top = name === "rotate" ? "-28px" : `${(y + 1) * 50}%`;
      button.style.cursor = name === "rotate" ? "grab" : `${name}-resize`;
      overlay.append(button);
    }
    document.body.append(overlay);
    marquee = document.createElement("div");
    marquee.id = "sd-marquee";
    marquee.hidden = true;
    document.body.append(marquee);
  }
  function geometry(e) {
    const c = getComputedStyle(e), r = e.getBoundingClientRect();
    const edges = (a, b) => parseFloat(c[a]) + parseFloat(c[b]);
    const extraW = c.boxSizing === "border-box" ? 0 : edges("paddingLeft", "paddingRight") + edges("borderLeftWidth", "borderRightWidth");
    const extraH = c.boxSizing === "border-box" ? 0 : edges("paddingTop", "paddingBottom") + edges("borderTopWidth", "borderBottomWidth");
    const w = parseFloat(c.width) || e.offsetWidth, h = parseFloat(c.height) || e.offsetHeight;
    const rotation = c.rotate === "none" ? "0deg" : c.rotate.replace(/^z\s+/, "");
    const match = /^(-?[\d.]+)(deg|rad|turn)$/.exec(rotation);
    const angle = match ? Number(match[1]) * (match[2] === "rad" ? 180 / Math.PI : match[2] === "turn" ? 360 : 1) : 0;
    let reason = "";
    if (!match || c.transform !== "none" || c.scale !== "none" || (c.display === "inline" && e.tagName !== "IMG"))
      reason = "CSS 변환 또는 인라인 개체는 정밀 핸들을 지원하지 않습니다. HTML/CSS에서 조정해 주세요.";
    if ([c.minWidth, c.minHeight].some(v => !["0px", "auto"].includes(v)) || c.maxWidth !== "none" || c.maxHeight !== "none")
      reason = "CSS 최소·최대 크기 제약이 있어 정밀 핸들을 사용할 수 없습니다. HTML/CSS에서 조정해 주세요.";
    for (let parent = e.parentElement; parent && parent.id !== "stage"; parent = parent.parentElement) {
      const p = getComputedStyle(parent);
      if (p.transform !== "none" || p.rotate !== "none" || p.scale !== "none")
        reason = "상위 CSS 변환이 있어 정밀 핸들을 사용할 수 없습니다. HTML/CSS에서 조정해 주세요.";
    }
    return { w, h, extraW, extraH, bw: w + extraW, bh: h + extraH, angle, cx: r.x + r.width / 2, cy: r.y + r.height / 2, reason };
  }
  function updateOverlay() {
    if (!overlay) return;
    if (!selected || textEdit || !selected.isConnected || selection.some(e => locked(e) || !visible(e))) { overlay.hidden = true; return; }
    for (const button of overlay.children) button.style.display = selection.length > 1 ? "none" : "block";
    if (selection.length > 1) {
      const b = bounds(selection);
      overlay.hidden = false;
      Object.assign(overlay.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.right - b.left}px`, height: `${b.bottom - b.top}px`, transform: "none" });
      return;
    }
    const g = geometry(selected);
    overlay.hidden = !!g.reason;
    if (overlay.hidden) return;
    Object.assign(overlay.style, { left: `${g.cx}px`, top: `${g.cy}px`, width: `${g.bw * scale()}px`, height: `${g.bh * scale()}px`, transform: `translate(-50%,-50%) rotate(${g.angle}deg)` });
  }
  function go(n) {
    if (!Number.isInteger(n)) return;
    const next = Math.max(0, Math.min(slides.length - 1, n));
    if (next !== current) {
      finishDrag(false);
      finishText();
      select(null);
    }
    current = next;
    if (typeof window.goSlide === "function") window.goSlide(current);
    else {
      slides.forEach((s, i) => s.classList.toggle("active", i === current));
      document.body.dataset.scene = slides[current]?.dataset.scene || "dim";
      window.setScene?.(document.body.dataset.scene);
      const stage = document.getElementById("stage");
      if (stage) {
        stage.style.transform = `scale(${innerWidth / 1920})`;
      }
    }
    Objects.refresh(slides[current]);
    for (const el of slides[current]?.querySelectorAll('[data-sd-rich="true"]') || []) TextEditor.fit(el);
    tell("navigate", { index: current });
    report();
  }
  const hex = (c) => {
    const a = c.match(/[\d.]+/g);
    return a && a.length >= 3
      ? "#" +
          a
            .slice(0, 3)
            .map((n) => Math.round(Number(n)).toString(16).padStart(2, "0"))
            .join("")
      : "#ffffff";
  };
  const locked = (e) => {
    for (let node = e; node && node !== slides[current]; node = node.parentElement)
      if (node.dataset.sdId && effective(node.dataset.sdId).locked) return true;
    return false;
  };
  const visible = (e) => {
    const c = getComputedStyle(e), r = e.getBoundingClientRect();
    return !effective(e.dataset.sdId).hidden && c.display !== "none" && c.visibility !== "hidden" && r.width > 0 && r.height > 0 && !e.closest(".notes");
  };
  const editableElements = () => [...(slides[current]?.querySelectorAll("[data-sd-id]") || [])];
  const nativeKinds = new Set(["text", "image", "shape", "group"]);
  const nativeAdded = e => nativeKinds.has(added.get(e.dataset.sdId)?.kind);
  const groupable = e => nativeAdded(e) && !locked(e) && visible(e) && !geometry(e).reason && e.parentElement === slides[current];
  const paintOrder = elements => elements.map((el, index) => ({ el, index, z: parseInt(getComputedStyle(el).zIndex) || 0 }))
    .sort((a, b) => a.z - b.z || a.index - b.index).map(item => item.el);
  function bounds(elements) {
    const rects = elements.map(e => e.getBoundingClientRect());
    return { left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)), top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) };
  }
  const groups = new WeakMap();
  let groupNumber = 0;
  function reportLayers() {
    if (!edit) return;
    tell("layers", { slide: slides[current]?.dataset.sdSlide, items: editableElements().map(e => {
      if (!groups.has(e.parentElement)) groups.set(e.parentElement, "g" + groupNumber++);
      return { id: e.dataset.sdId, tag: e.tagName.toLowerCase(), label: (e.innerText || e.getAttribute("alt") || e.dataset.sdKind || e.tagName).slice(0, 70), locked: locked(e), hidden: !visible(e), z: parseInt(getComputedStyle(e).zIndex) || 0, position: getComputedStyle(e).position, group: groups.get(e.parentElement), layerable: !geometry(e).reason, selected: selection.includes(e) };
    }) });
  }
  function elementInfo(e) {
    const
      g = geometry(e),
      c = getComputedStyle(e),
      p = effective(e.dataset.sdId);
    let textInfo = { textEditable: false };
    if (TextEditor.eligible(e)) {
      try {
        const rich = TextEditor.resolve(e), range = textRanges.get(e) || null;
        textInfo = { textEditable: true, textEditing: textEdit?.el === e, textStyle: TextEditor.styleAt(rich, range), textBox: TextEditor.box(e), textRange: range, textOverflowing: e.dataset.sdTextOverflowing === "true" };
      } catch { /* Unsupported original text remains editable through HTML/CSS. */ }
    }
    return {
        id: e.dataset.sdId,
        tag: p.kind === "image" ? "img" : e.tagName.toLowerCase(),
        kind: p.kind || (e.tagName === "IMG" ? "image" : "html"),
        groupable: groupable(e),
        ...(p.kind === "image" ? { image: Objects.normalizeImage(p.image || {}) } : {}),
        ...(p.kind === "shape" ? { shape: Objects.normalizeShape(p.shape || {}, p.fill) } : {}),
        ...(p.kind === "group" ? { group: { width: p.group.width, height: p.group.height, count: p.group.children.length } } : {}),
        text: textInfo.textEditable ? Text.plainText(TextEditor.model(e)) : e.innerText || "",
        src: p.src || e.getAttribute("src"),
        x: p.x ?? 0,
        y: p.y ?? 0,
        w: round(g.w),
        h: round(g.h),
        rotate: round(g.angle),
        extraW: g.extraW,
        extraH: g.extraH,
        precisionReason: g.reason,
        locked: locked(e),
        fontSize: p.fontSize || parseFloat(c.fontSize),
        color: hex(c.color),
        fill: hex(c.backgroundColor),
        ...textInfo,
      };
  }
  function report() {
    updateOverlay();
    const elements = selection.map(elementInfo);
    tell("select", { element: elements.length === 1 ? elements[0] : null, elements });
    reportLayers();
  }
  function select(e) {
    setSelection(e ? [e] : []);
  }
  function setSelection(elements) {
    const candidates = [...new Set(elements)].filter(e => e?.isConnected && slides[current]?.contains(e));
    const next = candidates.filter(e => !candidates.some(other => other !== e && other.contains(e)));
    if (next.length !== selection.length || next.some((e, i) => e !== selection[i])) {
      finishNudge(true);
      lockAspect = false;
      if (textEdit && (next.length !== 1 || textEdit.el !== next[0])) finishText();
      for (const e of selection) textRanges.delete(e);
    }
    for (const e of selection) e.classList.remove("sd-selected");
    selection = next;
    selected = selection.at(-1) || null;
    for (const e of selection) e.classList.add("sd-selected");
    report();
  }
  function patch(id, p) {
    const e = document.querySelector(`[data-sd-id="${CSS.escape(id)}"]`);
    if (!e) return;
    patches[id] = { ...(patches[id] || {}), ...p };
    const q = effective(id);
    if (p.text !== undefined) e.textContent = p.text;
    if (p.src) e.setAttribute("src", p.src);
    if (p.x !== undefined || p.y !== undefined)
      e.style.translate = `${q.x || 0}px ${q.y || 0}px`;
    if (p.w) e.style.width = p.w + "px";
    if (p.h) e.style.height = p.h + "px";
    if (p.rotate !== undefined) e.style.rotate = p.rotate + "deg";
    if (p.fontSize) e.style.fontSize = p.fontSize + "px";
    if (p.color) {
      e.style.color = p.color;
      e.style.webkitTextFillColor = p.color;
    }
    if (p.fill) e.style.background = p.fill;
    if (p.z !== undefined) e.style.zIndex = String(p.z);
    if (p.layerPosition === "relative") {
      e.style.position = "relative";
      for (const key of ["inset", "top", "left", "right", "bottom"]) e.style[key] = "auto";
    }
    if (p.hidden !== undefined) {
      if (p.hidden) {
        if (!displays.has(id)) displays.set(id, e.style.display === "none" ? "" : e.style.display);
        e.style.display = "none";
      } else e.style.display = displays.get(id) || "";
    }
    if (p.richText) TextEditor.render(e, p.richText, q.textBox || TextEditor.box(e));
    else if (p.textBox) {
      const rich = q.richText || TextEditor.model(e);
      TextEditor.render(e, rich, p.textBox);
    } else if ((p.w || p.h) && e.dataset.sdRich === "true") TextEditor.fit(e);
    if (["image", "shape", "group"].includes(q.kind) && Object.keys(p).some(key => ["src", "image", "shape", "group", "w", "h", "fill"].includes(key))) {
      Objects.applyVisual(e, q);
      Objects.refresh(e);
    }
  }
  function finishText() {
    if (!textEdit) return;
    if (composing) {
      textEdit.pending = true;
      return;
    }
    const { el, before, baseline } = textEdit;
    const range = TextEditor.capture(el);
    if (range) textRanges.set(el, range);
    let rich;
    try { rich = TextEditor.read(el); }
    catch (error) { tell("notice", { message: error.message }); return; }
    const changed = JSON.stringify(rich) !== baseline;
    if (!changed) rich = before;
    textEdit = null;
    const text = Text.plainText(rich);
    el.contentEditable = "false";
    TextEditor.render(el, rich, effective(el.dataset.sdId).textBox || TextEditor.box(el));
    if (changed) {
      const value = { text, richText: rich };
      patches[el.dataset.sdId] = { ...(patches[el.dataset.sdId] || {}), ...value };
      tell("change", { id: el.dataset.sdId, patch: value });
    }
    report();
  }
  function beginText(el) {
    if (!TextEditor.eligible(el) || locked(el)) return;
    const rich = TextEditor.model(el);
    TextEditor.render(el, rich, effective(el.dataset.sdId).textBox || TextEditor.box(el));
    textEdit = { el, before: rich, pending: false, baseline: null, nativeUndoDepth: 0, nativeAtBoundary: true, programmatic: false };
    el.contentEditable = "true"; el.focus();
    const end = Text.plainText(rich).length;
    TextEditor.restore(el, textRanges.get(el) || { start: end, end });
    // Read the rendered DOM: inherited styles and autofit can differ from the
    // saved model without representing an actual native editing operation.
    textEdit.baseline = JSON.stringify(TextEditor.read(el));
    updateOverlay(); report();
  }
  function textCommand(d) {
    if (composing) { pendingTextCommands.push(d); return; }
    let failure;
    try {
      const target = selection.length === 1 && selected?.dataset.sdId === d.id ? selected : null;
      if (!target || locked(target) || !TextEditor.eligible(target)) return;
      if (textEdit) finishText();
      const before = TextEditor.model(target), range = textRanges.get(target);
      let rich = before, options = TextEditor.box(target);
      if (d.type === "text-replace") {
        if (typeof d.text !== "string" || d.text.length > 100000) throw new Error("텍스트는 100,000자 이내로 입력해 주세요.");
        rich = TextEditor.replaceText(before, d.text); textRanges.delete(target);
      } else if (d.scope === "box") options = Text.normalizeTextBox({ ...options, ...d.changes });
      else if (["character", "paragraph"].includes(d.scope)) rich = Text.formatRichText(before, range && (d.scope === "paragraph" || range.end > range.start) ? range : null, d.scope, d.changes);
      else return;
      if (JSON.stringify(rich) === JSON.stringify(before) && JSON.stringify(options) === JSON.stringify(TextEditor.box(target))) return;
      const value = { richText: rich, text: Text.plainText(rich), ...(d.scope === "box" ? { textBox: options } : {}) };
      // Preserve legacy inspector values when a whole-object size/color command is used.
      if (d.scope === "character" && (!range || range.start === range.end)) {
        if (d.changes.fontSize) value.fontSize = d.changes.fontSize;
        if (d.changes.color) value.color = d.changes.color;
      }
      patch(d.id, value); tell("change", { id: d.id, patch: value }); report();
    } catch (error) { failure = error.message; tell("notice", { message: failure }); }
    finally {
      if (typeof d.requestId === "string" && d.requestId.length < 200) tell("text-command-result", { requestId: d.requestId, ...(failure ? { error: failure } : {}) });
    }
  }
  function finishDrag(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === "marquee") {
      marquee.hidden = true;
      if (commit && Math.abs(d.dx) + Math.abs(d.dy) > 2) {
        const left = Math.min(d.startX, d.startX + d.dx), right = Math.max(d.startX, d.startX + d.dx);
        const top = Math.min(d.startY, d.startY + d.dy), bottom = Math.max(d.startY, d.startY + d.dy);
        setSelection([...d.selection, ...editableElements().filter(e => {
          if (locked(e) || !visible(e)) return false;
          const r = e.getBoundingClientRect();
          return r.left >= left && r.right <= right && r.top >= top && r.bottom <= bottom;
        })]);
      } else if (!commit) setSelection(d.originalSelection);
      if (d.capture.hasPointerCapture(d.pointerId)) d.capture.releasePointerCapture(d.pointerId);
      return;
    }
    if (d.items) {
      if (commit && Math.abs(d.dx) + Math.abs(d.dy) > 2) commitMovement(d.items);
      else restoreMovement(d.items);
      if (d.capture.hasPointerCapture(d.pointerId)) d.capture.releasePointerCapture(d.pointerId);
      report();
      return;
    }
    if (commit && Math.abs(d.dx) + Math.abs(d.dy) > 2) {
      if (d.pending && Object.entries(d.pending).some(([key, value]) => value !== d.base[key]))
        tell("change", { id: d.id, patch: d.pending });
    } else {
      if (d.before === undefined) delete patches[d.id];
      else patches[d.id] = d.before;
      d.el.style.cssText = d.cssText;
      if (["image", "shape", "group"].includes(effective(d.id).kind)) {
        Objects.applyVisual(d.el, effective(d.id));
        Objects.refresh(d.el);
      }
    }
    if (d.capture.hasPointerCapture(d.pointerId)) d.capture.releasePointerCapture(d.pointerId);
    report();
  }
  function finishNudge(commit) {
    if (!nudge) return;
    const n = nudge;
    nudge = null;
    if (n.items) {
      if (commit) commitMovement(n.items); else restoreMovement(n.items);
      report();
      return;
    }
    const p = effective(n.id);
    if (commit) {
      if (p.x !== n.x || p.y !== n.y) tell("change", { id: n.id, patch: { x: p.x, y: p.y } });
    } else {
      if (n.before === undefined) delete patches[n.id]; else patches[n.id] = n.before;
      n.el.style.cssText = n.cssText;
    }
    report();
  }
  function movementItems() {
    return selection.map(el => {
      const id = el.dataset.sdId, p = effective(id);
      return { id, el, x: p.x ?? 0, y: p.y ?? 0, before: patches[id] && { ...patches[id] }, cssText: el.style.cssText };
    });
  }
  function restoreMovement(items) {
    for (const item of items) {
      if (item.before === undefined) delete patches[item.id]; else patches[item.id] = item.before;
      item.el.style.cssText = item.cssText;
    }
  }
  function emitChanges(changes, batch = changes.length > 1) {
    if (!changes.length) return;
    if (batch) tell("batch-change", { slide: slides[current]?.dataset.sdSlide, changes });
    else tell("change", changes[0]);
  }
  function commitMovement(items) {
    const changes = items.flatMap(item => {
      const p = effective(item.id);
      return p.x !== item.x || p.y !== item.y ? [{ id: item.id, patch: { x: p.x, y: p.y } }] : [];
    });
    emitChanges(changes, items.length > 1);
  }
  function moveItems(items, dx, dy) {
    dx = clamp(dx, Math.max(...items.map(i => -5000 - i.x)), Math.min(...items.map(i => 5000 - i.x)));
    dy = clamp(dy, Math.max(...items.map(i => -5000 - i.y)), Math.min(...items.map(i => 5000 - i.y)));
    for (const item of items) patch(item.id, { x: round(item.x + dx), y: round(item.y + dy) });
    updateOverlay();
  }
  function transformDrag(e) {
    const d = drag, g = d.geometry, ss = d.scale;
    if (d.kind === "marquee") {
      d.dx = e.clientX - d.startX; d.dy = e.clientY - d.startY;
      Object.assign(marquee.style, { left: `${Math.min(d.startX, e.clientX)}px`, top: `${Math.min(d.startY, e.clientY)}px`, width: `${Math.abs(d.dx)}px`, height: `${Math.abs(d.dy)}px` });
      marquee.hidden = false;
      return;
    }
    const dx = (e.clientX - d.startX) / ss, dy = (e.clientY - d.startY) / ss;
    d.dx = dx; d.dy = dy;
    if (d.items) { moveItems(d.items, Math.round(dx), Math.round(dy)); return; }
    let p;
    if (d.kind === "move") p = { x: clamp(Math.round(d.x + dx), -5000, 5000), y: clamp(Math.round(d.y + dy), -5000, 5000) };
    else {
      let cx = g.cx, cy = g.cy;
      if (d.kind === "rotate") {
        const start = Math.atan2(d.startY - g.cy, d.startX - g.cx);
        const now = Math.atan2(e.clientY - g.cy, e.clientX - g.cx);
        let angle = g.angle + (now - start) * 180 / Math.PI;
        if (e.shiftKey) angle = Math.round(angle / 15) * 15;
        p = { rotate: round(((angle + 180) % 360 + 360) % 360 - 180) };
      } else {
        const [hx, hy] = handles[d.kind], radians = g.angle * Math.PI / 180;
        const cos = Math.cos(radians), sin = Math.sin(radians);
        const localX = dx * cos + dy * sin, localY = -dx * sin + dy * cos, factor = e.altKey ? 2 : 1;
        let bw = g.bw + hx * localX * factor, bh = g.bh + hy * localY * factor;
        if (lockAspect || e.shiftKey || effective(d.id).kind === "group") {
          let ratio = hx && hy ? (Math.abs(bw / g.bw - 1) >= Math.abs(bh / g.bh - 1) ? bw / g.bw : bh / g.bh) : hx ? bw / g.bw : bh / g.bh;
          ratio = clamp(ratio, Math.max((1 + g.extraW) / g.bw, (1 + g.extraH) / g.bh), Math.min((5000 + g.extraW) / g.bw, (5000 + g.extraH) / g.bh));
          bw = g.bw * ratio; bh = g.bh * ratio;
        }
        p = { w: round(clamp(bw - g.extraW, 1, 5000)), h: round(clamp(bh - g.extraH, 1, 5000)) };
        if (!e.altKey) {
          const shiftX = hx * (p.w - g.w) / 2, shiftY = hy * (p.h - g.h) / 2;
          cx += (shiftX * cos - shiftY * sin) * ss;
          cy += (shiftX * sin + shiftY * cos) * ss;
        }
      }
      // Measure after sizing so CSS layout and noncentral transform origins are accounted for.
      patch(d.id, { ...p, x: d.x, y: d.y });
      const actual = geometry(d.el);
      p.x = round(clamp(d.x + (cx - actual.cx) / ss, -5000, 5000));
      p.y = round(clamp(d.y + (cy - actual.cy) / ss, -5000, 5000));
    }
    d.pending = p;
    patch(d.id, p);
    updateOverlay();
  }
  function settleEdits() {
    if (composing) return;
    finishDrag(false);
    finishNudge(true);
    finishText();
    while (pendingTextCommands.length) textCommand(pendingTextCommands.shift());
    for (const requestId of editRequests) tell("edit-settled", { requestId });
    editRequests.clear();
  }
  function applyChanges(changes, operation) {
    const actual = changes.filter(({ id, patch: p }) => Object.entries(p).some(([key, value]) => effective(id)[key] !== value));
    for (const { id, patch: p } of actual) patch(id, p);
    if (operation === "delete" && actual.length) tell("batch-change", { changes: actual, operation, slide: slides[current].dataset.sdSlide });
    else emitChanges(actual, changes.length > 1);
    report();
  }
  function layerOrder(name) {
    if (!selection.length || selection.some(locked)) return;
    const parent = selection[0].parentElement;
    if (selection.some(e => e.parentElement !== parent || geometry(e).reason))
      throw new Error("같은 컨테이너의 개체끼리 레이어 순서를 변경할 수 있습니다.");
    const siblings = editableElements().filter(e => e.parentElement === parent);
    const order = siblings.map((el, index) => ({ el, index, z: parseInt(getComputedStyle(el).zIndex) || 0 }))
      .sort((a, b) => a.z - b.z || a.index - b.index).map(item => item.el);
    let next = [...order];
    if (name === "front") next = [...order.filter(e => !selection.includes(e)), ...order.filter(e => selection.includes(e))];
    if (name === "back") next = [...order.filter(e => selection.includes(e)), ...order.filter(e => !selection.includes(e))];
    if (name === "forward") for (let i = next.length - 2; i >= 0; i--) {
      if (selection.includes(next[i]) && !selection.includes(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]];
    }
    if (name === "backward") for (let i = 1; i < next.length; i++) {
      if (selection.includes(next[i]) && !selection.includes(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]];
    }
    if (next.every((e, i) => e === order[i])) return;
    applyChanges(next.map((e, i) => ({ id: e.dataset.sdId, patch: { z: i + 1, ...(getComputedStyle(e).position === "static" ? { layerPosition: "relative" } : {}) } })));
  }
  function arrange(name) {
    if (selection.length < (name.startsWith("distribute") ? 3 : 2)) return;
    if (selection.some(e => locked(e) || !visible(e) || geometry(e).reason))
      throw new Error("잠금·숨김 또는 지원하지 않는 CSS 변환 개체는 함께 정렬할 수 없습니다.");
    const ss = scale(), b = bounds(selection);
    const entries = selection.map(el => ({ el, r: el.getBoundingClientRect(), p: effective(el.dataset.sdId), dx: 0, dy: 0 }));
    if (name.startsWith("align-")) for (const item of entries) {
      const r = item.r;
      if (name === "align-left") item.dx = b.left - r.left;
      if (name === "align-center") item.dx = (b.left + b.right - r.left - r.right) / 2;
      if (name === "align-right") item.dx = b.right - r.right;
      if (name === "align-top") item.dy = b.top - r.top;
      if (name === "align-middle") item.dy = (b.top + b.bottom - r.top - r.bottom) / 2;
      if (name === "align-bottom") item.dy = b.bottom - r.bottom;
    } else {
      const horizontal = name === "distribute-x", edge = horizontal ? "left" : "top", size = horizontal ? "width" : "height", end = horizontal ? "right" : "bottom";
      entries.sort((a, b) => a.r[edge] - b.r[edge]);
      const gap = (entries.at(-1).r[end] - entries[0].r[edge] - entries.reduce((sum, item) => sum + item.r[size], 0)) / (entries.length - 1);
      let cursor = entries[0].r[edge];
      for (const item of entries) { item[horizontal ? "dx" : "dy"] = cursor - item.r[edge]; cursor += item.r[size] + gap; }
    }
    const changes = entries.map(item => ({ id: item.el.dataset.sdId, patch: { x: round((item.p.x ?? 0) + item.dx / ss), y: round((item.p.y ?? 0) + item.dy / ss) } }));
    if (changes.some(({ patch: p }) => Math.abs(p.x) > 5000 || Math.abs(p.y) > 5000)) throw new Error("정렬 결과가 편집 좌표 범위를 벗어납니다.");
    applyChanges(changes);
  }
  function localAssetURL(raw) {
    const base = new URL(".", location.href), url = new URL(raw, location.href);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash)
      throw new Error("외부 자산을 사용하는 개체는 복제할 수 없습니다.");
    return decodeURIComponent(url.pathname.slice(base.pathname.length));
  }
  function objectBox(source) {
    const g = geometry(source), slide = slides[current].getBoundingClientRect(), ss = scale();
    if (g.reason) throw new Error("이 CSS 변환 개체는 복제할 수 없습니다. HTML/CSS 편집을 이용해 주세요.");
    return { x: round((g.cx - slide.left) / ss - g.bw / 2), y: round((g.cy - slide.top) / ss - g.bh / 2), w: round(g.bw), h: round(g.bh), rotate: round(g.angle) };
  }
  function snapshotObject(source) {
    const box = objectBox(source), p = effective(source.dataset.sdId);
    if (nativeAdded(source)) {
      const copy = structuredClone(p);
      delete copy.id; delete copy.slide; delete copy.locked; delete copy.hidden; delete copy.layerPosition;
      Object.assign(copy, box);
      if (copy.kind === "text") {
        copy.richText = TextEditor.snapshot(source);
        copy.textBox = TextEditor.box(source);
        copy.text = Text.plainText(copy.richText);
        copy.fontSize = parseFloat(getComputedStyle(source).fontSize);
        delete copy.inheritFontSize;
        copy.textMetricsScale = Number(source.dataset.sdTextMetricsScale) || 1;
      }
      if (copy.kind === "image") copy.image = Objects.normalizeImage(copy.image || {});
      if (copy.kind === "shape") copy.shape = Objects.normalizeShape(copy.shape || {}, copy.fill);
      return copy;
    }
    if (source.tagName === "IMG") {
      const c = getComputedStyle(source);
      // Decorated or off-center imported images retain the generic HTML snapshot.
      // Plain imported images become independent native objects with their original source.
      const simple = c.objectPosition === "50% 50%" && c.filter === "none" && c.clipPath === "none" && c.boxShadow === "none" &&
        ["Top", "Right", "Bottom", "Left"].every(side => parseFloat(c[`border${side}Width`]) === 0) && parseFloat(c.borderRadius) === 0;
      if (simple) return { kind: "image", src: Objects.safeImageSource(localAssetURL(source.src)), image: Objects.normalizeImage({ mode: { cover: "fill", contain: "fit", fill: "stretch" }[c.objectFit] || "stretch" }), ...box };
    }
    const copy = source.cloneNode(true), originals = [source, ...source.querySelectorAll("*")], copies = [copy, ...copy.querySelectorAll("*")];
    const allowedTags = new Set("h1 h2 h3 h4 h5 h6 p div span section article header footer aside main ul ol li table thead tbody tfoot tr td th colgroup col caption img a br hr strong em b i u s small sub sup blockquote figcaption figure pre code".split(" "));
    const properties = "display box-sizing width height min-width min-height max-width max-height position top right bottom left padding-top padding-right padding-bottom padding-left margin-top margin-right margin-bottom margin-left color background-color background-image background-size background-position background-repeat border-top border-right border-bottom border-left border-radius font-family font-size font-weight font-style line-height letter-spacing word-spacing text-align text-decoration text-transform text-indent white-space word-break overflow-wrap vertical-align opacity box-shadow text-shadow object-fit object-position overflow flex flex-direction flex-wrap align-items justify-content gap grid-template-columns grid-template-rows transform transform-origin rotate scale translate".split(" ");
    for (const [i, original] of originals.entries()) {
      const node = copies[i];
      if (!allowedTags.has(node.localName)) throw new Error(`복제할 수 없는 HTML 태그: ${node.localName}`);
      const attrs = [...node.attributes].filter(a => ["src", "alt", "colspan", "rowspan", "scope", "start"].includes(a.name));
      for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      for (const attr of attrs) node.setAttribute(attr.name, attr.name === "src" ? localAssetURL(attr.value) : attr.value);
      const computed = getComputedStyle(original);
      for (const property of properties) {
        let value = computed.getPropertyValue(property);
        // Preserve inherited text styles so editing the snapshot root still affects its text.
        if (i > 0 && ["font-family", "font-size", "color", "line-height", "letter-spacing", "word-spacing", "text-align"].includes(property) &&
          value === getComputedStyle(original.parentElement).getPropertyValue(property)) value = "inherit";
        if (value.includes("url(")) value = value.replace(/url\(["']?([^"')]+)["']?\)/g, (_, url) => `url("${localAssetURL(url)}")`);
        node.style.setProperty(property, value);
      }
    }
    Object.assign(copy.style, { position: "relative", left: "auto", right: "auto", top: "auto", bottom: "auto", margin: "0", width: "100%", height: "100%", minWidth: "0", minHeight: "0", maxWidth: "none", maxHeight: "none", boxSizing: "border-box", transform: "none", transformOrigin: "center center", translate: "none", rotate: "none", scale: "none" });
    const rich = source.dataset.sdRich === "true" ? TextEditor.snapshot(source) : null;
    return { kind: "html", html: copy.outerHTML, ...box, ...(rich ? { richText: rich, textBox: TextEditor.box(source) } : {}) };
  }
  function command(name) {
    try {
      if (name === "select-all") { setSelection(editableElements().filter(e => visible(e) && !locked(e))); return; }
      if (!selection.length) return;
      if (["front", "back", "forward", "backward"].includes(name)) { layerOrder(name); return; }
      if (["align-left", "align-center", "align-right", "align-top", "align-middle", "align-bottom", "distribute-x", "distribute-y"].includes(name)) { arrange(name); return; }
      if (selection.some(locked)) throw new Error("잠긴 개체는 먼저 레이어 목록에서 잠금을 해제해 주세요.");
      if (name === "group") {
        if (selection.length < 2 || selection.some(e => !groupable(e)))
          throw new Error("같은 슬라이드에 추가한 글·이미지·도형·그룹을 두 개 이상 선택해 주세요. 원본 HTML 개체는 그룹으로 묶을 수 없습니다.");
        const ordered = paintOrder(editableElements().filter(e => selection.includes(e)));
        const grouped = Objects.groupObjects(ordered.map(snapshotObject));
        grouped.z = Math.max(...ordered.map(e => parseInt(getComputedStyle(e).zIndex) || 0));
        tell("object-structure", { operation: name, slide: slides[current].dataset.sdSlide, removeIds: ordered.map(e => e.dataset.sdId), objects: [grouped] });
        return;
      }
      if (name === "ungroup") {
        if (selection.length !== 1 || effective(selected.dataset.sdId).kind !== "group" || !groupable(selected))
          throw new Error("잠기지 않은 그룹 하나를 선택해 주세요.");
        tell("object-structure", { operation: name, slide: slides[current].dataset.sdSlide, removeIds: [selected.dataset.sdId], objects: Objects.ungroup(snapshotObject(selected)) });
        return;
      }
      if (["hide", "lock", "delete"].includes(name)) {
        const key = name === "lock" ? "locked" : "hidden";
        applyChanges(selection.map(e => ({ id: e.dataset.sdId, patch: { [key]: true } })), name);
        select(null);
      }
      if (["duplicate", "copy"].includes(name)) {
        const objects = paintOrder(editableElements().filter(e => selection.includes(e))).map(snapshotObject);
        tell("objects", { operation: name, slide: slides[current].dataset.sdSlide, objects });
      }
    } catch (error) { tell("notice", { message: error.message }); }
  }
  if (edit) {
    document.addEventListener(
      "click",
      (e) => {
        if (e.target.closest?.("#sd-selection-overlay")) { e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (formTarget(e.target)) return;
        if (e.target.isContentEditable) {
          e.stopImmediatePropagation();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    document.addEventListener(
      "dblclick",
      (e) => {
        if (formTarget(e.target) || e.target.isContentEditable) return;
        const target = activeTarget(e.target);
        if (target && TextEditor.eligible(target) && !locked(target)) {
          e.preventDefault();
          select(target);
          try { beginText(target); } catch (error) { tell("notice", { message: error.message }); }
        }
      },
      true,
    );
    document.addEventListener(
      "focusout",
      (e) => {
        if (textEdit?.el.contains(e.target)) finishText();
      },
      true,
    );
    document.addEventListener("compositionstart", () => { composing = true; }, true);
    document.addEventListener("compositionend", () => {
      composing = false;
      if (textEdit?.pending || editRequests.size) queueMicrotask(settleEdits);
    }, true);
    document.addEventListener("selectionchange", () => {
      if (!textEdit || composing) return;
      const range = TextEditor.capture(textEdit.el);
      if (range) { textRanges.set(textEdit.el, range); report(); }
    });
    document.addEventListener("input", e => {
      if (!textEdit || !textEdit.el.contains(e.target)) return;
      textEdit.nativeAtBoundary = false;
      if (e.inputType === "historyUndo") {
        textEdit.nativeUndoDepth++;
        const boundary = textEdit.programmatic ? textEdit.nativeBaseline : textEdit.baseline;
        try { textEdit.nativeAtBoundary = JSON.stringify(TextEditor.read(textEdit.el)) === boundary; } catch { /* Keep native undo for invalid input. */ }
      } else if (e.inputType === "historyRedo") textEdit.nativeUndoDepth = Math.max(0, textEdit.nativeUndoDepth - 1);
      else textEdit.nativeUndoDepth = 0;
    }, true);
    document.addEventListener("paste", e => {
      if (!textEdit || !textEdit.el.contains(e.target) || composing) return;
      e.preventDefault();
      const value = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
      if (!value) return;
      const range = TextEditor.capture(textEdit.el);
      if (!range) return;
      try {
        const rich = TextEditor.read(textEdit.el), plain = Text.plainText(rich);
        const next = TextEditor.replaceText(rich, plain.slice(0, range.start) + value + plain.slice(range.end));
        TextEditor.render(textEdit.el, next, TextEditor.box(textEdit.el));
        TextEditor.restore(textEdit.el, { start: range.start + value.length, end: range.start + value.length });
        // DOM replacement is outside browser history. Native typing after it
        // can still undo back to this boundary before the app undoes the paste.
        textEdit.programmatic = true;
        textEdit.nativeBaseline = JSON.stringify(TextEditor.read(textEdit.el));
        textEdit.nativeUndoDepth = 0;
        textEdit.nativeAtBoundary = true;
      } catch (error) { tell("notice", { message: error.message }); }
    }, true);
    document.addEventListener(
      "pointerdown",
      (e) => {
        const handle = e.target.closest?.("[data-sd-handle]");
        if (e.button !== 0 || e.target.isContentEditable || (!handle && formTarget(e.target)) || composing) return;
        let target = handle ? selected : activeTarget(e.target);
        if (target && locked(target)) target = null;
        if (!target) {
          finishDrag(false);
          finishNudge(true);
          const originalSelection = [...selection], extend = e.shiftKey || e.ctrlKey || e.metaKey;
          if (!extend) select(null);
          if (slides[current]?.contains(e.target)) {
            e.preventDefault(); e.stopImmediatePropagation();
            if (formTarget(document.activeElement)) document.activeElement.blur();
            window.focus();
            drag = { kind: "marquee", pointerId: e.pointerId, capture: slides[current], startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, selection: extend ? originalSelection : [], originalSelection };
            drag.capture.setPointerCapture(e.pointerId);
          }
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        finishNudge(true);
        if (!textEdit) textRanges.delete(target);
        finishDrag(false);
        if (!handle && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          setSelection(selection.includes(target) ? selection.filter(item => item !== target) : [...selection, target]);
          window.focus();
          return;
        }
        if (!selection.includes(target)) select(target);
        else report();
        if (formTarget(document.activeElement)) document.activeElement.blur();
        window.focus();
        const g = geometry(target);
        if (handle && g.reason) return;
        if (selection.some(locked)) return;
        const p = effective(target.dataset.sdId);
        drag = {
          id: target.dataset.sdId,
          el: target,
          pointerId: e.pointerId,
          before: patches[target.dataset.sdId] && { ...patches[target.dataset.sdId] },
          cssText: target.style.cssText,
          capture: handle || target,
          kind: handle?.dataset.sdHandle || "move",
          geometry: g,
          scale: scale(),
          base: { x: p.x ?? 0, y: p.y ?? 0, w: g.w, h: g.h, rotate: g.angle },
          startX: e.clientX,
          startY: e.clientY,
          x: p.x ?? 0,
          y: p.y ?? 0,
          dx: 0,
          dy: 0,
        };
        if (!handle && selection.length > 1) {
          if (selection.some(e => geometry(e).reason)) { drag = null; tell("notice", { message: "CSS 변환을 포함한 선택은 함께 이동할 수 없습니다." }); return; }
          drag.items = movementItems();
        }
        drag.capture.setPointerCapture(e.pointerId);
      },
      true,
    );
    document.addEventListener(
      "pointermove",
      (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        e.preventDefault();
        transformDrag(e);
      },
      true,
    );
    document.addEventListener(
      "pointerup",
      (e) => { if (drag?.pointerId === e.pointerId) finishDrag(true); },
      true,
    );
    for (const type of ["pointercancel", "lostpointercapture"])
      document.addEventListener(type, (e) => {
        if (drag?.pointerId === e.pointerId) finishDrag(false);
      }, true);
    window.addEventListener("blur", () => { finishDrag(false); finishNudge(true); });
    window.addEventListener("resize", () => { finishDrag(false); updateOverlay(); });
    window.addEventListener("scroll", updateOverlay, true);
    const observer = new ResizeObserver(updateOverlay);
    slides.forEach(s => observer.observe(s));
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.isComposing || composing || e.keyCode === 229 || formTarget(e.target)) return;
        if (e.target.isContentEditable) {
          if ((e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase()) && textEdit) {
            const redo = e.key.toLowerCase() === "y" || e.shiftKey;
            let current;
            try { current = JSON.stringify(TextEditor.read(textEdit.el)); } catch { /* Native undo can recover invalid input. */ }
            const boundary = textEdit.programmatic ? textEdit.nativeBaseline : textEdit.baseline;
            if (textEdit.nativeAtBoundary && current === boundary && (!redo || !textEdit.nativeUndoDepth)) {
              e.preventDefault(); e.stopImmediatePropagation();
              finishText();
              if (!textEdit) tell(redo ? "redo" : "undo");
              return;
            }
          }
          if ((e.ctrlKey || e.metaKey) && ["b", "i", "u"].includes(e.key.toLowerCase()) && textEdit) {
            e.preventDefault(); e.stopImmediatePropagation();
            const target = textEdit.el, range = TextEditor.capture(target), key = { b: "bold", i: "italic", u: "underline" }[e.key.toLowerCase()];
            if (range) textRanges.set(target, range);
            const value = !TextEditor.styleAt(TextEditor.read(target), range)[key];
            textCommand({ type: "text-format", id: target.dataset.sdId, scope: "character", changes: { [key]: value } });
            beginText(target); return;
          }
          if (e.key === "Escape") e.target.blur();
          return;
        }
        e.stopImmediatePropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          finishDrag(false);
          finishNudge(false);
          select(null);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase())) {
          e.preventDefault();
          finishNudge(true);
          tell(e.key.toLowerCase() === "y" || e.shiftKey ? "redo" : "undo");
        }
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (direction && selected && !drag && !e.ctrlKey && !e.metaKey && !e.altKey && !selection.some(locked)) {
          e.preventDefault();
          if (selection.length > 1 && selection.some(item => geometry(item).reason)) return;
          if (!nudge) nudge = { items: movementItems(), keys: new Set(), dx: 0, dy: 0 };
          nudge.keys.add(e.key);
          const step = e.shiftKey ? 10 : 1;
          nudge.dx += direction[0] * step; nudge.dy += direction[1] * step;
          moveItems(nudge.items, nudge.dx, nudge.dy);
          report();
        }
        if (e.key === "Delete" && selected) {
          e.preventDefault();
          finishDrag(false);
          finishNudge(true);
          command("delete");
        }
        if ((e.ctrlKey || e.metaKey) && ["a", "d", "c", "v"].includes(e.key.toLowerCase())) {
          e.preventDefault();
          const name = { a: "select-all", d: "duplicate", c: "copy", v: "paste" }[e.key.toLowerCase()];
          settleEdits();
          if (name === "paste") tell("paste"); else command(name);
        }
      },
      true,
    );
    document.addEventListener("keyup", (e) => {
      if (!nudge?.keys.has(e.key)) return;
      nudge.keys.delete(e.key);
      if (!nudge.keys.size) finishNudge(true);
    }, true);
    window.addEventListener("wheel", (e) => {
      e.stopImmediatePropagation();
      if (e.ctrlKey) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
      tell("pan", { dx: (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, dy: (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit });
    }, { capture: true, passive: false });
  } else
    document
      .querySelectorAll("[contenteditable]")
      .forEach((e) => e.removeAttribute("contenteditable"));
  window.addEventListener("message", (e) => {
    if (
      e.source !== parent ||
      e.origin !== config.managerOrigin ||
      !e.data?.studio ||
      !edit
    )
      return;
    const d = e.data;
    if (d.editorSession && d.editorSession !== new URLSearchParams(location.search).get("editorSession")) return;
    if (["text-format", "text-replace"].includes(d.type)) textCommand(d);
    if (d.type === "command" && typeof d.name === "string" && !composing) {
      settleEdits();
      command(d.name);
    }
    if (d.type === "select-ids" && Array.isArray(d.ids) && !composing) {
      settleEdits();
      for (const item of selection) textRanges.delete(item);
      setSelection(editableElements().filter(e => d.ids.includes(e.dataset.sdId)));
    }
    if (d.type === "layer-toggle" && ["locked", "hidden"].includes(d.key) && typeof d.id === "string" && !composing) {
      settleEdits();
      const target = editableElements().find(item => item.dataset.sdId === d.id);
      if (target) {
        if (locked(target) && !effective(d.id).locked) tell("notice", { message: "상위 개체의 잠금을 먼저 해제해 주세요." });
        else {
          applyChanges([{ id: d.id, patch: { [d.key]: !effective(d.id)[d.key] } }]);
          if (d.key === "hidden" && !visible(target)) setSelection(selection.filter(e => e !== target));
        }
      }
    }
    if (d.type === "settings" && typeof d.lockAspect === "boolean") lockAspect = d.lockAspect;
    if (d.type === "commit-edit" && typeof d.requestId === "string" && d.requestId.length <= 100) {
      editRequests.add(d.requestId);
      settleEdits();
    }
    if (d.type === "go") go(d.index);
    if (d.type === "patch" && typeof d.id === "string" && d.patch && typeof d.patch === "object") {
      const target = document.querySelector(`[data-sd-id="${CSS.escape(d.id)}"]`);
      if (target && slides[current]?.contains(target) && !locked(target)) {
        finishDrag(false);
        finishNudge(true);
        patch(d.id, d.patch);
        if (d.patch.hidden && target === selected) select(null);
        else report();
      }
    }
    if (d.type === "deselect") {
      finishDrag(false);
      select(null);
    }
  });
  function nativeStyleSupported(element) {
    const c = getComputedStyle(element);
    return c.opacity === "1" && c.filter === "none" && c.clipPath === "none" && c.boxShadow === "none" &&
      c.transform === "none" && c.scale === "none" &&
      c.textShadow === "none" && c.backgroundImage === "none" && parseFloat(c.borderRadius) === 0 &&
      ["Top", "Right", "Bottom", "Left"].every(side => parseFloat(c[`border${side}Width`]) === 0);
  }
  function collectNative(element, original, world, id, groupChild = false) {
    const c = getComputedStyle(element), factor = world.w / (original.w || world.w);
    const rgba = c.backgroundColor.match(/[\d.]+/g) || [];
    const alpha = rgba.length > 3 ? Number(rgba[3]) : 1, fill = alpha === 0 ? "none" : hex(c.backgroundColor);
    const base = { id, nativeObject: true, nativeSupported: nativeStyleSupported(element) && [0, 1].includes(alpha), groupChild,
      kind: world.kind, x: world.x, y: world.y, w: world.w, h: world.h, rotate: world.rotate || 0, z: world.z ?? 20 };
    if (world.kind === "group") {
      if (fill !== "none") base.nativeSupported = false;
      const children = [], content = element.querySelector(":scope > [data-sd-group-content]");
      if (!content || content.children.length !== original.group.children.length) return { ...base, nativeSupported: false, children };
      try {
        const transformed = Objects.ungroup(world);
        const nodes = [...content.children];
        const order = original.group.children.map((object, index) => ({ object, index })).sort((a, b) => (a.object.z ?? 20) - (b.object.z ?? 20) || a.index - b.index);
        for (const { object, index } of order) {
          if (object.hidden || getComputedStyle(nodes[index]).display === "none") continue;
          const child = collectNative(nodes[index], object, transformed[index], `${id}--${index}`, true);
          if (!child.nativeSupported) base.nativeSupported = false;
          children.push(...(child.kind === "group" ? child.children : [child]));
        }
      } catch { base.nativeSupported = false; }
      return { ...base, children };
    }
    if (world.kind === "image") {
      const source = element.querySelector("img[data-sd-image-source]");
      return { ...base, nativeSupported: base.nativeSupported && !!source?.naturalWidth, src: source?.src,
        naturalWidth: source?.naturalWidth, naturalHeight: source?.naturalHeight, image: Objects.normalizeImage(world.image || {}), fill };
    }
    if (world.kind === "shape") return { ...base, shape: Objects.normalizeShape(world.shape || {}, world.fill) };
    if (world.kind !== "text" || !TextEditor.eligible(element)) return { ...base, nativeSupported: false };
    try {
      const richText = TextEditor.resolve(element);
      for (const paragraph of richText.paragraphs) {
        if (paragraph.spaceAfter !== undefined) paragraph.spaceAfter *= factor;
        for (const run of paragraph.runs) if (run.fontSize !== undefined) run.fontSize *= factor;
      }
      return { ...base,
        text: Text.plainText(richText), richText, textBox: TextEditor.box(element),
        fontScale: Number(element.dataset.sdFontScale) || 1,
        textMetricsScale: (Number(element.dataset.sdTextMetricsScale) || 1) * factor,
        textOverflowing: element.dataset.sdTextOverflowing === "true",
        fill,
        padding: Object.fromEntries(["top", "right", "bottom", "left"].map(side => [side, (parseFloat(c["padding" + side[0].toUpperCase() + side.slice(1)]) || 0) * factor])),
        fontSize: parseFloat(c.fontSize) * factor, fontFamily: c.fontFamily, color: hex(c.color).slice(1),
        bold: parseInt(c.fontWeight) >= 600, align: ["center", "right"].includes(c.textAlign) ? c.textAlign : "left" };
    } catch { return { ...base, nativeSupported: false }; }
  }
  function collect() {
    const list = [];
    const slide = slides[current];
    const ss = scale();
    for (const e of paintOrder([...slide.querySelectorAll("[data-sd-id]")])) {
      if (e.closest(".notes")) continue;
      const c = getComputedStyle(e),
        r = e.getBoundingClientRect();
      if (
        c.display === "none" ||
        c.visibility === "hidden" ||
        r.width < 1 ||
        r.height < 1
      )
        continue;
      if (nativeAdded(e)) {
        try {
          const { id, slide, layerPosition, ...original } = effective(e.dataset.sdId);
          const world = { ...original, ...objectBox(e) };
          list.push(collectNative(e, original, world, e.dataset.sdId));
        } catch { /* Unsupported CSS stays in the screenshot background. */ }
        continue;
      }
      if (e.tagName === "IMG") {
        list.push({
          id: e.dataset.sdId,
          kind: "image",
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          src: e.src,
        });
        continue;
      }
      if (e.querySelector("img,[data-sd-id]")) continue;
      if (!e.innerText?.trim()) continue;
      let richInfo = {};
      if (TextEditor.eligible(e)) {
        try {
          const richText = TextEditor.resolve(e);
          richInfo = { richText, textBox: TextEditor.box(e), textMetricsScale: Number(e.dataset.sdTextMetricsScale) || 1, fontScale: Number(e.dataset.sdFontScale) || 1, textOverflowing: e.dataset.sdTextOverflowing === "true", padding: Object.fromEntries(["top", "right", "bottom", "left"].map(side => [side, parseFloat(c["padding" + side[0].toUpperCase() + side.slice(1)]) || 0])) };
        } catch { /* Preserve the legacy extraction for unsupported original text. */ }
      }
      list.push({
        id: e.dataset.sdId,
        kind: "text",
        text: e.innerText,
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        fontSize: parseFloat(c.fontSize) * ss,
        color: hex(c.color).slice(1),
        bold: parseInt(c.fontWeight) >= 600,
        align: ["center", "right"].includes(c.textAlign) ? c.textAlign : "left",
        rotate: parseFloat(c.rotate) || 0,
        ...richInfo,
      });
    }
    return list;
  }
  window.__sd = {
    go,
    collect,
    get current() {
      return current;
    },
    count: slides.length,
    hideNative(ids) {
      const css = document.createElement("style");
      css.id = "sd-hide-native";
      css.textContent = ids.map(id => {
        const selector = `[data-sd-id="${CSS.escape(id)}"]`;
        const node = document.querySelector(selector);
        if (["image", "shape", "group"].includes(node?.dataset.sdKind)) return `${selector},${selector} *{visibility:hidden!important}`;
        return `${selector},${selector} *{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}img${selector}{visibility:hidden!important}`;
      }).join("\n");
      document.head.append(css);
    },
    showNative() {
      document.getElementById("sd-hide-native")?.remove();
    },
    clean() {
      select(null);
      const s = document.createElement("style");
      s.textContent = "#hud,#help,#progress,#notes{display:none!important}";
      document.head.append(s);
    },
  };
  document.fonts.ready.then(() => {
    Objects.refresh(document);
    for (const el of document.querySelectorAll('[data-sd-rich="true"]')) TextEditor.fit(el);
    if (edit) report();
  });
  if (typeof window.goSlide !== "function") {
    addEventListener("resize", () => go(current));
    if (!edit)
      document.addEventListener("keydown", (e) => {
        if (["ArrowRight", "PageDown", " "].includes(e.key)) go(current + 1);
        if (["ArrowLeft", "PageUp"].includes(e.key)) go(current - 1);
      });
  }
  go(Math.max(0, (parseInt(location.hash.slice(1)) || 1) - 1));
  tell("ready", { count: slides.length });
})();
