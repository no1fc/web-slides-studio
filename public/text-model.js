(function (global) {
  "use strict";

  const characterKeys = ["fontFamily", "fontSize", "color", "bold", "italic", "underline"];
  const paragraphKeys = ["align", "lineHeight", "spaceAfter", "indent", "list"];
  const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

  function record(value, allowed, label) {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error(`${label}는 객체여야 합니다.`);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error(`허용되지 않는 ${label} 항목입니다.`);
    }
    return value;
  }

  function family(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 100 || !/^[\p{L}\p{N}\p{M} _.,'"-]+$/u.test(value))
      throw new Error("글꼴 이름 오류");
    let quote = "";
    for (const char of value) {
      if (char !== "'" && char !== '"') continue;
      if (!quote) quote = char;
      else if (quote === char) quote = "";
    }
    if (quote) throw new Error("글꼴 이름 오류");
    return value.trim();
  }

  function styles(value, scope) {
    const result = {};
    for (const key of scope === "character" ? characterKeys : paragraphKeys) {
      if (!Object.hasOwn(value, key)) continue;
      const item = value[key];
      if (key === "fontFamily") { result[key] = family(item); continue; }
      if (key === "fontSize" && !finite(item, 6, 400)) throw new Error("글꼴 크기 오류");
      if (key === "color" && (typeof item !== "string" || !/^#[\da-f]{6}$/i.test(item))) throw new Error("색상 값 오류");
      if (["bold", "italic", "underline"].includes(key) && typeof item !== "boolean") throw new Error("문자 서식 값 오류");
      if (key === "align" && !["left", "center", "right", "justify"].includes(item)) throw new Error("문단 정렬 값 오류");
      if (key === "lineHeight" && !finite(item, 0.5, 4)) throw new Error("줄간격 값 오류");
      if (key === "spaceAfter" && !finite(item, 0, 200)) throw new Error("문단 간격 값 오류");
      if (key === "indent" && (!Number.isInteger(item) || !finite(item, 0, 8))) throw new Error("들여쓰기 값 오류");
      if (key === "list" && !["none", "bullet", "number"].includes(item)) throw new Error("목록 값 오류");
      result[key] = key === "color" ? item.toLowerCase() : item;
    }
    return result;
  }

  function appendRun(runs, run) {
    const previous = runs.at(-1);
    if (previous && characterKeys.every(key => previous[key] === run[key])) previous.text += run.text;
    else runs.push(run);
  }

  function array(value, limit) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1)
      throw new Error("텍스트 배열 형식 또는 개수 오류");
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("텍스트 배열 형식 오류");
    }
    return value;
  }

  function normalizeRichText(value) {
    record(value, ["paragraphs"], "텍스트");
    array(value.paragraphs, 500);
    let count = 0, characters = Math.max(0, value.paragraphs.length - 1);
    const paragraphs = value.paragraphs.map(paragraph => {
      record(paragraph, ["runs", ...paragraphKeys], "문단");
      array(paragraph.runs, 5000);
      if ((count += Math.max(1, paragraph.runs.length)) > 5000) throw new Error("문자 서식 조각은 5,000개까지 사용할 수 있습니다.");
      const runs = [];
      for (const run of paragraph.runs) {
        record(run, ["text", ...characterKeys], "문자");
        if (!Object.hasOwn(run, "text") || typeof run.text !== "string" || (characters += run.text.length) > 100000)
          throw new Error("텍스트는 100,000자까지 사용할 수 있습니다.");
        appendRun(runs, { text: run.text, ...styles(run, "character") });
      }
      if (!runs.length) runs.push({ text: "" });
      return { runs, ...styles(paragraph, "paragraph") };
    });
    return { paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: "" }] }] };
  }

  function normalizeTextBox(value) {
    record(value, ["vertical", "overflow", "autoFit"], "텍스트 상자");
    const result = {};
    const values = { vertical: ["top", "middle", "bottom"], overflow: ["visible", "clip"], autoFit: ["none", "shrink"] };
    for (const [key, allowed] of Object.entries(values)) {
      if (!Object.hasOwn(value, key)) continue;
      if (!allowed.includes(value[key])) throw new Error("텍스트 상자 값 오류");
      result[key] = value[key];
    }
    return result;
  }

  function plainText(rich) {
    return normalizeRichText(rich).paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join("")).join("\n");
  }

  function formatRichText(rich, range, scope, changes) {
    const result = normalizeRichText(rich);
    if (!["character", "paragraph"].includes(scope)) throw new Error("텍스트 서식 범위 오류");
    record(changes, scope === "character" ? characterKeys : paragraphKeys, "서식");
    const patch = styles(changes, scope);
    const length = result.paragraphs.reduce((sum, paragraph) => sum + paragraph.runs.reduce((size, run) => size + run.text.length, 0), result.paragraphs.length - 1);
    if (range !== null) {
      record(range, ["start", "end"], "선택 범위");
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > length)
        throw new Error("텍스트 선택 범위 오류");
    }
    let offset = 0;
    result.paragraphs = result.paragraphs.map((paragraph, index) => {
      const size = paragraph.runs.reduce((sum, run) => sum + run.text.length, 0);
      const start = offset, end = start + size;
      offset = end + 1;
      if (scope === "paragraph") {
        const selected = range === null || (range.start === range.end
          ? range.start >= start && (range.start < offset || index === result.paragraphs.length - 1)
          : range.start < end + (index < result.paragraphs.length - 1 ? 1 : 0) && range.end > start);
        return selected ? { ...paragraph, ...patch } : paragraph;
      }
      if (range === null) return { ...paragraph, runs: paragraph.runs.map(run => ({ ...run, ...patch })) };
      if (range.start === range.end) return paragraph;
      const runs = [];
      let position = start;
      for (const run of paragraph.runs) {
        const from = Math.max(0, range.start - position), to = Math.min(run.text.length, range.end - position);
        if (from < to) {
          if (from) appendRun(runs, { ...run, text: run.text.slice(0, from) });
          appendRun(runs, { ...run, ...patch, text: run.text.slice(from, to) });
          if (to < run.text.length) appendRun(runs, { ...run, text: run.text.slice(to) });
        } else appendRun(runs, run);
        position += run.text.length;
      }
      return { ...paragraph, runs };
    });
    return normalizeRichText(result);
  }

  function applyBox(element, value) {
    const box = normalizeTextBox(value);
    element.setAttribute("data-sd-text-box", JSON.stringify(box));
    if (box.vertical !== undefined) {
      if (element.style.display !== "none") element.style.display = "flex";
      element.style.flexDirection = "column";
      element.style.justifyContent = { top: "flex-start", middle: "center", bottom: "flex-end" }[box.vertical];
    }
    if (box.overflow !== undefined) element.style.overflow = box.overflow === "clip" ? "hidden" : "visible";
  }

  function underlineDefault(element, rich) {
    // Underline is propagated through descendants, so a run's `none` cannot
    // cancel the host's underline. Keep the original declaration for repeat
    // renders, then distribute only the host's underline to its default runs.
    // Ancestor decorations remain outside this element's editing boundary.
    const attribute = "data-sd-original-decoration-line";
    const priorityAttribute = "data-sd-original-decoration-priority";
    if (!element.hasAttribute(attribute)) {
      // linkedom preserves shorthand CSS without expanding it into longhands.
      const shorthand = element.style.textDecoration;
      const shorthandLine = shorthand ? (shorthand.match(/\b(?:underline|overline|line-through)\b/g) || []).join(" ") || "none" : "";
      element.setAttribute(attribute, element.style.getPropertyValue("text-decoration-line") || shorthandLine);
      element.setAttribute(priorityAttribute, element.style.getPropertyPriority?.("text-decoration-line") || element.style.getPropertyPriority?.("text-decoration") || (/!important\b/.test(shorthand || "") ? "important" : ""));
    } else {
      const original = element.getAttribute(attribute);
      if (original) element.style.setProperty("text-decoration-line", original, element.getAttribute(priorityAttribute) || "");
      else element.style.removeProperty("text-decoration-line");
    }
    const view = element.ownerDocument.defaultView;
    const computed = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(element) : null;
    const line = computed?.textDecorationLine || element.style.textDecorationLine || element.style.textDecoration;
    const known = typeof line === "string" && !!line;
    const explicit = rich.paragraphs.every(paragraph => paragraph.runs.every(run => run.underline !== undefined));
    const underlined = known && /\bunderline\b/.test(line);
    if (known) element.setAttribute("data-sd-default-underline", String(underlined));
    // Server rendering cannot resolve a stylesheet default. Leave that host
    // declaration intact until the browser can resolve omitted run values.
    if (known || explicit) {
      const remaining = known ? (line.match(/\b(?:overline|line-through)\b/g) || []).join(" ") : "";
      element.style.setProperty("text-decoration-line", remaining || "none", "important");
    }
    return underlined;
  }

  function renderRichText(element, rich, textBox) {
    // Omitting rich updates box layout without replacing existing legacy markup.
    if (rich !== undefined) {
      const normalized = normalizeRichText(rich), document = element.ownerDocument;
      const defaultUnderline = underlineDefault(element, normalized);
      const content = document.createElement("span");
      content.setAttribute("data-sd-text-content", "");
      content.style.cssText = "display:block;width:100%;min-width:0;flex-shrink:0;white-space:pre-wrap;";
      const counters = [];
      for (const paragraph of normalized.paragraphs) {
        const block = document.createElement("span");
        block.setAttribute("data-sd-paragraph", "");
        block.style.cssText = "display:block;position:relative;margin:0;min-height:1em;white-space:pre-wrap;";
        const indent = paragraph.indent ?? 0, list = paragraph.list ?? "none";
        block.setAttribute("data-sd-indent", String(indent));
        block.setAttribute("data-sd-list", list);
        if (paragraph.align !== undefined) {
          block.setAttribute("data-sd-align", paragraph.align);
          block.style.textAlign = paragraph.align;
        }
        if (paragraph.lineHeight !== undefined) block.style.lineHeight = String(paragraph.lineHeight);
        if (paragraph.spaceAfter !== undefined) block.style.marginBottom = paragraph.spaceAfter + "px";
        block.style.paddingLeft = (indent * 32 + (list === "none" ? 0 : 24)) + "px";
        if (list !== "none") {
          const marker = document.createElement("span");
          marker.setAttribute("data-sd-marker", "");
          marker.setAttribute("contenteditable", "false");
          marker.setAttribute("aria-hidden", "true");
          marker.style.cssText = `position:absolute;left:${indent * 32}px;width:24px;user-select:none;text-align:left;`;
          if (list === "number") {
            counters[indent] = (counters[indent] || 0) + 1;
            counters.length = indent + 1;
            marker.textContent = counters[indent] + ".";
          } else {
            counters.length = indent;
            marker.textContent = "•";
          }
          block.append(marker);
        } else counters.length = indent;
        for (const run of paragraph.runs) {
          const span = document.createElement("span");
          span.setAttribute("data-sd-run", "");
          span.style.cssText = "display:inline;white-space:pre-wrap;";
          if (run.fontFamily !== undefined) span.style.fontFamily = run.fontFamily;
          if (run.fontSize !== undefined) span.style.fontSize = run.fontSize + "px";
          if (run.color !== undefined) { span.style.color = run.color; span.style.webkitTextFillColor = run.color; }
          if (run.bold !== undefined) span.style.fontWeight = run.bold ? "700" : "400";
          if (run.italic !== undefined) span.style.fontStyle = run.italic ? "italic" : "normal";
          if (run.underline !== undefined) span.style.textDecoration = run.underline ? "underline" : "none";
          else if (defaultUnderline) span.style.textDecoration = "underline";
          span.textContent = run.text;
          block.append(span);
        }
        if (!paragraph.runs.some(run => run.text)) block.lastElementChild.append(document.createElement("br"));
        content.append(block);
      }
      element.replaceChildren(content);
      element.setAttribute("data-sd-rich", "true");
      element.setAttribute("data-sd-rich-text", JSON.stringify(normalized));
    }
    if (textBox !== undefined) applyBox(element, textBox);
    return element;
  }

  global.SDText = Object.freeze({ normalizeRichText, normalizeTextBox, plainText, formatRichText, renderRichText });
})(globalThis);
