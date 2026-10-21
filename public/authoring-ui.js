"use strict";
// Authoring uses the same revision state, validation, history and save path as the visual editor.
let authoringDraft = false, authoringBusy = false;
window.authoringHasDraft = () => authoringDraft;
function closeAuthoring() {
  if (authoringBusy) return;
  if (authoringDraft && !confirm("적용하지 않은 코드 변경을 닫을까요?")) return;
  $("dialog").close();
}
$("closeDialog").onclick = closeAuthoring;
$("dialog").addEventListener("cancel", (e) => {
  if (authoringBusy || (authoringDraft && !confirm("적용하지 않은 코드 변경을 닫을까요?")))
    e.preventDefault();
});
$("dialog").addEventListener("close", () => {
  authoringDraft = false;
  $("dialog").classList.remove("authoring-dialog");
});
async function authoringDialog(title, description) {
  // A failed save must never prevent reopening the draft to correct it.
  const body = dialog(title);
  $("dialog").classList.add("authoring-dialog");
  authoringDraft = false;
  body.append(el("p", description, "authoring-help"));
  body.oninput = (e) => {
    if (e.target.matches("input,textarea")) authoringDraft = true;
  };
  return body;
}
function field(body, label, id, value, multiline = true) {
  const wrapper = el("label", label, "authoring-field");
  const input = el(multiline ? "textarea" : "input");
  input.id = id;
  input.value = value;
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  if (multiline) { input.rows = 9; input.className = "code-input"; }
  wrapper.append(input);
  body.append(wrapper);
  return input;
}
function errorField(body, id) {
  const error = el("p", "", "authoring-error");
  error.id = id;
  error.setAttribute("role", "alert");
  body.append(error);
  return error;
}
function command(body, label, id, error, fn) {
  const button = el("button", label, "primary");
  button.id = id;
  button.onclick = async () => {
    if (authoringBusy) return;
    authoringBusy = true;
    error.textContent = "";
    const controls = [...$("dialog").querySelectorAll("button,input,select,textarea")];
    const disabled = controls.map(e => e.disabled);
    controls.forEach(e => { e.disabled = true; });
    try { await fn(); }
    catch (e) { error.textContent = e.message; }
    finally {
      authoringBusy = false;
      controls.forEach((e, i) => { e.disabled = disabled[i]; });
    }
  };
  body.append(button);
  return button;
}
async function applyAuthoring(candidate) {
  const result = await api("/decks/" + deck.id + "/validate", "POST", { state: candidate });
  checkpoint();
  state = clone(result.state);
  index = Math.min(index, state.order.length - 1);
  selected = null;
  properties();
  mark();
  await flush();
  renderSlides();
  refreshFrame();
  authoringDraft = false;
  $("dialog").close();
}
function clearSlideSourcePatches(candidate, slide) {
  const source = Object.hasOwn(candidate.clones, slide) ? candidate.clones[slide] : slide;
  for (const e of deck.elements.filter(e => e.slide === source))
    delete candidate.patches[slide === source ? e.id : slide + "--" + e.id];
  for (const id of Object.keys(candidate.patches))
    if (id.startsWith("c-" + slide + "--")) delete candidate.patches[id];
}
function duplicateAuthoring(old, id, source, target = state) {
  const state = target;
  state.slideCode ||= {};
  state.slideMasters ||= {};
  if (state.slideMasters[old]) state.slideMasters[id] = state.slideMasters[old];
  if (!state.slideCode[old]) return;
  const code = clone(state.slideCode[old]);
  const ids = new Map();
  const doc = new DOMParser().parseFromString(code.html, "text/html");
  for (const e of doc.querySelectorAll("[data-sd-id]")) {
    const before = e.getAttribute("data-sd-id");
    const after = before.startsWith("c-" + old + "--")
      ? "c-" + id + "--" + before.slice(("c-" + old + "--").length)
      : id + "--" + (old === source ? before : before.slice((old + "--").length));
    e.setAttribute("data-sd-id", after);
    ids.set(before, after);
    if (state.patches[before]) state.patches[after] = clone(state.patches[before]);
  }
  code.html = doc.body.innerHTML;
  code.css = remapCodeSelectors(code.css, ids);
  state.slideCode[id] = code;
}
function remapCodeSelectors(css, ids) {
  let result = "";
  for (let i = 0; i < css.length;) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      const next = end < 0 ? css.length : end + 2;
      result += css.slice(i, next); i = next; continue;
    }
    if (css[i] === "'" || css[i] === '"') {
      const end = css.indexOf(css[i], i + 1);
      const next = end < 0 ? css.length : end + 1;
      result += css.slice(i, next); i = next; continue;
    }
    if (css[i] === "[") {
      const match = /^(\[\s*data-sd-id\s*=\s*)(?:"([^"]*)"|'([^']*)'|([\w-]+))(\s*(?:[is]\s*)?\])/i.exec(css.slice(i));
      if (match) {
        const value = match[2] ?? match[3] ?? match[4];
        const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : "";
        result += match[1] + quote + (ids.get(value) || value) + quote + match[5];
        i += match[0].length; continue;
      }
    }
    result += css[i++];
  }
  return result;
}
const layouts = {
  cover: {
    html: '<div class="layout"><p class="eyebrow">PRESENTATION</p><h1>발표 제목</h1><p>부제와 발표자를 입력하세요.</p></div>',
    css: ".layout{padding:160px 120px;color:#fff}.layout h1{font-size:100px;margin:40px 0}.layout p{font-size:36px}.layout .eyebrow{color:#54ddca;letter-spacing:5px}"
  },
  "title-body": {
    html: '<div class="layout"><h1>슬라이드 제목</h1><p>핵심 메시지를 입력하세요.</p><ul><li>첫 번째 내용</li><li>두 번째 내용</li><li>세 번째 내용</li></ul></div>',
    css: ".layout{padding:70px 100px;color:#fff}.layout h1{font-size:76px;margin:0 0 48px}.layout p,.layout li{font-size:40px;line-height:1.8}"
  },
  "two-column": {
    html: '<div class="layout"><h1>두 가지 관점 비교</h1><div class="columns"><div><h2>첫 번째 주제</h2><p>설명을 입력하세요.</p></div><div><h2>두 번째 주제</h2><p>설명을 입력하세요.</p></div></div></div>',
    css: ".layout{padding:70px 100px;color:#fff}.layout h1{font-size:76px;margin:0 0 60px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:60px}.columns>div{padding:45px;border:2px solid #54ddca;border-radius:20px}.columns h2{font-size:50px}.columns p{font-size:36px}"
  }
};
$("codeBtn").onclick = action(async () => {
  const slide = state.order[index];
  const code = state.slideCode?.[slide] ||
    await api("/decks/" + deck.id + "/authoring?slide=" + encodeURIComponent(slide));
  const body = await authoringDialog("슬라이드 HTML/CSS 편집",
    "현재 슬라이드의 기본 구성을 편집합니다. 적용하면 이 슬라이드의 원본·코드 개체 수정값이 초기화됩니다. 별도로 추가한 글·이미지는 유지됩니다. 변경은 버전에 저장되며 실행 취소할 수 있습니다. 스크립트는 지원하지 않습니다.");
  const tools = el("div", undefined, "authoring-actions");
  const preset = el("select");
  preset.id = "layoutPreset";
  preset.setAttribute("aria-label", "레이아웃 구성");
  for (const [id, name] of [["cover", "표지"], ["title-body", "제목과 본문"], ["two-column", "2단 비교"]]) {
    const option = el("option", name); option.value = id; preset.append(option);
  }
  const load = el("button", "선택한 구성 생성");
  load.id = "loadLayoutBtn";
  tools.append(preset, load);
  body.append(tools);
  const html = field(body, "슬라이드 내부 HTML", "codeHtml", code.html);
  const css = field(body, "이 슬라이드에 적용할 CSS", "codeCss", code.css);
  load.onclick = () => {
    const layout = layouts[preset.value];
    html.value = layout.html; css.value = layout.css; authoringDraft = true;
  };
  const error = errorField(body, "codeError");
  command(body, "검증하고 적용", "codeApplyBtn", error, async () => {
    const candidate = clone(state);
    clearSlideSourcePatches(candidate, slide);
    candidate.slideCode ||= {};
    candidate.slideCode[slide] = { html: html.value, css: css.value };
    await applyAuthoring(candidate);
  });
  command(body, "가져온 원본 구성으로 복원", "codeResetBtn", error, async () => {
    const candidate = clone(state);
    clearSlideSourcePatches(candidate, slide);
    delete candidate.slideCode[slide];
    await applyAuthoring(candidate);
  });
});
$("jsonBtn").onclick = action(async () => {
  const body = await authoringDialog("편집 상태 JSON",
    "개체·좌표·서식과 코드·마스터 연결을 직접 편집합니다. 검증을 통과한 데이터만 적용하며, 오류가 있으면 작성 내용이 이 창에 유지됩니다.");
  const input = field(body, "편집 상태 JSON", "jsonState", JSON.stringify(state, null, 2));
  input.rows = 22;
  const error = errorField(body, "jsonError");
  command(body, "검증하고 적용", "jsonApplyBtn", error, async () => {
    let candidate;
    try { candidate = JSON.parse(input.value); }
    catch (e) { throw new Error("JSON 문법을 확인해 주세요: " + e.message); }
    await applyAuthoring(candidate);
  });
});
$("masterBtn").onclick = action(async () => {
  const slide = state.order[index];
  const body = await authoringDialog("공통 슬라이드 마스터",
    "공통 배경·로고·제목 영역을 만듭니다. 마스터를 수정하면 연결된 모든 슬라이드에 반영됩니다. 개별 내용은 HTML/CSS 또는 개체 편집으로 작성하세요.");
  const chooser = el("select");
  chooser.id = "masterSelect";
  chooser.setAttribute("aria-label", "마스터 선택");
  const newOption = el("option", "새 마스터"); newOption.value = ""; chooser.append(newOption);
  for (const [id, master] of Object.entries(state.masters || {})) {
    const option = el("option", master.name); option.value = id; chooser.append(option);
  }
  body.append(chooser);
  const name = field(body, "마스터 이름", "masterName", "", false);
  const html = field(body, "공통 영역 HTML", "masterHtml", "");
  const css = field(body, "공통 영역 CSS", "masterCss", "");
  const fill = () => {
    const master = state.masters?.[chooser.value] || {
      name: "기본 브랜드",
      html: '<div class="master-band"></div><div class="master-label">SDLAB</div>',
      css: ".master-band{position:absolute;inset:0;background:#101c27}.master-label{position:absolute;right:60px;bottom:35px;color:#54ddca;font-size:26px}"
    };
    name.value = master.name; html.value = master.html; css.value = master.css;
  };
  chooser.value = state.slideMasters?.[slide] || "";
  let previousMaster = chooser.value;
  fill();
  chooser.onchange = () => {
    if (authoringDraft && !confirm("작성 중인 마스터 변경을 버리고 다른 마스터를 열까요?")) {
      chooser.value = previousMaster;
      return;
    }
    previousMaster = chooser.value;
    fill();
    authoringDraft = false;
  };
  const error = errorField(body, "masterError");
  command(body, "저장하고 현재 슬라이드에 연결", "masterSaveBtn", error, async () => {
    const candidate = clone(state), id = chooser.value || uid("m");
    candidate.masters ||= {}; candidate.slideMasters ||= {};
    candidate.masters[id] = { name: name.value, html: html.value, css: css.value };
    candidate.slideMasters[slide] = id;
    await applyAuthoring(candidate);
  });
  command(body, "저장하고 모든 슬라이드에 연결", "masterAllBtn", error, async () => {
    const candidate = clone(state), id = chooser.value || uid("m");
    candidate.masters ||= {}; candidate.slideMasters ||= {};
    candidate.masters[id] = { name: name.value, html: html.value, css: css.value };
    for (const sid of candidate.order) candidate.slideMasters[sid] = id;
    await applyAuthoring(candidate);
  });
  command(body, "현재 슬라이드 연결 해제", "masterDetachBtn", error, async () => {
    const candidate = clone(state);
    delete candidate.slideMasters[slide];
    await applyAuthoring(candidate);
  });
  command(body, "선택한 마스터 삭제 및 연결 해제", "masterDeleteBtn", error, async () => {
    if (!chooser.value) throw new Error("삭제할 마스터를 선택해 주세요.");
    const candidate = clone(state);
    delete candidate.masters[chooser.value];
    for (const [sid, id] of Object.entries(candidate.slideMasters))
      if (id === chooser.value) delete candidate.slideMasters[sid];
    await applyAuthoring(candidate);
  });
});
