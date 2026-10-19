(() => {
  "use strict";
  const config = JSON.parse(
    document.getElementById("sd-config")?.textContent || "{}",
  );
  const edit = config.edit === true;
  const slides = [...document.querySelectorAll("[data-sd-slide]")];
  let current = 0,
    selected = null,
    drag = null;
  const patches = config.state?.patches || {};
  const tell = (type, data = {}) => {
    if (window.parent !== window)
      parent.postMessage({ studio: true, type, ...data }, config.managerOrigin);
  };
  const scale = () =>
    slides[current]?.getBoundingClientRect().width / 1920 || 1;
  const style = document.createElement("style");
  style.textContent = edit
    ? "[data-sd-id]{cursor:move}.sd-selected{outline:3px solid #4cddc9!important;outline-offset:5px}#hud,#help,#progress{display:none!important}[contenteditable=true]{cursor:text}.sd-selected img{pointer-events:none}"
    : "";
  document.head.append(style);
  function go(n) {
    current = Math.max(0, Math.min(slides.length - 1, n));
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
    tell("navigate", { index: current });
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
  function report() {
    if (!selected) return;
    const e = selected,
      r = e.getBoundingClientRect(),
      c = getComputedStyle(e),
      p = patches[e.dataset.sdId] || {};
    tell("select", {
      element: {
        id: e.dataset.sdId,
        tag: e.tagName.toLowerCase(),
        text: e.innerText || "",
        src: e.getAttribute("src"),
        x: p.x || 0,
        y: p.y || 0,
        w: p.w || Math.round(r.width / scale()),
        h: p.h || Math.round(r.height / scale()),
        rotate: p.rotate || 0,
        fontSize: p.fontSize || parseFloat(c.fontSize),
        color: hex(c.color),
        fill: hex(c.backgroundColor),
      },
    });
  }
  function select(e) {
    selected?.classList.remove("sd-selected");
    selected = e;
    selected?.classList.add("sd-selected");
    report();
  }
  function patch(id, p) {
    const e = document.querySelector(`[data-sd-id="${CSS.escape(id)}"]`);
    if (!e) return;
    const q = (patches[id] = { ...(patches[id] || {}), ...p });
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
    if (p.hidden) e.style.display = "none";
  }
  if (edit) {
    document.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const target = e.target.closest("[data-sd-id]");
        if (target) select(target);
      },
      true,
    );
    document.addEventListener(
      "dblclick",
      (e) => {
        const target = e.target.closest("[data-sd-id]");
        if (target && target.tagName !== "IMG") {
          e.preventDefault();
          select(target);
          target.contentEditable = "true";
          target.focus();
        }
      },
      true,
    );
    document.addEventListener(
      "focusout",
      (e) => {
        const target = e.target.closest("[data-sd-id]");
        if (target?.isContentEditable) {
          tell("change", {
            id: target.dataset.sdId,
            patch: { text: target.innerText },
          });
          target.contentEditable = "false";
          report();
        }
      },
      true,
    );
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || e.target.isContentEditable) return;
        const target = e.target.closest("[data-sd-id]");
        if (!target) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        select(target);
        const p = patches[target.dataset.sdId] || {};
        drag = {
          id: target.dataset.sdId,
          el: target,
          startX: e.clientX,
          startY: e.clientY,
          x: p.x || 0,
          y: p.y || 0,
          dx: 0,
          dy: 0,
        };
        target.setPointerCapture(e.pointerId);
      },
      true,
    );
    document.addEventListener(
      "pointermove",
      (e) => {
        if (!drag) return;
        e.preventDefault();
        drag.dx = Math.round((e.clientX - drag.startX) / scale());
        drag.dy = Math.round((e.clientY - drag.startY) / scale());
        patch(drag.id, {
          x: Math.max(-5000, Math.min(5000, drag.x + drag.dx)),
          y: Math.max(-5000, Math.min(5000, drag.y + drag.dy)),
        });
      },
      true,
    );
    document.addEventListener(
      "pointerup",
      () => {
        if (!drag) return;
        if (Math.abs(drag.dx) + Math.abs(drag.dy) > 2)
          tell("change", {
            id: drag.id,
            patch: { x: patches[drag.id].x, y: patches[drag.id].y },
          });
        drag = null;
        report();
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.target.isContentEditable) {
          if (e.key === "Escape") e.target.blur();
          return;
        }
        e.stopImmediatePropagation();
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          tell(e.shiftKey ? "redo" : "undo");
        }
        if (e.key === "Delete" && selected) {
          patch(selected.dataset.sdId, { hidden: true });
          tell("change", {
            id: selected.dataset.sdId,
            patch: { hidden: true },
          });
        }
      },
      true,
    );
    window.addEventListener("wheel", (e) => e.stopImmediatePropagation(), true);
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
    if (d.type === "go") go(d.index);
    if (d.type === "patch") patch(d.id, d.patch);
    if (d.type === "deselect") select(null);
  });
  function collect() {
    const list = [];
    const slide = slides[current];
    const ss = scale();
    for (const e of slide.querySelectorAll("[data-sd-id]")) {
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
      css.textContent = ids
        .map(
          (id) =>
            `[data-sd-id="${CSS.escape(id)}"],[data-sd-id="${CSS.escape(id)}"] *{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}img[data-sd-id="${CSS.escape(id)}"]{visibility:hidden!important}`,
        )
        .join("\n");
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
