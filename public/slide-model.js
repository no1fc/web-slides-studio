(function (global) {
  "use strict";

  const DEFAULT_THEME = Object.freeze({
    colors: Object.freeze({ background: "#ffffff", text: "#172033", accent: "#2563eb" }),
    fonts: Object.freeze({ heading: "Arial", body: "Arial" }),
  });
  const layouts = {
    title: {
      title: { x: 140, y: 250, w: 1640, h: 240, fontSize: 112, align: "center" },
      body: { x: 240, y: 540, w: 1440, h: 180, fontSize: 48, align: "center" },
    },
    "title-body": {
      title: { x: 140, y: 100, w: 1640, h: 150, fontSize: 76, align: "left" },
      body: { x: 140, y: 300, w: 1640, h: 640, fontSize: 42, align: "left" },
    },
    "two-column": {
      title: { x: 140, y: 100, w: 1640, h: 150, fontSize: 76, align: "left" },
      body: { x: 140, y: 300, w: 780, h: 640, fontSize: 42, align: "left" },
      body2: { x: 1000, y: 300, w: 780, h: 640, fontSize: 42, align: "left" },
    },
  };

  function record(value, allowed, label) {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error(`${label}는 객체여야 합니다.`);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || allowed && !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error(`허용되지 않는 ${label} 항목입니다.`);
    }
    return value;
  }

  function normalizeTheme(value = DEFAULT_THEME) {
    record(value, ["colors", "fonts", "sizes", "radius"], "테마");
    const result = structuredClone(DEFAULT_THEME);
    for (const section of ["colors", "fonts"]) {
      if (!Object.hasOwn(value, section)) continue;
      record(value[section], Object.keys(DEFAULT_THEME[section]), "테마 " + section);
      for (const [key, item] of Object.entries(value[section])) {
        if (section === "colors") {
          if (typeof item !== "string" || !/^#[\da-f]{6}$/i.test(item)) throw new Error("테마 색상 값 오류");
          result.colors[key] = item.toLowerCase();
        } else {
          if (typeof item !== "string" || !item.trim() || item.length > 100 || !/^[\p{L}\p{N}\p{M} _.,'"-]+$/u.test(item))
            throw new Error("테마 글꼴 이름 오류");
          let quote = "";
          for (const char of item) {
            if (char !== "'" && char !== '"') continue;
            if (!quote) quote = char;
            else if (quote === char) quote = "";
          }
          if (quote) throw new Error("테마 글꼴 이름 오류");
          result.fonts[key] = item.trim();
        }
      }
    }
    if (value.sizes !== undefined) {
      record(value.sizes, ["heading", "body"], "테마 크기"); result.sizes = {};
      for (const [key, size] of Object.entries(value.sizes)) {
        const [min, max] = key === "heading" ? [48, 240] : [16, 72];
        if (typeof size !== "number" || !Number.isFinite(size) || size < min || size > max) throw new Error("테마 글자 크기 범위를 확인해 주세요.");
        result.sizes[key] = size;
      }
    }
    if (value.radius !== undefined) {
      if (typeof value.radius !== "number" || !Number.isFinite(value.radius) || value.radius < 0 || value.radius > 80) throw new Error("모서리 반경은 0~80px입니다.");
      result.radius = value.radius;
    }
    return result;
  }

  function applyDesignPreview(document, value, state) {
    const theme = normalizeTheme(value);
    for (const slide of document.querySelectorAll('[data-sd-slide]')) {
      for (const key of ['heading','body']) slide.style.setProperty(`--sd-theme-${key}-font`,theme.fonts[key]);
      for (const key of ['background','text','accent']) slide.style.setProperty(`--sd-theme-${key}`,theme.colors[key]);
      for (const key of ['heading','body']) {
        if(theme.sizes?.[key]!==undefined)slide.style.setProperty(`--sd-theme-${key}-size`,theme.sizes[key]+'px');
        else slide.style.removeProperty(`--sd-theme-${key}-size`);
      }
      if(theme.radius!==undefined)slide.style.setProperty('--sd-theme-radius',theme.radius+'px');
      else slide.style.removeProperty('--sd-theme-radius');
      if(state.slideLayouts?.[slide.getAttribute('data-sd-slide')])slide.style.background=theme.colors.background;
      for(const element of slide.querySelectorAll('[data-sd-font-theme],[data-sd-design]')) {
        const role=element.getAttribute('data-sd-font-theme')||element.getAttribute('data-sd-design');
        const property=role==='card'?'border-radius':'font-size';
        const owner=element.closest('[data-sd-id]');
        const patch=owner&&state.patches?.[owner.getAttribute('data-sd-id')];
        const customized=role!=='card'&&(patch?.richText||patch?.fontSize!==undefined);
        const size=customized?undefined:role==='card'?theme.radius:theme.sizes?.[role];
        const saved='data-sd-design-original-'+property;
        if(size!==undefined){if(!element.hasAttribute(saved))element.setAttribute(saved,element.style.getPropertyValue(property));element.style.setProperty(property,size+'px');}
        else if(element.hasAttribute(saved)){const original=element.getAttribute(saved);if(original)element.style.setProperty(property,original);else element.style.removeProperty(property);element.removeAttribute(saved);}
      }
      for(const owner of slide.querySelectorAll('[data-sd-rich-text]')) {
        const patch=state.patches?.[owner.getAttribute('data-sd-id')];
        if(theme.sizes && !patch?.richText && patch?.fontSize===undefined) owner.setAttribute('data-sd-theme-sizes',JSON.stringify(theme.sizes));
        else owner.removeAttribute('data-sd-theme-sizes');
        global.SDTextEditor?.fit(owner);
      }
    }
  }

  function normalizeLayout(value) {
    record(value, ["type", "placeholders"], "슬라이드 레이아웃");
    if (typeof value.type !== "string" || !Object.hasOwn(layouts, value.type)) throw new Error("레이아웃 종류 오류");
    record(value.placeholders, Object.keys(layouts[value.type]), "자리표시자");
    const placeholders = {};
    for (const [role, id] of Object.entries(value.placeholders)) {
      if (typeof id !== "string" || !/^a-[a-z0-9-]{1,50}$/.test(id)) throw new Error("자리표시자 ID 오류");
      placeholders[role] = id;
    }
    return { type: value.type, placeholders };
  }

  function content(object, patch, fallback) {
    if (Object.hasOwn(patch, "richText")) return global.SDText.plainText(patch.richText);
    if (Object.hasOwn(patch, "text")) return patch.text;
    if (object.richText) return global.SDText.plainText(object.richText);
    return object.text ?? fallback;
  }

  function formatPlaceholder(state, object, type, role) {
    const patch = state.patches[object.id] || {};
    const spec = layouts[type][role];
    const text = content(object, patch, role === "title" ? "제목을 입력하세요" : type === "title" ? "부제목을 입력하세요" : "내용을 입력하세요");
    const { align, ...geometry } = spec;
    const richText = { paragraphs: text.split("\n").map(line => ({
      align, lineHeight: 1.15, spaceAfter: role === "title" ? 0 : 12, indent: 0, list: "none",
      runs: [{ text: line, fontTheme: role === "title" ? "heading" : "body", colorTheme: role === "title" ? "accent" : "text", fontSize: spec.fontSize, bold: role === "title" }],
    })) };
    // Clear both layers so an old patch cannot conceal the restored base format.
    for (const key of ["x", "y", "w", "h", "rotate", "fontSize", "color", "fill", "text", "richText", "textBox", "textMetricsScale", "inheritFontSize", "layerPosition"]) {
      delete object[key];
      delete patch[key];
    }
    Object.assign(object, geometry, { rotate: 0, text, richText, textBox: { vertical: "top", overflow: "clip", autoFit: "shrink" } });
    if (Object.keys(patch).length) state.patches[object.id] = patch;
    else delete state.patches[object.id];
  }

  function copyState(state, slide) {
    if (typeof slide !== "string" || !state.order?.includes(slide)) throw new Error("알 수 없는 슬라이드입니다.");
    const result = structuredClone(state);
    result.slideLayouts ??= {};
    result.patches ??= {};
    return result;
  }

  function applyLayout(state, slide, type, uid) {
    if (type !== "blank" && (typeof type !== "string" || !Object.hasOwn(layouts, type))) throw new Error("레이아웃 종류 오류");
    const result = copyState(state, slide);
    if (type === "blank") {
      delete result.slideLayouts[slide];
      return result;
    }
    const previous = result.slideLayouts[slide]?.placeholders || {};
    const placeholders = {};
    const used = new Set([...result.added.map(object => object.id), ...Object.keys(result.patches)]);
    for (const role of Object.keys(layouts[type])) {
      let object = result.added.find(item => item.id === previous[role] && item.slide === slide && item.kind === "text");
      if (!object) {
        const id = typeof uid === "function" ? uid("a") : null;
        if (typeof id !== "string" || !/^a-[a-z0-9-]{1,50}$/.test(id) || used.has(id)) throw new Error("추가 자리표시자 ID 오류");
        used.add(id);
        object = { id, slide, kind: "text" };
        result.added.push(object);
      }
      placeholders[role] = object.id;
      formatPlaceholder(result, object, type, role);
    }
    let count = 0;
    const countObject = object => { count++; for (const child of object.group?.children || []) countObject(child); };
    result.added.forEach(countObject);
    if (count > 500) throw new Error("그룹 내부를 포함한 추가 요소는 500개까지 사용할 수 있습니다.");
    result.slideLayouts[slide] = { type, placeholders };
    return result;
  }

  function resetLayout(state, slide) {
    const result = copyState(state, slide);
    if (!result.slideLayouts[slide]) return result;
    const layout = normalizeLayout(result.slideLayouts[slide]);
    for (const [role, id] of Object.entries(layout.placeholders)) {
      const object = result.added.find(item => item.id === id && item.slide === slide && item.kind === "text");
      if (object) formatPlaceholder(result, object, layout.type, role);
      else delete layout.placeholders[role];
    }
    result.slideLayouts[slide] = layout;
    return result;
  }

  global.SDSlides = { DEFAULT_THEME, normalizeTheme, normalizeLayout, applyLayout, resetLayout, applyDesignPreview };
})(globalThis);
