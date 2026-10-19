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
  undo = [],
  redo = [],
  dirty = false,
  blocked = false,
  saveTimer = null,
  saving = null,
  filter = "all",
  folder = "",
  replaceImage = false;
const frame = $("deckFrame");
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
      await fn(...args);
    } catch (e) {
      toast(e.message);
    }
  };
const post = (type, data = {}) => {
  if (deck)
    frame.contentWindow?.postMessage(
      { studio: true, type, ...data },
      new URL(deck.previewUrl).origin,
    );
};
function dialog(title) {
  $("dialog").classList.remove("files-dialog");
  $("dialogTitle").textContent = title;
  $("dialogBody").replaceChildren();
  $("dialog").showModal();
  return $("dialogBody");
}
$("closeDialog").onclick = () => $("dialog").close();
function mark() {
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
  $("saveStatus").textContent = "저장 중…";
  saving = api(`/decks/${id}/save`, "POST", { revision, state: snapshot })
    .then((d) => {
      deck = { ...d, state };
      $("saveStatus").textContent = dirty
        ? "저장 대기"
        : `저장됨 · v${d.revision}`;
    })
    .catch((e) => {
      dirty = true;
      blocked = e.status === 409;
      $("saveStatus").textContent = "저장 실패 · 변경 보존 중";
      if (blocked) conflictDialog();
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
function refreshFrame() {
  frame.src = deck.previewUrl + "&mode=edit#" + (index + 1);
  selected = null;
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
function patch(p) {
  if (!selected) return;
  checkpoint();
  state.patches[selected.id] = { ...(state.patches[selected.id] || {}), ...p };
  post("patch", { id: selected.id, patch: p });
  Object.assign(selected, p);
  mark();
}
async function history(back) {
  const source = back ? undo : redo,
    dest = back ? redo : undo;
  if (!source.length) return;
  dest.push(clone(state));
  state = source.pop();
  mark();
  await flush();
  renderSlides();
  refreshFrame();
}
function properties() {
  const s = selected;
  $("noSelection").hidden = !!s;
  $("properties").hidden = !s;
  $("selectedLabel").textContent = s
    ? `${s.tag.toUpperCase()} 선택됨`
    : "선택한 요소 없음";
  if (!s) return;
  $("textField").hidden = s.tag === "img";
  $("replaceImageBtn").hidden = s.tag !== "img";
  $("textValue").value = s.text;
  for (const [id, key] of [
    ["xValue", "x"],
    ["yValue", "y"],
    ["wValue", "w"],
    ["hValue", "h"],
    ["rotateValue", "rotate"],
    ["fontValue", "fontSize"],
    ["colorValue", "color"],
    ["fillValue", "fill"],
  ])
    $(id).value = s[key] ?? 0;
}
function slideTitle(id) {
  const source = state.clones[id] ?? id;
  const s = deck.slides.find((s) => s.id === source);
  return s?.title || "빈 슬라이드";
}
function renderSlides() {
  const list = $("slideList");
  list.replaceChildren();
  state.order.forEach((id, i) => {
    const b = el(
      "button",
      undefined,
      "slide-item" + (i === index ? " selected" : ""),
    );
    b.append(
      el("span", String(i + 1).padStart(2, "0")),
      el("div", slideTitle(id)),
    );
    b.onclick = () => {
      index = i;
      post("go", { index });
      renderSlides();
    };
    list.append(b);
  });
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
  if (d.type === "select" && d.element && typeof d.element.id === "string") {
    selected = d.element;
    properties();
  }
  if (d.type === "change" && typeof d.id === "string") {
    checkpoint();
    state.patches[d.id] = { ...(state.patches[d.id] || {}), ...d.patch };
    mark();
  }
  if (d.type === "navigate" && Number.isInteger(d.index)) {
    index = d.index;
    renderSlides();
  }
  if (d.type === "ready") post("go", { index });
  if (d.type === "undo" || d.type === "redo")
    action(() => history(d.type === "undo"))();
});
async function openDeck(id) {
  if (deck) await flush();
  deck = await api("/decks/" + id);
  state = clone(deck.state);
  dirty = false;
  blocked = false;
  undo = [];
  redo = [];
  index = 0;
  $("library").hidden = true;
  $("editor").hidden = false;
  $("deckTitle").value = deck.title;
  $("saveStatus").textContent = `저장됨 · v${deck.revision}`;
  location.hash = "deck=" + id;
  renderSlides();
  refreshFrame();
}
async function library() {
  if (deck) await flush();
  deck = null;
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
$("textValue").onchange = () => patch({ text: $("textValue").value });
for (const [id, key] of [
  ["xValue", "x"],
  ["yValue", "y"],
  ["wValue", "w"],
  ["hValue", "h"],
  ["rotateValue", "rotate"],
  ["fontValue", "fontSize"],
])
  $(id).onchange = () => {
    const v = Number($(id).value);
    if ($(id).checkValidity()) patch({ [key]: v });
    else toast("입력 범위를 확인해 주세요.");
  };
$("colorValue").onchange = () => patch({ color: $("colorValue").value });
$("fillValue").onchange = () => patch({ fill: $("fillValue").value });
$("removeElementBtn").onclick = () => patch({ hidden: true });
$("undoBtn").onclick = action(() => history(true));
$("redoBtn").onclick = action(() => history(false));
$("addSlideBtn").onclick = action(() =>
  structural(() => {
    const id = uid("s");
    state.clones[id] = null;
    state.order.splice(++index, 0, id);
  }),
);
$("removeSlideBtn").onclick = action(async () => {
  if (state.order.length === 1)
    throw new Error("슬라이드는 하나 이상 필요합니다.");
  await structural(() => state.order.splice(index, 1));
});
for (const [id, delta] of [
  ["upSlideBtn", -1],
  ["downSlideBtn", 1],
])
  $(id).onclick = action(async () => {
    const next = index + delta;
    if (next < 0 || next >= state.order.length) return;
    await structural(() => {
      [state.order[index], state.order[next]] = [
        state.order[next],
        state.order[index],
      ];
      index = next;
    });
  });
$("duplicateSlideBtn").onclick = action(() =>
  structural(() => {
    const old = state.order[index],
      id = uid("s"),
      source = Object.hasOwn(state.clones, old) ? state.clones[old] : old;
    state.clones[id] = source;
    if (Object.hasOwn(state.scenes, old)) state.scenes[id] = state.scenes[old];
    state.order.splice(++index, 0, id);
    for (const e of deck.elements.filter((e) => e.slide === source)) {
      const oldId = old === source ? e.id : old + "--" + e.id;
      if (state.patches[oldId])
        state.patches[id + "--" + e.id] = clone(state.patches[oldId]);
    }
    for (const a of state.added.filter((a) => a.slide === old)) {
      const copy = { ...clone(a), id: uid("a"), slide: id };
      state.added.push(copy);
      if (state.patches[a.id])
        state.patches[copy.id] = clone(state.patches[a.id]);
    }
  }),
);
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
$("addShapeBtn").onclick = action(() =>
  structural(() =>
    state.added.push({
      id: uid("a"),
      slide: state.order[index],
      kind: "shape",
      x: 150,
      y: 300,
      w: 420,
      h: 200,
      fill: "#087e77",
    }),
  ),
);
$("addImageBtn").onclick = () => {
  replaceImage = false;
  $("imageInput").click();
};
$("replaceImageBtn").onclick = () => {
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
  if (replaceImage && selected) patch({ src: b.src });
  else
    await structural(() =>
      state.added.push({
        id: uid("a"),
        slide: state.order[index],
        kind: "image",
        src: b.src,
        x: 150,
        y: 200,
        w: 640,
        h: 400,
      }),
    );
  e.target.value = "";
});
$("backgroundValue").onchange = action(() =>
  structural(() => (state.background = $("backgroundValue").checked)),
);
$("sceneValue").onchange = action(() =>
  structural(() => {
    const value = $("sceneValue").value;
    if (value) state.scenes[state.order[index]] = value;
    else delete state.scenes[state.order[index]];
  }),
);
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
  if (dirty || saving) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("keydown", (e) => {
  if (!deck || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    action(() => history(!e.shiftKey))();
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
