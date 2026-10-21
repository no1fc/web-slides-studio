(function (global) {
  "use strict";
  const own = (value, key) => Object.hasOwn(value, key);
  const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  const palette = ["#087e77", "#4979d1", "#e69b38", "#b55b96", "#7e9e48"];
  function record(value, keys, label) {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} 형식 오류`);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !keys.includes(key) || !descriptor.enumerable || !own(descriptor, "value")) throw new Error(`허용되지 않는 ${label} 항목입니다.`);
    }
    return value;
  }
  function array(value, max, label) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new Error(`${label} 배열 형식 또는 개수 오류`);
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !descriptor.enumerable || !own(descriptor, "value")) throw new Error(`${label} 배열 형식 오류`);
    }
    return value;
  }
  function color(value) {
    if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) throw new Error("색상 값 오류");
    return value.toLowerCase();
  }
  function text(value) {
    if (typeof value !== "string" || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error("표·차트 텍스트는 2,000자 이하의 일반 문자열이어야 합니다.");
    return value;
  }
  function font(value) {
    if (!finite(value, 6, 400)) throw new Error("표·차트 글꼴 크기 오류");
    return value;
  }
  function normalizeTable(value = {}) {
    record(value, ["rows", "header", "fontSize", "color", "fill", "headerFill", "border"], "표");
    const raw = own(value, "rows") ? value.rows : [["항목", "값"], ["내용 1", "100"], ["내용 2", "200"]];
    const rows = array(raw, 20, "표 행").map(row => Object.freeze(array(row, 10, "표 열").map(text)));
    if (rows.some(row => row.length !== rows[0].length)) throw new Error("표의 모든 행은 열 개수가 같아야 합니다.");
    const header = own(value, "header") ? value.header : true;
    if (typeof header !== "boolean") throw new Error("표 머리글 값 오류");
    return Object.freeze({ rows: Object.freeze(rows), header, fontSize: font(own(value, "fontSize") ? value.fontSize : 28),
      color: color(own(value, "color") ? value.color : "#17212b"), fill: color(own(value, "fill") ? value.fill : "#ffffff"),
      headerFill: color(own(value, "headerFill") ? value.headerFill : "#dcefed"), border: color(own(value, "border") ? value.border : "#cbd5e1") });
  }
  function normalizeChart(value = {}) {
    record(value, ["type", "categories", "series", "colors", "fontSize"], "차트");
    const type = own(value, "type") ? value.type : "bar";
    if (!["bar", "line", "pie"].includes(type)) throw new Error("차트 종류 오류");
    const categories = array(own(value, "categories") ? value.categories : ["1분기", "2분기", "3분기"], 20, "차트 범주").map(text);
    const defaults = [{ name: "계열 1", values: categories.map((_, index) => (index + 1) * 10) }];
    const series = array(own(value, "series") ? value.series : defaults, 5, "차트 계열").map(item => {
      record(item, ["name", "values"], "차트 계열");
      const name = text(item.name), values = array(item.values, 20, "차트 값").map(value => {
        if (!finite(value, -1e9, 1e9)) throw new Error("차트 값은 유한한 ±10억 범위 숫자여야 합니다.");
        return Object.is(value, -0) ? 0 : value;
      });
      if (values.length !== categories.length) throw new Error("차트 범주와 각 계열의 값 개수가 같아야 합니다.");
      return Object.freeze({ name, values: Object.freeze(values) });
    });
    if (type === "pie" && (series.length !== 1 || series[0].values.some(value => value < 0) || series[0].values.reduce((sum, value) => sum + value, 0) <= 0)) throw new Error("원형 차트는 음이 아닌 값의 한 계열과 양수 합계가 필요합니다.");
    return Object.freeze({ type, categories: Object.freeze(categories), series: Object.freeze(series),
      colors: Object.freeze(array(own(value, "colors") ? value.colors : palette, 20, "차트 색상").map(color)),
      fontSize: font(own(value, "fontSize") ? value.fontSize : 24) });
  }

  const gridLimit = 2_000_000;
  function serializeGrid(rows) {
    let length = 0;
    const lines = array(rows, gridLimit, "데이터 행").map(row => {
      const cells = array(row, gridLimit, "데이터 셀").map(value => {
        if (typeof value !== "string") throw new Error("데이터 셀은 문자열이어야 합니다.");
        if ((length += value.length) > gridLimit) throw new Error("데이터 입력은 2,000,000자 이하여야 합니다.");
        return value === "" || /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
      });
      return cells.join("\t");
    });
    const result = lines.join("\n");
    if (result.length > gridLimit) throw new Error("데이터 입력은 2,000,000자 이하여야 합니다.");
    return result;
  }
  function parseGrid(value) {
    if (typeof value !== "string" || value.length > gridLimit) throw new Error("데이터 입력은 2,000,000자 이하의 문자열이어야 합니다.");
    const rows = [];
    let row = [], field = "", state = "start", needsField = true;
    const pushField = () => { row.push(field); field = ""; state = "start"; };
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (state === "quoted") {
        if (char === '"') {
          if (value[index + 1] === '"') { field += '"'; index++; }
          else state = "closed";
        } else field += char;
        continue;
      }
      if (char === "\t") { pushField(); needsField = true; continue; }
      if (char === "\n" || char === "\r") {
        pushField(); rows.push(row); row = []; needsField = false;
        if (char === "\r" && value[index + 1] === "\n") index++;
        continue;
      }
      if (state === "closed") throw new Error("닫는 큰따옴표 뒤에는 탭 또는 줄바꿈만 사용할 수 있습니다.");
      if (char === '"') {
        if (state !== "start") throw new Error("셀 안의 큰따옴표는 따옴표로 감싸고 두 번 입력해 주세요.");
        state = "quoted";
      } else { field += char; state = "plain"; }
      needsField = true;
    }
    if (state === "quoted") throw new Error("닫히지 않은 큰따옴표가 있습니다.");
    // A terminal record separator is usual spreadsheet clipboard output.
    // Empty fields are quoted when serialized to preserve an actual last row.
    if (needsField) { pushField(); rows.push(row); }
    return rows;
  }

  // Both renderers use this deterministic range and plot rectangle. Including
  // zero keeps negative bars and the all-zero data set meaningful.
  function chartLayout(chart) {
    const values = chart.series.flatMap(series => series.values);
    const min = Math.min(0, ...values), max = Math.max(0, ...values) || (min === 0 ? 1 : 0);
    return Object.freeze({ min, max, step: (max - min) / 4, x: .14, y: .06, w: .81, h: .68 });
  }
  function renderTable(document, table) {
    const element = document.createElement("table");
    element.style.cssText = `display:grid;grid-template-columns:repeat(${table.rows[0].length},minmax(0,1fr));grid-template-rows:repeat(${table.rows.length},minmax(0,1fr));width:100%;height:100%;border-collapse:collapse;border-spacing:0;table-layout:fixed;font-family:Arial,sans-serif;font-size:${table.fontSize}px;color:${table.color};line-height:1.2;overflow:hidden;`;
    const body = document.createElement("tbody"); body.style.display = "contents";
    table.rows.forEach((row, index) => {
      const tr = document.createElement("tr"); tr.style.display = "contents";
      row.forEach(value => {
        const header = table.header && index === 0, cell = document.createElement(header ? "th" : "td");
        if (header) cell.setAttribute("scope", "col");
        cell.style.cssText = `box-sizing:border-box;min-width:0;min-height:0;display:flex;align-items:center;text-align:left;overflow:hidden;padding:8px;border:1px solid ${table.border};background-color:${header ? table.headerFill : table.fill};font-weight:${header ? "700" : "400"};`;
        const span = document.createElement("span");
        span.style.cssText = "display:block;min-width:0;max-height:100%;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;";
        span.textContent = value; cell.append(span); tr.append(cell);
      });
      body.append(tr);
    });
    element.append(body); return element;
  }
  function renderChart(document, chart, width, height) {
    const ns = "http://www.w3.org/2000/svg";
    const make = (name, attrs, content) => {
      const node = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
      if (content !== undefined) node.textContent = content;
      return node;
    };
    const svg = make("svg", { xmlns: ns, width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img", "aria-label": `${chart.type} 차트` });
    svg.style.cssText = "display:block;width:100%;height:100%;overflow:hidden;font-family:Arial,sans-serif;";
    svg.append(make("rect", { width, height, fill: "#ffffff" }));
    const pickColor = index => chart.colors[index % chart.colors.length];
    const label = (x, y, value, attrs = {}) => make("text", { x, y, fill: "#17212b", "font-size": chart.fontSize, ...attrs }, value);
    if (chart.type === "pie") {
      const sum = chart.series[0].values.reduce((a, b) => a + b, 0), cx = width / 2, cy = height * .42, radius = Math.min(width * .42, height * .35);
      let angle = -Math.PI / 2;
      chart.series[0].values.forEach((value, index) => {
        if (value === 0) return;
        const delta = value / sum * Math.PI * 2, end = angle + delta;
        const attrs = { fill: pickColor(index), "data-sd-series": "0", "data-sd-value": value };
        const slice = value === sum ? make("circle", { cx, cy, r: radius, ...attrs }) : make("path", { d: `M ${cx} ${cy} L ${cx + radius * Math.cos(angle)} ${cy + radius * Math.sin(angle)} A ${radius} ${radius} 0 ${delta > Math.PI ? 1 : 0} 1 ${cx + radius * Math.cos(end)} ${cy + radius * Math.sin(end)} Z`, ...attrs });
        slice.append(make("title", {}, `${chart.categories[index]}: ${value}`)); svg.append(slice); angle = end;
      });
    } else {
      const layout = chartLayout(chart), left = width * layout.x, top = height * layout.y, plotW = width * layout.w, plotH = height * layout.h;
      const y = value => top + (layout.max - value) / (layout.max - layout.min) * plotH;
      const slot = plotW / chart.categories.length, baseline = y(0);
      for (let index = 0; index <= 4; index++) {
        const value = layout.min + layout.step * index, yy = y(value);
        svg.append(make("line", { x1: left, y1: yy, x2: left + plotW, y2: yy, stroke: "#dce2e8", "stroke-width": 1 }));
        svg.append(label(left - 8, yy + chart.fontSize * .33, Number(value.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 10 }), { "text-anchor": "end" }));
      }
      svg.append(make("line", { x1: left, y1: baseline, x2: left + plotW, y2: baseline, stroke: "#64748b", "stroke-width": 1 }));
      chart.categories.forEach((category, index) => svg.append(label(left + slot * (index + .5), top + plotH + chart.fontSize * 1.3, category, { "text-anchor": "middle" })));
      chart.series.forEach((series, seriesIndex) => {
        const group = make("g", { "data-sd-series": seriesIndex });
        const points = series.values.map((value, index) => [left + slot * (index + .5), y(value)]);
        if (chart.type === "line") group.append(make("polyline", { points: points.map(point => point.join(",")).join(" "), fill: "none", stroke: pickColor(seriesIndex), "stroke-width": 3 }));
        series.values.forEach((value, index) => {
          const attrs = { fill: pickColor(seriesIndex), "data-sd-value": value };
          const barWidth = slot * .7 / chart.series.length;
          const mark = chart.type === "bar" ? make("rect", { x: left + slot * (index + .15) + barWidth * seriesIndex, y: Math.min(y(value), baseline), width: barWidth, height: Math.abs(y(value) - baseline), ...attrs }) : make("circle", { cx: points[index][0], cy: points[index][1], r: 4, ...attrs });
          mark.append(make("title", {}, `${series.name}, ${chart.categories[index]}: ${value}`)); group.append(mark);
        });
        svg.append(group);
      });
    }
    const names = chart.type === "pie" ? chart.categories : chart.series.map(series => series.name);
    const legend = make("g", { "data-sd-legend": "" }), entries = names.map((name, index) => ({ name, index, w: Math.min(width * .8, (name.length * .6 + 2) * chart.fontSize) }));
    let legendX = Math.max(8, (width - entries.reduce((sum, entry) => sum + entry.w, 0)) / 2), legendY = height * .91;
    for (const entry of entries) {
      if (legendX + entry.w > width && legendX > 8) { legendX = 8; legendY += chart.fontSize * 1.3; }
      legend.append(make("rect", { x: legendX, y: legendY - chart.fontSize * .7, width: chart.fontSize * .6, height: chart.fontSize * .6, fill: pickColor(entry.index) }));
      legend.append(label(legendX + chart.fontSize, legendY, entry.name)); legendX += entry.w;
    }
    svg.append(legend); return svg;
  }
  function render(element, object) {
    if (!element?.ownerDocument || !object || !["table", "chart"].includes(object.kind)) throw new Error("표·차트 렌더링 대상 오류");
    if (object.rotate || own(object, "group")) throw new Error("표·차트는 그룹화와 회전을 지원하지 않습니다.");
    const width = object.w ?? 720, height = object.h ?? 400;
    if (!finite(width, 1, 5000) || !finite(height, 1, 5000)) throw new Error("표·차트 크기 오류");
    const child = object.kind === "table" ? renderTable(element.ownerDocument, normalizeTable(object.table)) : renderChart(element.ownerDocument, normalizeChart(object.chart), width, height);
    element.replaceChildren(child); return element;
  }
  global.SDData = Object.freeze({ normalizeTable, normalizeChart, serializeGrid, parseGrid, chartLayout, render });
})(globalThis);
