/* Slide organization shares the editor's validation, history and revision save path. */
(() => {
  "use strict";
  let selectedIds = new Set(), anchor = null, currentDeck = null, notesCheckpoint = false;
  const rows = new Map(), visible = new Set();
  let dragged = null;
  const list = $("slideList"), notes = $("notesValue");
  const thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const iframe = entry.target.querySelector("iframe");
      if (!iframe) continue;
      if (entry.isIntersecting) {
        visible.add(entry.target);
        if (iframe.getAttribute("src") !== iframe.dataset.url) iframe.src = iframe.dataset.url;
      } else {
        visible.delete(entry.target);
        if (iframe.hasAttribute("src")) iframe.removeAttribute("src");
      }
    }
  }, { root: list, rootMargin: "120px" });
  const thumbSize = new ResizeObserver(entries => {
    for (const { target } of entries) {
      const iframe = target.querySelector("iframe");
      if (iframe) iframe.style.transform = `scale(${target.clientWidth / 1920})`;
    }
  });
  const selection = () => state.order.filter(id => selectedIds.has(id));
  function reset() {
    thumbnailObserver.disconnect(); thumbSize.disconnect();
    rows.clear(); visible.clear(); list.replaceChildren();
    selectedIds.clear(); anchor = null; currentDeck = deck?.id; notesCheckpoint = false;
  }
  function activate(id) {
    if (!state.order.includes(id)) return;
    clearSelection(); layerItems = [];
    index = state.order.indexOf(id);
    post("go", { index }); renderSlides(); renderLayers();
  }
  function choose(id, event) {
    const modifiers = { shift: event.shiftKey, multiple: event.ctrlKey || event.metaKey };
    return transitionAction(() => {
      if (!state.order.includes(id)) return;
      if (modifiers.shift && state.order.includes(anchor)) {
        const a = state.order.indexOf(anchor), b = state.order.indexOf(id);
        const range = state.order.slice(Math.min(a, b), Math.max(a, b) + 1);
        selectedIds = new Set(modifiers.multiple ? [...selectedIds, ...range] : range);
      } else if (modifiers.multiple) {
        if (selectedIds.has(id) && selectedIds.size > 1) selectedIds.delete(id);
        else selectedIds.add(id);
        anchor = id;
      } else { selectedIds = new Set([id]); anchor = id; }
      activate(selectedIds.has(id) ? id : selection()[0]);
    }, "슬라이드 이동 중…")()?.then(() => rows.get(state.order[index])?.focus({ preventScroll: true }));
  }
  function createRow(id) {
    const button = el("button", undefined, "slide-item");
    button.type = "button"; button.dataset.slideId = id; button.draggable = true;
    const thumbnail = el("div", undefined, "slide-thumbnail");
    const iframe = el("iframe");
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.title = "슬라이드 정적 미리보기";
    thumbnail.append(iframe);
    const caption = el("div", undefined, "slide-caption");
    caption.append(el("span", "", "slide-number"), el("div", "", "slide-title"));
    button.append(thumbnail, caption);
    button.onclick = e => choose(id, e);
    button.ondragstart = e => {
      if (transitionBusy) { e.preventDefault(); return; }
      dragged = { deckId: deck.id, ids: selectedIds.has(id) ? selection() : [id], active: id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    };
    button.ondragover = e => {
      if (!dragged || dragged.deckId !== deck?.id || transitionBusy) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      button.classList.toggle("drop-after", e.clientY >= button.getBoundingClientRect().top + button.offsetHeight / 2);
      button.classList.toggle("drop-before", !button.classList.contains("drop-after"));
    };
    button.ondragleave = () => button.classList.remove("drop-after", "drop-before");
    button.ondrop = e => {
      e.preventDefault();
      const drag = dragged, after = e.clientY >= button.getBoundingClientRect().top + button.offsetHeight / 2;
      button.classList.remove("drop-after", "drop-before"); dragged = null;
      if (!drag || drag.deckId !== deck?.id || drag.ids.includes(id)) return;
      transitionAction(async () => {
        const ids = state.order.filter(sid => drag.ids.includes(sid));
        const candidate = clone(state), remaining = candidate.order.filter(sid => !ids.includes(sid));
        const target = remaining.indexOf(id);
        if (target < 0 || !ids.length) return;
        remaining.splice(target + Number(after), 0, ...ids); candidate.order = remaining;
        if (candidate.order.join() !== state.order.join()) await commit(candidate, drag.active, ids);
      }, "슬라이드 순서 변경 중…")();
    };
    button.ondragend = () => {
      dragged = null;
      for (const row of rows.values()) row.classList.remove("drop-after", "drop-before");
    };
    thumbnailObserver.observe(button); thumbSize.observe(thumbnail);
    return button;
  }
  function render() {
    if (!deck || !state) return;
    if (currentDeck !== deck.id) reset();
    index = Math.max(0, Math.min(index, state.order.length - 1));
    const active = state.order[index];
    selectedIds = new Set(selection());
    if (!selectedIds.has(active)) selectedIds = new Set([active]);
    if (!state.order.includes(anchor)) anchor = active;
    for (const [id, row] of rows) {
      if (state.order.includes(id)) continue;
      thumbnailObserver.unobserve(row); thumbSize.unobserve(row.querySelector(".slide-thumbnail"));
      visible.delete(row); row.remove(); rows.delete(id);
    }
    state.order.forEach((id, i) => {
      let row = rows.get(id);
      if (!row) { row = createRow(id); rows.set(id, row); }
      // Keep iframes connected on selection changes; reorder only changed positions.
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
      row.classList.toggle("selected", selectedIds.has(id));
      row.classList.toggle("active-slide", id === active);
      row.setAttribute("aria-pressed", String(selectedIds.has(id)));
      if (id === active) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
      row.setAttribute("aria-label", `${i + 1}번 슬라이드: ${slideTitle(id)}`);
      row.querySelector(".slide-number").textContent = String(i + 1).padStart(2, "0");
      row.querySelector(".slide-title").textContent = slideTitle(id);
      row.disabled = transitionBusy;
      const iframe = row.querySelector("iframe"), url = new URL(deck.previewUrl);
      url.searchParams.set("rev", String(deck.revision)); url.searchParams.set("mode", "thumbnail"); url.searchParams.set("slide", id);
      iframe.dataset.url = url.href;
      if (visible.has(row) && iframe.getAttribute("src") !== url.href) iframe.src = url.href;
    });
    $("slideSelectionCount").textContent = `${selectedIds.size}장 선택 · 총 ${state.order.length}장`;
    if (notes.dataset.slide !== active) notesCheckpoint = false;
    notes.dataset.slide = active;
    const noteText = state.notes?.[active] ?? deck.sourceNotes?.[active] ?? "";
    if (notes.value !== noteText) notes.value = noteText;
    notes.readOnly = noteText.length > 20000;
    $("legacyNotesHelp").hidden = !notes.readOnly;
    $("notesCount").textContent = `${notes.value.length.toLocaleString()} / 20,000자`;
  }
  async function commit(candidate, active = state.order[index], ids = selection()) {
    const context = objectContext(), epoch = editEpoch;
    const result = await api(`/decks/${deck.id}/validate`, "POST", { state: candidate });
    if (!currentObjectContext(context) || editEpoch !== epoch) throw new Error("검증 중 편집 내용이 바뀌었습니다. 다시 적용해 주세요.");
    checkpoint(); state = clone(result.state);
    index = Math.max(0, state.order.indexOf(active));
    selectedIds = new Set(ids.filter(id => state.order.includes(id)));
    anchor = state.order[index]; notesCheckpoint = false;
    mark(); await flush(); renderSlides(); refreshFrame();
  }
  async function addSlide() {
    if (state.order.length >= 80) throw new Error("슬라이드는 80장까지 만들 수 있습니다.");
    const candidate = clone(state), id = uid("s");
    candidate.clones[id] = null;
    candidate.order.splice(index + 1, 0, id);
    await commit(candidate, id, [id]);
  }
  async function duplicateSlides() {
    const ids = selection();
    if (state.order.length + ids.length > 80) throw new Error("슬라이드는 80장까지 만들 수 있습니다.");
    const candidate = clone(state), copies = [];
    for (const old of ids) {
      const id = uid("s"), source = Object.hasOwn(candidate.clones, old) ? candidate.clones[old] : old;
      candidate.clones[id] = source;
      duplicateAuthoring(old, id, source, candidate);
      if (Object.hasOwn(candidate.scenes, old)) candidate.scenes[id] = candidate.scenes[old];
      if (Object.hasOwn(candidate.notes, old)) candidate.notes[id] = candidate.notes[old];
      if (Object.hasOwn(candidate.transitions, old)) candidate.transitions[id] = candidate.transitions[old];
      for (const item of deck.elements.filter(item => item.slide === source)) {
        const oldId = old === source ? item.id : `${old}--${item.id}`;
        if (candidate.patches[oldId]) candidate.patches[`${id}--${item.id}`] = clone(candidate.patches[oldId]);
      }
      const objectIds = new Map();
      for (const item of state.added.filter(item => item.slide === old)) {
        const copy = { ...clone(item), id: uid("a"), slide: id };
        objectIds.set(item.id, copy.id); candidate.added.push(copy);
        if (candidate.patches[item.id]) candidate.patches[copy.id] = clone(candidate.patches[item.id]);
        if (candidate.animations[item.id]) candidate.animations[copy.id] = candidate.animations[item.id];
      }
      if (candidate.slideLayouts[old]) {
        const layout = clone(candidate.slideLayouts[old]);
        layout.placeholders = Object.fromEntries(Object.entries(layout.placeholders).map(([role, objectId]) => [role, objectIds.get(objectId)]));
        candidate.slideLayouts[id] = layout;
      }
      copies.push(id);
    }
    candidate.order.splice(Math.max(...ids.map(id => state.order.indexOf(id))) + 1, 0, ...copies);
    await commit(candidate, copies[0], copies);
  }
  async function removeSlides() {
    const ids = selection();
    if (ids.length === state.order.length) throw new Error("슬라이드는 하나 이상 필요합니다.");
    const candidate = clone(state), position = Math.min(...ids.map(id => state.order.indexOf(id)));
    candidate.order = candidate.order.filter(id => !ids.includes(id));
    const active = candidate.order[Math.min(position, candidate.order.length - 1)];
    await commit(candidate, active, [active]);
  }
  async function moveSlides(delta) {
    const ids = selection(), candidate = clone(state);
    const positions = candidate.order.map((_, i) => i);
    if (delta > 0) positions.reverse();
    for (const i of positions) {
      const next = i + delta;
      if (selectedIds.has(candidate.order[i]) && next >= 0 && next < candidate.order.length && !selectedIds.has(candidate.order[next]))
        [candidate.order[i], candidate.order[next]] = [candidate.order[next], candidate.order[i]];
    }
    if (candidate.order.join() !== state.order.join()) await commit(candidate, state.order[index], ids);
  }
  for (const [id, fn] of Object.entries({ addSlideBtn: addSlide, duplicateSlideBtn: duplicateSlides, removeSlideBtn: removeSlides, upSlideBtn: () => moveSlides(-1), downSlideBtn: () => moveSlides(1) })) {
    const run = transitionAction(fn, "슬라이드 구성 저장 중…");
    $(id).onclick = () => run()?.then(() => rows.get(state.order[index])?.focus({ preventScroll: true }));
  }
  notes.onfocus = () => { notesCheckpoint = false; };
  notes.onblur = () => { notesCheckpoint = false; };
  notes.oninput = () => {
    if (!deck || transitionBusy || notes.readOnly || notes.dataset.slide !== state.order[index]) return;
    if (!notesCheckpoint) { checkpoint(); notesCheckpoint = true; }
    state.notes ||= {}; state.notes[notes.dataset.slide] = notes.value;
    $("notesCount").textContent = `${notes.value.length.toLocaleString()} / 20,000자`;
    mark();
  };
  $("notesPanel").ontoggle = layoutCanvas;
  $("dialog").addEventListener("cancel", e => { if (transitionBusy) e.preventDefault(); });
  function formCommand(body, text, id, error, fn) {
    const button = el("button", text, "primary"); button.id = id;
    button.onclick = async () => {
      if (transitionBusy) return;
      error.textContent = "";
      const controls = [...body.querySelectorAll("input,select,button")]; controls.forEach(c => { c.disabled = true; });
      $("closeDialog").disabled = true;
      transitionBusy = true; transitionTools();
      try { await settleEditing(); await fn(); $("dialog").close(); }
      catch (e) { error.textContent = e.message; }
      finally { transitionBusy = false; transitionTools(); controls.forEach(c => { c.disabled = false; }); $("closeDialog").disabled = false; }
    };
    body.append(button);
  }
  $("layoutBtn").onclick = transitionAction(() => {
    const targets = selection(), body = dialog("슬라이드 레이아웃"), select = el("select");
    body.oninput = null;
    body.append(el("p", `${targets.length}장에 적용합니다. 제목·본문 자리를 만들고 위치와 기본 서식을 적용합니다. 기존 HTML·다른 개체와 입력 내용은 유지합니다. 빈 슬라이드에서 시작하면 겹침 없이 구성할 수 있습니다.`, "tool-help"));
    const label = el("label", "구성"); select.id = "slideLayoutType";
    for (const [value, text] of [["title", "표지 · 제목과 부제"], ["title-body", "제목과 본문"], ["two-column", "제목과 두 단 본문"], ["blank", "레이아웃 연결 해제 · 내용 유지"]]) {
      const option = el("option", text); option.value = value; select.append(option);
    }
    select.value = state.slideLayouts[state.order[index]]?.type || "title-body";
    label.append(select); body.append(label);
    const error = el("p", "", "authoring-error"); error.setAttribute("role", "alert"); body.append(error);
    formCommand(body, "선택 슬라이드에 적용", "applySlideLayoutBtn", error, async () => {
      let candidate = clone(state);
      for (const id of targets) candidate = SDSlides.applyLayout(candidate, id, select.value, uid);
      await commit(candidate);
    });
    body.append(el("p", "초기화하면 연결된 자리표시자의 위치와 기본 서식이 복원됩니다. 입력 내용과 다른 개체는 유지합니다.", "tool-help"));
    formCommand(body, "레이아웃 초기화", "resetSlideLayoutBtn", error, async () => {
      if (!targets.some(id => state.slideLayouts[id])) throw new Error("먼저 레이아웃을 적용해 주세요.");
      let candidate = clone(state);
      for (const id of targets) candidate = SDSlides.resetLayout(candidate, id);
      await commit(candidate);
    });
  }, "레이아웃 준비 중…");
  const presets = {
    light: SDSlides.DEFAULT_THEME,
    dark: { colors: { background: "#101c27", text: "#e7f0f4", accent: "#54ddca" }, fonts: { heading: "Arial", body: "Arial" } },
    warm: { colors: { background: "#fff8ee", text: "#362c27", accent: "#b94b28" }, fonts: { heading: "Georgia", body: "Arial" } },
  };
  $("themeBtn").onclick = transitionAction(() => {
    const body = dialog("발표 테마"), controls = {};
    body.oninput = null;
    body.append(el("p", "전체 자료의 레이아웃 배경과 테마에 연결된 글꼴·색을 바꿉니다. 따로 지정한 서식과 기존 HTML의 디자인은 유지합니다.", "tool-help"));
    const label = el("label", "테마 예시"), preset = el("select"); preset.id = "themePreset";
    for (const [value, text] of [["custom", "사용자 설정"], ["light", "밝은 기본"], ["dark", "어두운 민트"], ["warm", "따뜻한 종이"]]) {
      const option = el("option", text); option.value = value; preset.append(option);
    }
    label.append(preset); body.append(label);
    for (const [key, text] of [["background", "배경색"], ["text", "본문색"], ["accent", "강조색"], ["heading", "제목 글꼴"], ["body", "본문 글꼴"]]) {
      const wrapper = el("label", text), input = el("input"); input.id = `theme-${key}`;
      input.type = ["heading", "body"].includes(key) ? "text" : "color";
      if (input.type === "text") input.maxLength = 100;
      controls[key] = input; wrapper.append(input); body.append(wrapper);
    }
    const fill = theme => { for (const [key, input] of Object.entries(controls)) input.value = theme.colors[key] || theme.fonts[key]; };
    fill(state.theme || SDSlides.DEFAULT_THEME);
    preset.onchange = () => { if (presets[preset.value]) fill(presets[preset.value]); };
    body.append(el("p", "사용하는 글꼴은 브라우저와 내보내기 서버에도 설치되어 있어야 동일하게 표시됩니다.", "tool-help"));
    const error = el("p", "", "authoring-error"); error.setAttribute("role", "alert"); body.append(error);
    formCommand(body, "테마 적용", "applyThemeBtn", error, async () => {
      const candidate = clone(state);
      candidate.theme = SDSlides.normalizeTheme({ ...state.theme, colors: Object.fromEntries(["background", "text", "accent"].map(key => [key, controls[key].value])), fonts: Object.fromEntries(["heading", "body"].map(key => [key, controls[key].value])) });
      await commit(candidate);
    });
  }, "테마 준비 중…");
  function keydown(e) {
    if (!list.contains(e.target)) return false;
    const key = e.key.toLowerCase(), modifier = e.ctrlKey || e.metaKey;
    if (modifier && key === "a") {
      e.preventDefault(); if (!transitionBusy) { selectedIds = new Set(state.order); renderSlides(); } return true;
    }
    if (modifier && key === "d") { e.preventDefault(); $("duplicateSlideBtn").click(); return true; }
    if (key === "delete" || key === "backspace") { e.preventDefault(); $("removeSlideBtn").click(); return true; }
    if (key === "arrowup" || key === "arrowdown") {
      e.preventDefault(); const delta = key === "arrowup" ? -1 : 1;
      if (e.altKey) $(delta < 0 ? "upSlideBtn" : "downSlideBtn").click();
      else {
        const target = state.order[Math.max(0, Math.min(index + delta, state.order.length - 1))];
        choose(target, e)?.then(() => rows.get(state.order[index])?.focus());
      }
      return true;
    }
    // Object clipboard shortcuts must not accidentally act on canvas selections.
    if (modifier && ["c", "v"].includes(key)) { e.preventDefault(); return true; }
    return false;
  }
  window.SDSlideUI = Object.freeze({ render, reset, keydown });
  if (state) renderSlides();
})();
