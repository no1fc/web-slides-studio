"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
let decks = [],
  deck = null,
  state = null,
  index = 0,
  selected = null,
  selectedElements = [],
  layerItems = [],
  objectClipboard = null,
  undo = [],
  redo = [],
  dirty = false,
  blocked = false,
  saveTimer = null,
  saving = null,
  editEpoch = 0,
  filter = "all",
  folder = "",
  replaceImage = false;
const frame = $("deckFrame");
function layoutCanvas() {
  const viewport = $("canvasViewport"), wrap = $("canvasWrap");
  if (!viewport.clientWidth || !viewport.clientHeight) return;
  const zoom = $("zoomValue").value;
  const factor = zoom === "fit"
    ? Math.min(viewport.clientWidth / 1920, viewport.clientHeight / 1080)
    : Number(zoom) / 100;
  wrap.style.width = `${Math.floor(1920 * factor)}px`;
  wrap.style.height = `${Math.floor(1080 * factor)}px`;
  wrap.style.marginTop = `${Math.max(0, (viewport.clientHeight - 1080 * factor) / 2)}px`;
}
new ResizeObserver(layoutCanvas).observe($("canvasViewport"));
new ResizeObserver(([entry]) => {
  $("editor").style.setProperty("--editor-toolbar-height", `${entry.target.offsetHeight}px`);
}).observe(document.querySelector(".editor-toolbar"));
$("zoomValue").onchange = () => { layoutCanvas(); $("canvasViewport").scrollTo(0, 0); };
$("lockAspect").onchange = () => post("settings", { lockAspect: $("lockAspect").checked });
let frameReady = false;
let editorSession = null, pendingSelection = [], objectWork = Promise.resolve(), objectBusy = false;
const pendingEdits = new Map();
const pendingTextCommands = new Map();
let textBusy = false;
let transitionBusy = false;
const clone = (x) => JSON.parse(JSON.stringify(x));
const uid = (p) => p + "-" + crypto.randomUUID();
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 6000);
}
async function api(path, method = "GET", data) {
  const opts = { method, headers: {} };
  if (data !== undefined) {
    if (data instanceof Blob || data instanceof ArrayBuffer) {
      opts.body = data;
      opts.headers["Content-Type"] = "application/zip";
    } else {
      opts.body = JSON.stringify(data);
      opts.headers["Content-Type"] = "application/json";
    }
  }
  const r = await fetch("/api" + path, opts);
  const b = await r.json();
  if (!r.ok) {
    if (r.status === 401 && path !== "/password") {
      $("login").hidden = false;
      $("shell").hidden = true;
    }
    const e = new Error(b.error || "요청 실패");
    e.status = r.status;
    throw e;
  }
  return b;
}
const action =
  (fn) =>
  async (...args) => {
    try {
      await settleEditing();
      await fn(...args);
    } catch (e) {
      toast(e.message);
    }
  };
const post = (type, data = {}) => {
  if (deck)
    frame.contentWindow?.postMessage(
      { studio: true, type, editorSession, ...data },
      new URL(deck.previewUrl).origin,
    );
};
async function settleEditing() {
  if (!deck) return;
  if (!frameReady) { await objectWork; return; }
  const requestId = crypto.randomUUID();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingEdits.delete(requestId);
      reject(new Error("편집 화면의 입력을 확정하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    }, 3000);
    pendingEdits.set(requestId, () => { clearTimeout(timer); resolve(); });
    post("commit-edit", { requestId });
  });
  await objectWork;
}
function transitionTools() {
  for (const id of ["sceneValue", "backgroundValue", "undoBtn", "redoBtn", "addSlideBtn", "removeSlideBtn", "duplicateSlideBtn", "upSlideBtn", "downSlideBtn", "layoutBtn", "themeBtn", "notesValue"]) $(id).disabled = transitionBusy;
  $("slideList").querySelectorAll("button").forEach(button => { button.disabled = transitionBusy; });
}
function transitionAction(fn, processingStatus) {
  return (...args) => {
    if (!deck || transitionBusy) return;
    const context = objectContext(), previousStatus = $("saveStatus").textContent;
    transitionBusy = true;
    transitionTools();
    $("saveStatus").textContent = processingStatus;
    return action(() => {
      if (currentObjectContext(context)) return fn(...args);
    })().finally(() => {
      transitionBusy = false;
      transitionTools();
      if ($("saveStatus").textContent === processingStatus) $("saveStatus").textContent = previousStatus;
    });
  };
}
function dialog(title) {
  $("dialog").classList.remove("files-dialog");
  $("dialogTitle").textContent = title;
  $("dialogBody").replaceChildren();
  $("dialog").showModal();
  return $("dialogBody");
}
$("closeDialog").onclick = () => $("dialog").close();
function mark() {
  editEpoch++;
  dirty = true;
  $("saveStatus").textContent = "저장 대기";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush().catch((e) => toast(e.message)), 600);
}
function checkpoint() {
  undo.push(clone(state));
  if (undo.length > 50) undo.shift();
  redo = [];
}
async function flush() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!dirty) return;
  if (blocked)
    throw new Error(
      "저장 충돌이 있습니다. 현재 화면을 유지한 채 버전 상태를 확인해 주세요.",
    );
  dirty = false;
  const snapshot = clone(state),
    id = deck.id;
  const revision = deck.revision;
  const epoch = editEpoch;
  $("saveStatus").textContent = "저장 중…";
  saving = api(`/decks/${id}/save`, "POST", { revision, state: snapshot })
    .then((d) => {
      if (!deck || deck.id !== id) return;
      // Only normalize the snapshot that was acknowledged; later edits stay local.
      if (editEpoch === epoch) state = clone(d.state);
      deck = { ...d, state };
      window.SDSlideUI?.render();
      $("saveStatus").textContent = dirty
        ? "저장 대기"
        : `저장됨 · v${d.revision}`;
    })
    .catch((e) => {
      dirty = true;
      blocked = e.status === 409;
      $("saveStatus").textContent = "저장 실패 · 변경 보존 중";
      if (blocked && !$("dialog").classList.contains("authoring-dialog"))
        conflictDialog();
      throw e;
    })
    .finally(() => {
      saving = null;
    });
  await saving;
  if (dirty && !blocked) await flush();
}
function conflictDialog() {
  if ($("dialog").open) $("dialog").close();
  const body = dialog("다른 창에서 저장한 내용이 있습니다");
  body.append(
    el(
      "p",
      "작성 중인 내용은 이 화면에 유지되어 있습니다. 내 변경을 별도 파일로 보관하거나, 서버의 최신 버전을 열거나, 내 변경을 새 버전으로 저장할 수 있습니다. 기존 저장 버전은 기록에 남습니다.",
    ),
  );
  const backup = el("button", "내 변경 JSON 내려받기", "export-option");
  backup.id = "conflictBackupBtn";
  backup.onclick = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { deckId: deck.id, baseRevision: deck.revision, state },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const href = URL.createObjectURL(blob);
    const a = el("a");
    a.href = href;
    a.download = "slides-unsaved-" + deck.id + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  body.append(backup);
  const keep = el(
    "button",
    "내 변경을 새 버전으로 저장",
    "export-option primary",
  );
  keep.id = "conflictKeepBtn";
  keep.onclick = action(async () => {
    const latest = await api("/decks/" + deck.id);
    deck.revision = latest.revision;
    blocked = false;
    dirty = true;
    $("dialog").close();
    await flush();
    toast("내 변경을 새 버전으로 저장했습니다.");
  });
  body.append(keep);
  const reload = el(
    "button",
    "내 변경을 버리고 최신 버전 열기",
    "export-option",
  );
  reload.id = "conflictReloadBtn";
  reload.onclick = action(async () => {
    const id = deck.id;
    dirty = false;
    blocked = false;
    deck = null;
    $("dialog").close();
    await openDeck(id);
  });
  body.append(reload);
}
$("saveStatus").onclick = () => {
  if (blocked) conflictDialog();
};
function refreshFrame(selectIds = []) {
  frameReady = false;
  editorSession = crypto.randomUUID();
  pendingSelection = selectIds;
  frame.src = deck.previewUrl + "&mode=edit&editorSession=" + editorSession + "#" + (index + 1);
  layerItems = [];
  clearSelection();
  renderLayers();
}
function clearSelection() {
  selected = null;
  selectedElements = [];
  $("lockAspect").checked = false;
  properties();
}
async function structural(fn) {
  checkpoint();
  fn();
  index = Math.max(0, Math.min(index, state.order.length - 1));
  mark();
  await flush();
  renderSlides();
  refreshFrame();
}
function detachPlaceholders(candidate, ids) {
  for (const layout of Object.values(candidate.slideLayouts || {})) {
    for (const [role, id] of Object.entries(layout.placeholders)) if (ids.includes(id)) delete layout.placeholders[role];
  }
}
function patch(p, deleted = false) {
  if (!selected || !activeElement(selected.id) || objectLocked(selected.id) || objectBusy) return;
  checkpoint();
  state.patches[selected.id] = { ...(state.patches[selected.id] || {}), ...p };
  if (deleted) detachPlaceholders(state, [selected.id]);
  post("patch", { id: selected.id, patch: p });
  Object.assign(selected, p);
  if (p.hidden) {
    clearSelection();
  }
  mark();
}
function activeElement(id) {
  const slide = state?.order[index];
  if (!slide || typeof id !== "string") return false;
  if (state.added.some((a) => a.id === id && a.slide === slide)) return true;
  if (state.slideCode?.[slide]) {
    const doc = new DOMParser().parseFromString(state.slideCode[slide].html, "text/html");
    return [...doc.querySelectorAll("[data-sd-id]")].some((e) => e.dataset.sdId === id);
  }
  const source = Object.hasOwn(state.clones, slide) ? state.clones[slide] : slide;
  return deck.elements.some((e) => e.slide === source &&
    (slide === source ? e.id : slide + "--" + e.id) === id);
}
async function history(back) {
  const source = back ? undo : redo,
    dest = back ? redo : undo;
  if (!source.length) return;
  dest.push(clone(state));
  const active = state.order[index];
  state = source.pop();
  const restoredIndex = state.order.indexOf(active);
  index = restoredIndex >= 0 ? restoredIndex : Math.min(index, state.order.length - 1);
  mark();
  await flush();
  renderSlides();
  refreshFrame();
}
function performHistory(back) {
  return transitionAction(() => history(back), back ? "실행 취소 중…" : "다시 실행 중…")();
}
function properties() {
  const s = selected;
  $("noSelection").hidden = !!s;
  $("properties").hidden = !s;
  $("selectedLabel").textContent = s
    ? `${s.tag.toUpperCase()} 선택됨${objectLocked(s.id) ? " · 잠금" : ""}`
    : selectedElements.length > 1 ? `${selectedElements.length}개 요소 선택됨` : "선택한 요소 없음";
  $("selectionHelp").textContent = selectedElements.length > 1
    ? "여러 개체를 함께 이동·정렬할 수 있습니다. 크기와 내용을 바꾸려면 하나만 선택하세요."
    : "슬라이드 또는 레이어 목록에서 개체를 선택하세요.";
  $("properties").querySelectorAll("input,textarea,button,select").forEach(control => { control.disabled = !s || objectLocked(s.id); });
  textProperties();
  arrangementTools();
  visualProperties();
  if (!s) return;
  $("precisionNote").textContent = objectLocked(s.id) ? "잠긴 개체입니다. 레이어 목록에서 잠금을 해제하세요." : s.precisionReason || "";
  $("precisionNote").hidden = !$("precisionNote").textContent;
  $("textField").hidden = s.tag === "img" || ["image", "shape", "group"].includes(s.kind);
  $("replaceImageBtn").hidden = s.tag !== "img";
  $("textValue").value = s.text;
  for (const [id, key] of [
    ["xValue", "x"],
    ["yValue", "y"],
    ["wValue", "w"],
    ["hValue", "h"],
    ["rotateValue", "rotate"],
    ["fillValue", "fill"],
  ])
    $(id).value = s[key] ?? 0;
}
function nativeAdded(id) {
  return state?.added.find(a => a.id === id && a.slide === state.order[index] && ["text", "image", "shape", "group"].includes(a.kind));
}
function visualProperties() {
  const s = selected, native = s && nativeAdded(s.id);
  const image = native?.kind === "image", shape = native?.kind === "shape", group = native?.kind === "group";
  $("imageTools").hidden = !image;
  $("shapeTools").hidden = !shape;
  $("groupNote").hidden = !group;
  $("originalImageNote").hidden = !s || s.tag !== "img" || image;
  $("fillField").hidden = !!(shape || group);
  if (group) { $("lockAspect").checked = true; $("lockAspect").disabled = true; }
  if (shape || group) $("textUnavailableNote").hidden = true;
  const disabled = !s || objectLocked(s.id) || objectBusy || !frameReady;
  for (const panel of ["imageTools", "shapeTools"])
    $(panel).querySelectorAll("input,select,button").forEach(control => { control.disabled = disabled; });
  if (image) {
    const value = globalThis.SDObjects.normalizeImage(state.patches[s.id]?.image || s.image || native.image);
    $("imageModeValue").value = value.mode;
    for (const side of ["Left", "Right", "Top", "Bottom"])
      $("crop" + side + "Value").value = Math.round(value.crop[side.toLowerCase()] * 100000) / 1000;
  }
  if (shape) {
    const value = globalThis.SDObjects.normalizeShape(state.patches[s.id]?.shape || s.shape || native.shape, state.patches[s.id]?.fill || native.fill);
    for (const [id, key] of [["shapeTypeValue", "type"], ["shapeStrokeValue", "stroke"], ["shapeStrokeWidthValue", "strokeWidth"], ["shapeDashValue", "dash"]]) $(id).value = value[key];
    $("shapeFillValue").value = value.fill === "none" ? "#087e77" : value.fill;
    $("shapeNoFillValue").checked = value.fill === "none";
    const line = ["line", "arrow"].includes(value.type);
    $("shapeFillValue").disabled = disabled || line || value.fill === "none";
    $("shapeNoFillValue").disabled = disabled || line;
  }
}
function visualPatch(kind, changes) {
  const s = selected, object = s && nativeAdded(s.id);
  if (!object || object.kind !== kind || objectLocked(s.id) || objectBusy || !frameReady) return;
  const context = objectContext(), id = s.id;
  let value;
  try {
    const current = state.patches[id]?.[kind] || s[kind] || object[kind];
    value = kind === "image"
      ? globalThis.SDObjects.normalizeImage({ ...globalThis.SDObjects.normalizeImage(current), ...changes })
      : globalThis.SDObjects.normalizeShape({ ...globalThis.SDObjects.normalizeShape(current, state.patches[id]?.fill || object.fill), ...changes });
  } catch (error) { toast(error.message); visualProperties(); return; }
  const previousStatus = $("saveStatus").textContent, processingStatus = "개체 적용 중…";
  $("saveStatus").textContent = processingStatus;
  return queueObjectWork(context, async () => {
    if (selected?.id !== id || objectLocked(id)) return;
    const candidate = clone(state), p = { [kind]: value };
    candidate.patches[id] = { ...(candidate.patches[id] || {}), ...p };
    const validated = await validateObjectState(candidate, context);
    if (!validated || selected?.id !== id || objectLocked(id)) return;
    checkpoint(); state = validated;
    Object.assign(selected, p); post("patch", { id, patch: p }); mark();
  }).finally(() => {
    properties();
    if ($("saveStatus").textContent === processingStatus) $("saveStatus").textContent = previousStatus;
  });
}
function editableText(allowBusy = false) {
  return !!selected && selectedElements.length === 1 && selected.textEditable === true &&
    frameReady && !objectBusy && (allowBusy || !textBusy) && activeElement(selected.id) && !objectLocked(selected.id);
}
function textProperties() {
  for (const pending of pendingTextCommands.values())
    if (!currentObjectContext(pending.context) || selected?.id !== pending.id) pending.finish();
  const s = selected, enabled = editableText();
  $("textTools").hidden = s?.textEditable !== true;
  $("textUnavailableNote").hidden = !s || s.tag === "img" || s.textEditable !== false;
  $("textValue").disabled = !enabled;
  $("textTools").querySelectorAll("input,select,button").forEach(control => { control.disabled = !enabled; });
  if (!s || s.textEditable !== true) return;
  const style = s.textStyle || {}, box = s.textBox || {};
  for (const [id, value] of [
    ["fontFamilyValue", style.fontFamily ?? ""], ["fontValue", style.fontSize ?? s.fontSize ?? ""],
    ["colorValue", style.color ?? s.color ?? "#000000"], ["textAlignValue", style.align ?? "left"],
    ["lineHeightValue", style.lineHeight ?? 1.2], ["spaceAfterValue", style.spaceAfter ?? 0],
    ["listStyleValue", style.list ?? "none"], ["verticalAlignValue", box.vertical ?? "top"],
    ["textOverflowValue", box.overflow ?? "visible"], ["textAutoFitValue", box.autoFit ?? "none"],
  ]) $(id).value = value;
  for (const [id, key] of [["boldTextBtn", "bold"], ["italicTextBtn", "italic"], ["underlineTextBtn", "underline"]])
    $(id).setAttribute("aria-pressed", style[key] === null ? "mixed" : String(style[key] === true));
  const indent = style.indent ?? 0;
  $("outdentTextBtn").disabled = !enabled || indent <= 0;
  $("indentTextBtn").disabled = !enabled || indent >= 8;
  $("textRangeLabel").textContent = s.textRange
    ? s.textRange.start !== s.textRange.end ? "선택한 문자와 문단에 적용" : "선택한 글자가 없으면 전체 텍스트에 문자 서식을 적용합니다. 문단 서식은 현재 문단에 적용합니다."
    : "전체 텍스트에 적용";
  $("textOverflowNote").hidden = !s.textOverflowing;
}
function textCommand(type, data) {
  if (!editableText()) return;
  // Commit can refresh the inspector or finish an IME composition. Keep the original
  // target and values, and discard the command if the user changes its context.
  const id = selected.id, context = objectContext();
  const previousStatus = $("saveStatus").textContent, processingStatus = "서식 적용 중…";
  textBusy = true;
  textProperties();
  $("saveStatus").textContent = processingStatus;
  return action(async () => {
    if (!currentObjectContext(context) || selected?.id !== id || !editableText(true)) return;
    const requestId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        pendingTextCommands.delete(requestId);
        error ? reject(new Error(error)) : resolve();
      };
      const timer = setTimeout(() => finish("서식 적용 결과를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."), 3000);
      pendingTextCommands.set(requestId, { id, context, finish });
      post(type, { id, requestId, ...data });
    });
  })().finally(() => {
    textBusy = false;
    properties();
    if ($("saveStatus").textContent === processingStatus) $("saveStatus").textContent = previousStatus;
  });
}
function textFormat(scope, changes) {
  return textCommand("text-format", { scope, changes });
}
function objectLocked(id) {
  return !!(state?.patches[id]?.locked || layerItems.find(item => item.id === id)?.locked || selectedElements.find(item => item.id === id)?.locked);
}
const arrangementCommands = {
  duplicateObjectsBtn: "duplicate", copyObjectsBtn: "copy",
  groupObjectsBtn: "group", ungroupObjectsBtn: "ungroup",
  alignLeftBtn: "align-left", alignCenterBtn: "align-center", alignRightBtn: "align-right",
  alignTopBtn: "align-top", alignMiddleBtn: "align-middle", alignBottomBtn: "align-bottom",
  distributeXBtn: "distribute-x", distributeYBtn: "distribute-y",
  layerFrontBtn: "front", layerForwardBtn: "forward", layerBackwardBtn: "backward", layerBackBtn: "back",
  hideObjectsBtn: "hide", lockObjectsBtn: "lock",
};
function arrangementTools() {
  const count = selectedElements.length, unavailable = !frameReady || objectBusy;
  const editable = count > 0 && !selectedElements.some(item => objectLocked(item.id));
  const precise = editable && !selectedElements.some(item => item.precisionReason);
  const layers = selectedElements.map(item => layerItems.find(layer => layer.id === item.id));
  const layerable = editable && layers.every(item => item?.layerable) && new Set(layers.map(item => item?.group)).size === 1;
  $("selectionCount").textContent = count ? `${count}개 선택` : "선택 없음";
  for (const [id, name] of Object.entries(arrangementCommands)) {
    const enabled = name.startsWith("align-") ? precise && count >= 2
      : name.startsWith("distribute-") ? precise && count >= 3
      : ["front", "forward", "backward", "back"].includes(name) ? layerable
      : name === "group" ? precise && count >= 2 && layerable && selectedElements.every(item => nativeAdded(item.id) && item.groupable !== false)
      : name === "ungroup" ? precise && count === 1 && nativeAdded(selected?.id)?.kind === "group"
      : editable;
    $(id).disabled = unavailable || !enabled;
  }
  $("pasteObjectsBtn").disabled = unavailable || !objectClipboard || objectClipboard.deckId !== deck?.id;
}
function renderLayers() {
  const list = $("layerList");
  list.replaceChildren();
  const groups = new Map();
  layerItems.forEach((item, order) => {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push({ ...item, order });
  });
  let groupNumber = 0;
  for (const items of groups.values()) {
    groupNumber++;
    if (groups.size > 1) list.append(el("div", `묶음 ${groupNumber}`, "layer-group"));
    items.sort((a, b) => b.z - a.z || b.order - a.order);
    for (const item of items) {
      const isSelected = selectedElements.some(s => s.id === item.id);
      const row = el("div", undefined, "layer-row" + (isSelected ? " selected" : "") + (item.hidden ? " is-hidden" : ""));
      row.dataset.layerId = item.id;
      const choose = el("button", item.label || item.tag.toUpperCase(), "layer-select");
      choose.dataset.layerAction = "select";
      choose.title = `${item.label || item.tag}${item.hidden ? " · 숨김" : ""}${item.locked ? " · 잠금" : ""}`;
      choose.setAttribute("aria-pressed", String(isSelected));
      choose.onclick = action(event => {
        if (!activeElement(item.id)) return;
        let ids = [item.id];
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          const current = selectedElements.map(s => s.id);
          ids = current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id];
        }
        post("select-ids", { ids });
        frame.focus();
      });
      row.append(choose);
      for (const [key, on, off] of [["hidden", "숨김", "표시"], ["locked", "잠금", "해제"]]) {
        const toggle = el("button", item[key] ? on : off);
        toggle.dataset.layerAction = key;
        toggle.title = key === "hidden" ? (item.hidden ? "개체 표시" : "개체 숨기기") : (item.locked ? "잠금 해제" : "개체 잠금");
        toggle.setAttribute("aria-label", `${item.label || item.tag} ${toggle.title}`);
        toggle.setAttribute("aria-pressed", String(!!item[key]));
        toggle.onclick = action(() => {
          if (activeElement(item.id)) post("layer-toggle", { id: item.id, key });
        });
        row.append(toggle);
      }
      list.append(row);
    }
  }
  if (!layerItems.length) list.append(el("p", frameReady ? "이 슬라이드에 편집할 개체가 없습니다." : "개체를 불러오는 중입니다.", "tool-help"));
  arrangementTools();
}
function objectContext() {
  return { deckId: deck?.id, slide: state?.order[index], session: editorSession };
}
function currentObjectContext(context) {
  return !!deck && deck.id === context.deckId && state.order[index] === context.slide && editorSession === context.session;
}
function queueObjectWork(context, fn, restoreOnFailure = false) {
  const work = objectWork.then(async () => {
    if (!currentObjectContext(context)) return;
    objectBusy = true;
    arrangementTools();
    try { await fn(); }
    catch (error) {
      if (currentObjectContext(context)) {
        toast(error.message);
        if (restoreOnFailure) {
          try {
            // A concurrent single-object edit may still be dirty: reload its saved revision.
            await flush();
            if (currentObjectContext(context)) refreshFrame(selectedElements.map(item => item.id));
          } catch (saveError) { toast(`${error.message} 현재 편집 저장도 실패했습니다: ${saveError.message}`); }
        }
      }
    } finally { objectBusy = false; arrangementTools(); }
  });
  objectWork = work;
  return work;
}
async function validateObjectState(candidate, context) {
  const epoch = editEpoch;
  const result = await api(`/decks/${context.deckId}/validate`, "POST", { state: candidate });
  if (!currentObjectContext(context)) return null;
  if (editEpoch !== epoch) throw new Error("검증 중 다른 편집이 적용되었습니다. 명령을 다시 실행해 주세요.");
  return clone(result.state);
}
function receiveBatch(changes, deleted = false) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 2000) return;
  const seen = new Set();
  for (const change of changes) {
    if (!change || !activeElement(change.id) || seen.has(change.id) ||
      !change.patch || typeof change.patch !== "object" || Array.isArray(change.patch) ||
      // Reordering one sibling renumbers the container's z indices, including locked siblings.
      (objectLocked(change.id) && Object.keys(change.patch).some(key => !["locked", "hidden", "z", "layerPosition"].includes(key)))) return;
    seen.add(change.id);
  }
  const context = objectContext();
  queueObjectWork(context, async () => {
    const candidate = clone(state);
    for (const { id, patch: value } of changes) candidate.patches[id] = { ...(candidate.patches[id] || {}), ...value };
    if (deleted) detachPlaceholders(candidate, changes.filter(change => change.patch.hidden === true).map(change => change.id));
    const validated = await validateObjectState(candidate, context);
    if (!validated) return;
    checkpoint();
    state = validated;
    mark();
    properties();
  }, true);
}
function receiveObjects(operation, objects, context = objectContext()) {
  if (!["copy", "duplicate", "paste"].includes(operation) || !Array.isArray(objects) || !objects.length || objects.length > 2000) return;
  return queueObjectWork(context, async () => {
    const candidate = clone(state), ids = [];
    for (const object of objects) {
      if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error("복사할 개체 정보를 확인해 주세요.");
      const copy = { ...clone(object), id: uid("a"), slide: context.slide };
      if (operation !== "copy") { copy.x = (copy.x ?? 0) + 24; copy.y = (copy.y ?? 0) + 24; }
      ids.push(copy.id);
      candidate.added.push(copy);
    }
    const validated = await validateObjectState(candidate, context);
    if (!validated) return;
    if (operation === "copy") {
      objectClipboard = { deckId: context.deckId, objects: validated.added.filter(item => ids.includes(item.id)).map(item => {
        const copy = clone(item); delete copy.id; delete copy.slide; return copy;
      }) };
      toast(`${objects.length}개 개체를 복사했습니다. 이 자료의 다른 슬라이드에도 붙여넣을 수 있습니다.`);
      return;
    }
    checkpoint();
    state = validated;
    mark();
    await flush();
    if (!currentObjectContext(context)) return;
    renderSlides();
    refreshFrame(ids);
  });
}
function receiveStructure(operation, removeIds, objects) {
  if (!["group", "ungroup"].includes(operation) || !Array.isArray(removeIds) || !Array.isArray(objects) || !removeIds.length || new Set(removeIds).size !== removeIds.length) return;
  const matchesSelection = () => removeIds.length === selectedElements.length && removeIds.every(id => selectedElements.some(s => s.id === id) && nativeAdded(id) && !objectLocked(id));
  if (!matchesSelection()) return;
  if (operation === "group" && (removeIds.length < 2 || objects.length !== 1 || objects[0]?.kind !== "group" || objects[0]?.group?.children?.length !== removeIds.length)) return;
  if (operation === "ungroup" && (removeIds.length !== 1 || nativeAdded(removeIds[0])?.kind !== "group" || objects.length !== nativeAdded(removeIds[0]).group.children.length)) return;
  const context = objectContext(), previousStatus = $("saveStatus").textContent, processingStatus = "개체 적용 중…";
  $("saveStatus").textContent = processingStatus;
  return queueObjectWork(context, async () => {
    if (!matchesSelection()) return;
    const sourceLayers = layerItems.filter(item => removeIds.includes(item.id));
    if (sourceLayers.length !== removeIds.length || new Set(sourceLayers.map(item => item.group)).size !== 1 || sourceLayers.some(item => item.hidden || !item.layerable)) return;
    const candidate = clone(state), ids = [], replacements = [];
    const orderedObjects = operation === "ungroup" ? [...objects].sort((a, b) => (a.z ?? 20) - (b.z ?? 20)) : objects;
    for (const snapshot of orderedObjects) {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !["text", "image", "shape", "group"].includes(snapshot.kind)) throw new Error("그룹 개체 정보를 확인해 주세요.");
      const object = { ...clone(snapshot), id: uid("a"), slide: context.slide };
      ids.push(object.id); replacements.push(object);
    }
    candidate.added = candidate.added.filter(a => !removeIds.includes(a.id));
    for (const id of removeIds) delete candidate.patches[id];
    detachPlaceholders(candidate, removeIds);
    candidate.added.push(...replacements);
    // Keep the group's position at its highest source; expand children in place.
    const siblings = layerItems.filter(item => item.group === sourceLayers[0].group).sort((a, b) => a.z - b.z);
    const anchor = siblings.findLast(item => removeIds.includes(item.id)).id;
    const order = siblings.flatMap(item => item.id === anchor ? replacements : removeIds.includes(item.id) ? [] : [item]);
    order.forEach((item, position) => {
      const z = position + 1;
      if (ids.includes(item.id)) item.z = z;
      else candidate.patches[item.id] = { ...(candidate.patches[item.id] || {}), z, ...(item.position === "static" ? { layerPosition: "relative" } : {}) };
    });
    const validated = await validateObjectState(candidate, context);
    if (!validated || !matchesSelection()) return;
    checkpoint(); state = validated; mark(); await flush();
    if (currentObjectContext(context)) { renderSlides(); refreshFrame(ids); }
  }).finally(() => {
    properties();
    if ($("saveStatus").textContent === processingStatus) $("saveStatus").textContent = previousStatus;
  });
}
function pasteObjects() {
  if (!objectClipboard || objectClipboard.deckId !== deck?.id) return;
  return receiveObjects("paste", clone(objectClipboard.objects));
}
for (const [id, name] of Object.entries(arrangementCommands))
  $(id).onclick = action(() => { if (!$(id).disabled) post("command", { name }); });
$("pasteObjectsBtn").onclick = action(pasteObjects);
function slideTitle(id) {
  const titleId = state.slideLayouts?.[id]?.placeholders.title;
  if (titleId) {
    const title = { ...state.added.find(a => a.id === titleId), ...state.patches[titleId] };
    const text = title.richText ? SDText.plainText(title.richText) : title.text;
    if (text?.trim()) return text.trim().slice(0, 100);
  }
  const source = state.clones[id] ?? id;
  const s = deck.slides.find((s) => s.id === source);
  return s?.title || "빈 슬라이드";
}
function renderSlides() {
  index = Math.max(0, Math.min(index, state.order.length - 1));
  window.SDSlideUI?.render();
  $("slideLabel").textContent = `${index + 1} / ${state.order.length}`;
  $("backgroundValue").checked = state.background;
  const scene = $("sceneValue");
  scene.replaceChildren(el("option", "원본 유지"));
  scene.firstChild.value = "";
  for (const v of new Set(deck.slides.map((s) => s.scene).filter(Boolean))) {
    const o = el("option", v);
    o.value = v;
    scene.append(o);
  }
  scene.value = state.scenes[state.order[index]] || "";
  transitionTools();
}
window.addEventListener("message", (e) => {
  if (
    !deck ||
    e.source !== frame.contentWindow ||
    e.origin !== new URL(deck.previewUrl).origin ||
    !e.data?.studio
  )
    return;
  const d = e.data;
  if (d.editorSession && d.editorSession !== editorSession) return;
  if (["select", "change", "batch-change", "layers", "objects", "object-structure", "paste"].includes(d.type) &&
    d.slide !== undefined && d.slide !== state.order[index]) return;
  if (d.type === "pan" && Number.isFinite(d.dx) && Number.isFinite(d.dy)) {
    $("canvasViewport").scrollBy(d.dx, d.dy);
    return;
  }
  if (d.type === "edit-settled") {
    pendingEdits.get(d.requestId)?.();
    pendingEdits.delete(d.requestId);
    return;
  }
  if (d.type === "text-command-result") {
    pendingTextCommands.get(d.requestId)?.finish(typeof d.error === "string" ? d.error : undefined);
    return;
  }
  if (d.type === "select") {
    const elements = Array.isArray(d.elements) ? d.elements : d.element ? [d.element] : [];
    if (elements.some(item => !item || !activeElement(item.id)) || new Set(elements.map(item => item.id)).size !== elements.length) return;
    const single = elements.length === 1 ? elements[0] : null;
    if (single?.id !== selected?.id) $("lockAspect").checked = false;
    selectedElements = elements;
    selected = single;
    properties();
    renderLayers();
  }
  if (d.type === "change" && activeElement(d.id) && d.patch && typeof d.patch === "object" && !Array.isArray(d.patch)) {
    if (objectLocked(d.id) && Object.keys(d.patch).some(key => !["locked", "hidden"].includes(key))) return;
    checkpoint();
    state.patches[d.id] = { ...(state.patches[d.id] || {}), ...d.patch };
    mark();
  }
  if (d.type === "batch-change" && frameReady) receiveBatch(d.changes, d.operation === "delete");
  if (d.type === "layers" && Array.isArray(d.items)) {
    if (d.items.some(item => !item || !activeElement(item.id))) return;
    layerItems = d.items;
    properties();
    renderLayers();
  }
  if (d.type === "objects" && frameReady && d.slide === state.order[index]) receiveObjects(d.operation, d.objects);
  if (d.type === "object-structure" && frameReady && d.slide === state.order[index]) receiveStructure(d.operation, d.removeIds, d.objects);
  if (d.type === "paste" && frameReady) action(pasteObjects)();
  if (d.type === "notice" && typeof d.message === "string") toast(d.message);
  if (d.type === "navigate" && Number.isInteger(d.index)) {
    if (d.index < 0 || d.index >= state.order.length) return;
    if (index !== d.index) {
      clearSelection();
      layerItems = [];
      renderLayers();
    }
    index = d.index;
    renderSlides();
  }
  if (d.type === "ready") {
    frameReady = true;
    post("go", { index });
    if (pendingSelection.length) post("select-ids", { ids: pendingSelection });
    pendingSelection = [];
    arrangementTools();
  }
  if (d.type === "undo" || d.type === "redo")
    performHistory(d.type === "undo");
});
async function openDeck(id) {
  if (deck) await flush();
  if (objectClipboard?.deckId !== id) objectClipboard = null;
  deck = await api("/decks/" + id);
  state = clone(deck.state);
  dirty = false;
  blocked = false;
  undo = [];
  redo = [];
  index = 0;
  window.SDSlideUI?.reset();
  $("library").hidden = true;
  $("editor").hidden = false;
  layoutCanvas();
  $("deckTitle").value = deck.title;
  $("saveStatus").textContent = `저장됨 · v${deck.revision}`;
  location.hash = "deck=" + id;
  renderSlides();
  refreshFrame();
}
async function library() {
  if (deck) await flush();
  deck = null;
  frameReady = false;
  editorSession = null;
  pendingSelection = [];
  layerItems = [];
  clearSelection();
  frame.src = "about:blank";
  $("editor").hidden = true;
  $("library").hidden = false;
  location.hash = "";
  decks = await api("/decks");
  renderLibrary();
}
function renderLibrary() {
  if (folder && !decks.some((d) => !d.deleted && d.folder === folder))
    folder = "";
  const selectNav = (button, active) => {
    button.classList.toggle("selected", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  };
  selectNav($("allBtn"), filter === "all" && !folder);
  selectNav($("trashBtn"), filter === "trash");
  const search = $("search").value.toLowerCase();
  const visible = decks.filter(
    (d) =>
      (filter === "trash" ? d.deleted : !d.deleted) &&
      (!folder || d.folder === folder) &&
      (!search || (d.title + " " + d.folder).toLowerCase().includes(search)),
  );
  $("deckCount").textContent = `${visible.length}개의 자료`;
  $("libraryTitle").textContent =
    filter === "trash" ? "휴지통" : folder || "나의 발표 자료";
  $("empty").hidden = visible.length > 0 || filter === "trash";
  const grid = $("deckGrid");
  grid.replaceChildren();
  for (const d of visible) {
    const card = el("article", undefined, "deck-card");
    const cover = el("div", undefined, "cover");
    const preview = el("iframe");
    preview.title = d.title + " 표지";
    preview.setAttribute("sandbox", "allow-scripts allow-same-origin");
    preview.loading = "lazy";
    preview.src = d.previewUrl;
    cover.append(preview);
    cover.onclick = action(() => openDeck(d.id));
    new ResizeObserver(
      (entries) =>
        (preview.style.transform = `scale(${entries[0].contentRect.width / 1920})`),
    ).observe(cover);
    const info = el("div", undefined, "deck-info");
    const name = el("button", d.title, "deck-name");
    name.onclick = action(() => openDeck(d.id));
    info.append(name);
    const meta = el("div", undefined, "deck-meta");
    meta.append(
      el("span", `${d.folder || "분류 없음"} · ${d.slides.length}장`),
      el("span", new Date(d.updatedAt).toLocaleDateString("ko-KR")),
    );
    info.append(meta);
    const actions = el("div", undefined, "deck-actions");
    for (const [text, fn] of d.deleted
      ? [
          [
            "복원",
            async () => {
              await api("/decks/" + d.id, "PATCH", { deleted: false });
              await library();
            },
          ],
          [
            "완전 삭제",
            async () => {
              if (
                !confirm(
                  `「${d.title}」 자료를 완전히 삭제할까요?\n원본 파일과 모든 저장 이력이 삭제되며 복구할 수 없습니다.`,
                )
              )
                return;
              await api("/decks/" + d.id, "DELETE");
              await library();
              toast("자료를 완전히 삭제했습니다.");
            },
          ],
        ]
      : [
          ["편집", () => openDeck(d.id)],
          [
            "복제",
            async () => {
              await api("/decks/" + d.id + "/duplicate", "POST", {});
              await library();
            },
          ],
          [
            "폴더",
            async () => {
              const name = prompt("폴더 이름", d.folder);
              if (name !== null) {
                await api("/decks/" + d.id, "PATCH", { folder: name });
                await library();
              }
            },
          ],
          [
            "휴지통",
            async () => {
              await api("/decks/" + d.id, "PATCH", { deleted: true });
              await library();
            },
          ],
        ]) {
      const b = el("button", text);
      if (text === "완전 삭제") b.classList.add("danger-text");
      b.onclick = action(fn);
      actions.append(b);
    }
    const filesButton = el("button", "파일 관리");
    filesButton.onclick = action(() => showFiles(d.id));
    actions.append(filesButton);
    info.append(actions);
    card.append(cover, info);
    grid.append(card);
  }
  const folders = $("folders");
  folders.replaceChildren();
  for (const f of new Set(
    decks
      .filter((d) => !d.deleted)
      .map((d) => d.folder)
      .filter(Boolean),
  )) {
    const b = el("button", "▱ " + f, "nav-item");
    selectNav(b, filter === "all" && folder === f);
    b.onclick = () => {
      folder = f;
      filter = "all";
      renderLibrary();
    };
    folders.append(b);
  }
}
async function importZip(file) {
  $("busyOverlay").hidden = false;
  try {
    const d = await api("/decks", "POST", file);
    await openDeck(d.id);
    toast("발표 자료를 가져왔습니다.");
  } finally {
    $("busyOverlay").hidden = true;
    $("zipInput").value = "";
    $("folderInput").value = "";
  }
}
$("zipInput").onchange = action(
  (e) => e.target.files[0] && importZip(e.target.files[0]),
);
$("folderInput").onchange = action(async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  if (
    files.length > 300 ||
    files.reduce((n, f) => n + f.size, 0) > 64 * 1024 * 1024
  )
    throw new Error("폴더는 300개 파일, 64MB까지 올릴 수 있습니다.");
  const zip = new JSZip();
  for (const f of files) zip.file(f.webkitRelativePath, await f.arrayBuffer());
  await importZip(
    await zip.generateAsync({ type: "blob", compression: "DEFLATE" }),
  );
});
for (const id of ["uploadBtn", "emptyUpload"])
  $(id).onclick = () => $("zipInput").click();
for (const id of ["folderBtn", "folderUploadBtn"])
  $(id).onclick = () => $("folderInput").click();
$("newBtn").onclick = action(async () =>
  openDeck((await api("/new", "POST", {})).id),
);
$("homeBtn").onclick = $("libraryBtn").onclick = action(library);
$("allBtn").onclick = () => {
  filter = "all";
  folder = "";
  renderLibrary();
};
$("trashBtn").onclick = () => {
  filter = "trash";
  folder = "";
  renderLibrary();
};
$("search").oninput = renderLibrary;
$("deckTitle").onchange = action(async () => {
  const title = $("deckTitle").value.trim();
  if (!title) throw new Error("제목을 입력해 주세요.");
  await api("/decks/" + deck.id, "PATCH", { title });
  deck.title = title;
});
$("textValue").onchange = () => textCommand("text-replace", { text: $("textValue").value });
for (const [id, key] of [
  ["xValue", "x"],
  ["yValue", "y"],
  ["wValue", "w"],
  ["hValue", "h"],
  ["rotateValue", "rotate"],
])
  $(id).onchange = () => {
    const v = Number($(id).value);
    if ($(id).checkValidity() && $(id).value !== "") {
      const change = { [key]: v };
      if (selected && ($("lockAspect").checked || nativeAdded(selected.id)?.kind === "group") && ["w", "h"].includes(key)) {
        const other = key === "w" ? "h" : "w";
        const extra = key === "w" ? selected.extraW || 0 : selected.extraH || 0;
        const otherExtra = key === "w" ? selected.extraH || 0 : selected.extraW || 0;
        change[other] = Math.round(((selected[other] + otherExtra) * (v + extra) / (selected[key] + extra) - otherExtra) * 100) / 100;
        const group = nativeAdded(selected.id)?.group;
        if (group) change[other] = v * group[other === "w" ? "width" : "height"] / group[key === "w" ? "width" : "height"];
        if (change[other] < 1 || change[other] > 5000) { toast("비율을 유지한 크기는 1~5000 범위여야 합니다."); properties(); return; }
      }
      patch(change);
    }
    else toast("입력 범위를 확인해 주세요.");
  };
for (const [id, scope, key] of [
  ["fontValue", "character", "fontSize"], ["lineHeightValue", "paragraph", "lineHeight"],
  ["spaceAfterValue", "paragraph", "spaceAfter"],
]) $(id).onchange = () => {
  if (!editableText()) return;
  const control = $(id), value = control.value;
  if (value === "" || !control.checkValidity()) { toast("입력 범위를 확인해 주세요."); return; }
  textFormat(scope, { [key]: Number(value) });
};
$("fontFamilyValue").onchange = () => {
  const value = $("fontFamilyValue").value.trim();
  if (!value || !$("fontFamilyValue").checkValidity()) { if (editableText()) toast("글꼴 이름을 입력해 주세요."); return; }
  textFormat("character", { fontFamily: value });
};
$("colorValue").onchange = () => textFormat("character", { color: $("colorValue").value });
for (const [id, key] of [["boldTextBtn", "bold"], ["italicTextBtn", "italic"], ["underlineTextBtn", "underline"]])
  $(id).onclick = () => textFormat("character", { [key]: selected?.textStyle?.[key] !== true });
for (const [id, scope, key] of [
  ["textAlignValue", "paragraph", "align"], ["listStyleValue", "paragraph", "list"],
  ["verticalAlignValue", "box", "vertical"], ["textOverflowValue", "box", "overflow"],
  ["textAutoFitValue", "box", "autoFit"],
]) $(id).onchange = () => textFormat(scope, { [key]: $(id).value });
for (const [id, delta] of [["outdentTextBtn", -1], ["indentTextBtn", 1]])
  $(id).onclick = () => {
    if ($(id).disabled) return;
    textFormat("paragraph", { indent: Math.max(0, Math.min(8, (selected?.textStyle?.indent ?? 0) + delta)) });
  };
$("fillValue").onchange = () => patch({ fill: $("fillValue").value });
$("imageModeValue").onchange = () => visualPatch("image", { mode: $("imageModeValue").value });
for (const side of ["Left", "Right", "Top", "Bottom"]) $("crop" + side + "Value").onchange = () => {
  const control = $("crop" + side + "Value");
  if (control.value === "" || !control.checkValidity()) { toast("자르기는 0~99% 범위로 입력해 주세요."); visualProperties(); return; }
  const current = globalThis.SDObjects.normalizeImage(state.patches[selected?.id]?.image || selected?.image);
  visualPatch("image", { crop: { ...current.crop, [side.toLowerCase()]: Number(control.value) / 100 } });
};
$("resetCropBtn").onclick = () => visualPatch("image", { crop: { left: 0, right: 0, top: 0, bottom: 0 } });
for (const [id, key] of [["shapeTypeValue", "type"], ["shapeFillValue", "fill"], ["shapeStrokeValue", "stroke"], ["shapeDashValue", "dash"]])
  $(id).onchange = () => visualPatch("shape", { [key]: $(id).value });
$("shapeStrokeWidthValue").onchange = () => {
  const control = $("shapeStrokeWidthValue");
  if (control.value === "" || !control.checkValidity()) { toast("테두리는 0~40px 범위로 입력해 주세요."); visualProperties(); return; }
  visualPatch("shape", { strokeWidth: Number(control.value) });
};
$("shapeNoFillValue").onchange = () => visualPatch("shape", { fill: $("shapeNoFillValue").checked ? "none" : $("shapeFillValue").value });
$("removeElementBtn").onclick = action(() => patch({ hidden: true }, true));
$("undoBtn").onclick = () => performHistory(true);
$("redoBtn").onclick = () => performHistory(false);
$("addTextBtn").onclick = action(() =>
  structural(() =>
    state.added.push({
      id: uid("a"),
      slide: state.order[index],
      kind: "text",
      text: "새로운 내용",
      x: 150,
      y: 160,
      w: 700,
      h: 120,
      color: "#ffffff",
      fontSize: 48,
    }),
  ),
);
$("addShapeBtn").onclick = action(() => {
  const body = dialog("도형 추가"), choices = el("div", undefined, "shape-picker");
  for (const [type, label] of [["rect", "□ 사각형"], ["ellipse", "○ 원·타원"], ["line", "╱ 선"], ["arrow", "↗ 화살표"]]) {
    const button = el("button", label);
    button.dataset.shapeType = type;
    button.onclick = transitionAction(async () => {
      $("dialog").close();
      await structural(() => state.added.push({ id: uid("a"), slide: state.order[index], kind: "shape", x: 150, y: 300, w: 420, h: 200,
        shape: { type, fill: ["line", "arrow"].includes(type) ? "none" : "#087e77", stroke: "#087e77", strokeWidth: 3, dash: "solid" } }));
    }, "도형 추가 중…");
    choices.append(button);
  }
  body.append(choices);
});
$("addImageBtn").onclick = () => {
  replaceImage = false;
  $("imageInput").click();
};
$("replaceImageBtn").onclick = () => {
  if (!selected || objectLocked(selected.id)) return;
  replaceImage = true;
  $("imageInput").click();
};
$("imageInput").onchange = action(async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = await fetch(
    `/api/decks/${deck.id}/assets?name=${encodeURIComponent(f.name)}`,
    { method: "POST", body: f },
  );
  const b = await r.json();
  if (!r.ok) throw new Error(b.error);
  if (replaceImage && selected) patch({ src: b.src, ...(nativeAdded(selected.id)?.kind === "image" ? { image: globalThis.SDObjects.normalizeImage({ mode: selected.image?.mode || "fit" }) } : {}) });
  else
    await structural(() =>
      state.added.push({
        id: uid("a"),
        slide: state.order[index],
        kind: "image",
        src: b.src,
        image: globalThis.SDObjects.normalizeImage({ mode: "fit" }),
        x: 150,
        y: 200,
        w: 640,
        h: 400,
      }),
    );
  e.target.value = "";
});
$("backgroundValue").onchange = (e) => {
  const checked = e.target.checked;
  return action(() => structural(() => (state.background = checked)))();
};
$("sceneValue").onchange = (e) => {
  if (transitionBusy) return;
  const value = e.target.value, slide = state.order[index];
  return action(() => structural(() => {
    if (value) state.scenes[slide] = value;
    else delete state.scenes[slide];
  }))();
};
$("previewBtn").onclick = action(async () => {
  const win = window.open("about:blank", "_blank");
  await flush();
  if (win) win.location = deck.previewUrl + "#" + (index + 1);
});
$("versionsBtn").onclick = action(async () => {
  await flush();
  const rows = await api("/decks/" + deck.id + "/revisions");
  const body = dialog("저장 버전");
  body.append(el("p", "이전 버전을 복원해도 현재 버전은 기록에 남습니다."));
  for (const r of rows) {
    const row = el("div", undefined, "version-row");
    row.append(
      el(
        "span",
        `v${r.revision} · ${new Date(r.savedAt).toLocaleString("ko-KR")}`,
      ),
    );
    const b = el("button", r.revision === deck.revision ? "현재 버전" : "복원");
    b.disabled = r.revision === deck.revision;
    b.onclick = action(async () => {
      const d = await api("/decks/" + deck.id + "/restore", "POST", {
        target: r.revision,
        revision: deck.revision,
      });
      $("dialog").close();
      deck = d;
      state = clone(d.state);
      dirty = false;
      undo = [];
      redo = [];
      refreshFrame();
      renderSlides();
      $("saveStatus").textContent = `저장됨 · v${d.revision}`;
      toast("이전 버전을 복원했습니다.");
    });
    row.append(b);
    body.append(row);
  }
});
$("shareBtn").onclick = action(async () => {
  await flush();
  const body = dialog("발표 자료 공유");
  body.append(
    el(
      "p",
      "게시한 버전만 공유합니다. 이후 편집 내용은 다시 게시할 때 반영됩니다. 링크를 가진 사람은 누구나 볼 수 있습니다.",
    ),
  );
  if (deck.shareUrl) {
    const input = el("input");
    input.value = deck.shareUrl;
    input.readOnly = true;
    input.onclick = () => input.select();
    body.append(input, el("p", `현재 공유 버전: v${deck.publishedRevision}`));
  }
  const publish = el(
    "button",
    deck.shareUrl ? "최신 저장 버전으로 다시 게시" : "공유 링크 만들기",
    "primary",
  );
  publish.onclick = action(async () => {
    deck = {
      ...deck,
      ...(await api("/decks/" + deck.id + "/publish", "POST", {
        enabled: true,
      })),
    };
    $("dialog").close();
    $("shareBtn").click();
  });
  body.append(publish);
  if (deck.shareUrl) {
    const stop = el("button", "공유 종료");
    stop.style.marginLeft = "8px";
    stop.onclick = action(async () => {
      deck = {
        ...deck,
        ...(await api("/decks/" + deck.id + "/publish", "POST", {
          enabled: false,
        })),
      };
      $("dialog").close();
      toast("기존 공유 링크를 종료했습니다.");
    });
    body.append(stop);
  }
});
$("exportBtn").onclick = action(async () => {
  await flush();
  const body = dialog("발표 자료 다운로드");
  body.append(
    el(
      "p",
      `저장된 v${deck.revision}에서 파일을 만듭니다. PDF·PPTX의 3D 배경은 정지 화면으로 출력됩니다.`,
    ),
  );
  for (const [format, title, detail] of [
    [
      "html",
      "웹 발표 · HTML ZIP",
      "이미지·글꼴·Three.js를 포함합니다. 압축을 풀고 index.html을 여세요.",
    ],
    ["pdf", "PDF", "슬라이드 비율을 유지한 여백 없는 문서"],
    ["pptx", "PowerPoint · 외형 보존", "슬라이드 전체를 이미지로 저장합니다."],
    [
      "pptx-editable",
      "PowerPoint · 편집 가능",
      "지원되는 글과 이미지를 분리합니다. 복잡한 효과는 배경으로 합성되며 글꼴·줄바꿈은 달라질 수 있습니다.",
    ],
  ]) {
    const b = el("button", title, "export-option");
    b.append(el("small", detail));
    b.onclick = action(async () => {
      body.querySelectorAll("button").forEach((e) => (e.disabled = true));
      const status = el("p", "파일을 만드는 중입니다…");
      body.append(status);
      try {
        const job = await api("/decks/" + deck.id + "/export", "POST", {
          format,
          revision: deck.revision,
        });
        for (;;) {
          await new Promise((r) => setTimeout(r, 1200));
          const j = await api("/jobs/" + job.id);
          if (j.status === "error") throw new Error(j.error);
          if (j.status === "done") {
            status.textContent = `v${j.revision} 파일이 준비되었습니다.`;
            const a = el("a", "파일 내려받기");
            a.href = "/api/jobs/" + job.id + "/download";
            a.className = "primary";
            a.download = "";
            body.append(a);
            a.click();
            break;
          }
        }
      } finally {
        body.querySelectorAll("button").forEach((e) => (e.disabled = false));
      }
    });
    body.append(b);
  }
});
const formatBytes = (n) =>
  n >= 1024 * 1024
    ? (n / 1024 / 1024).toFixed(2) + " MB"
    : n >= 1024
      ? (n / 1024).toFixed(1) + " KB"
      : n + " B";
async function showFiles(id) {
  if (deck?.id === id) await flush();
  const info = await api("/decks/" + id + "/files");
  const body = dialog("저장 파일 관리");
  $("dialog").classList.add("files-dialog");
  body.append(
    el(
      "p",
      "업로드 ZIP 자체는 보관하지 않습니다. 압축을 푼 웹 원본과 수정 이력을 저장합니다.",
    ),
  );
  body.append(
    el(
      "strong",
      `${info.files.length}개 파일 · 총 ${formatBytes(info.totalBytes)} (웹 파일 ${formatBytes(info.assetBytes)} / 수정 이력 ${formatBytes(info.revisionBytes)})`,
      "file-summary",
    ),
  );
  const source = el("a", "원본 파일 묶음 ZIP 다운로드");
  source.href = "/api/decks/" + id + "/source";
  source.download = "";
  body.append(
    source,
    el(
      "p",
      "원본 묶음은 업로드 당시 HTML과 현재 보관 중인 자산입니다. 편집 결과는 발표 자료 다운로드에서 HTML ZIP을 선택하세요. 원본과 이전 버전에서 쓰는 파일은 보호합니다. 자료 전체는 휴지통에서 완전 삭제할 수 있습니다.",
    ),
  );
  const list = el("div", undefined, "file-list");
  for (const file of info.files) {
    const row = el("div", undefined, "file-row");
    const details = el("div");
    details.append(
      el("strong", file.path),
      el("small", `${formatBytes(file.bytes)} · ${file.reason}`),
    );
    const controls = el("div", undefined, "actions");
    const download = el("a", "다운로드");
    download.href =
      "/api/decks/" + id + "/files?path=" + encodeURIComponent(file.path);
    download.download = "";
    const remove = el("button", "삭제", "danger-text");
    remove.disabled = !file.canDelete;
    remove.title = file.reason;
    remove.onclick = action(async () => {
      if (
        !confirm(
          `「${file.path}」 파일을 완전히 삭제할까요? 복구할 수 없습니다.`,
        )
      )
        return;
      remove.disabled = true;
      try {
        await api("/decks/" + id + "/files", "DELETE", { path: file.path });
        await showFiles(id);
        toast("사용하지 않는 파일을 삭제했습니다.");
      } catch (e) {
        remove.disabled = false;
        throw e;
      }
    });
    controls.append(download, remove);
    row.append(details, controls);
    list.append(row);
  }
  body.append(list);
}
$("filesBtn").onclick = action(() => showFiles(deck.id));
$("dialog").addEventListener("close", () =>
  $("dialog")
    .querySelectorAll('input[type="password"]')
    .forEach((e) => (e.value = "")),
);
$("passwordBtn").onclick = action(async () => {
  if (deck) await flush();
  const body = dialog("비밀번호 변경");
  body.append(
    el(
      "p",
      "현재 비밀번호를 확인한 후 변경합니다. 변경하면 다른 로그인 세션이 만료됩니다.",
    ),
  );
  const form = el("form");
  form.id = "passwordForm";
  for (const [id, title, autocomplete] of [
    ["currentPassword", "현재 비밀번호", "current-password"],
    ["newPassword", "새 비밀번호 (12~128자)", "new-password"],
    ["confirmPassword", "새 비밀번호 확인", "new-password"],
  ]) {
    const label = el("label", title),
      input = el("input");
    input.id = id;
    input.type = "password";
    input.required = true;
    input.autocomplete = autocomplete;
    input.maxLength = 128;
    if (id !== "currentPassword") input.minLength = 12;
    label.append(input);
    form.append(label);
  }
  const error = el("p");
  error.id = "passwordError";
  error.setAttribute("role", "alert");
  const submit = el("button", "비밀번호 변경", "primary");
  submit.type = "submit";
  form.append(error, submit);
  body.append(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    error.textContent = "";
    if ($("newPassword").value !== $("confirmPassword").value) {
      error.textContent = "새 비밀번호가 일치하지 않습니다.";
      return;
    }
    submit.disabled = true;
    try {
      await api("/password", "POST", {
        currentPassword: $("currentPassword").value,
        newPassword: $("newPassword").value,
      });
      $("dialog").close();
      toast("비밀번호를 변경했습니다. 다른 로그인 세션은 종료되었습니다.");
    } catch (e) {
      error.textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  };
});
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/login", "POST", { password: $("password").value });
    $("password").value = "";
    await boot();
  } catch (e) {
    $("loginError").textContent = e.message;
  }
};
$("logoutBtn").onclick = action(async () => {
  if (deck) await flush();
  await api("/logout", "POST", {});
  location.reload();
});
window.addEventListener("beforeunload", (e) => {
  if (dirty || saving || window.authoringHasDraft?.()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("keydown", (e) => {
  if (!deck || transitionBusy || e.isComposing || e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || $("dialog").open) return;
  if (window.SDSlideUI?.keydown(e)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    performHistory(!e.shiftKey);
  } else if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const name = { d: "duplicate", c: "copy", v: "paste", a: "select-all" }[e.key.toLowerCase()];
    if (!name) return;
    e.preventDefault();
    action(() => {
      if (name === "paste") return pasteObjects();
      post("command", { name });
    })();
  }
});
async function boot() {
  try {
    const session = await api("/session");
    $("localBadge").textContent = session.local
      ? "로컬 작업 공간"
      : "개인 자료실";
    $("logoutBtn").hidden = session.local;
    $("passwordBtn").hidden = session.local;
    $("login").hidden = true;
    $("shell").hidden = false;
    const id = /^#deck=([a-f0-9-]{36})$/.exec(location.hash)?.[1];
    if (id) await openDeck(id);
    else await library();
  } catch (e) {
    if (e.status !== 401) toast(e.message);
  }
}
boot();
