import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import "../public/data-model.js";

const Data = globalThis.SDData;
const chart = { type: "bar", categories: ["한글", "<img src=x>"], series: [{ name: "실적", values: [-10, 30] }, { name: "목표", values: [20, 10] }], colors: ["#123ABC", "#EF4567"], fontSize: 24 };

test("table normalization supplies defaults, copies values and deeply freezes the result", () => {
  const input = { rows: [["항목", "값"], ["<script>alert(1)</script>", "42"]], color: "#ABCDEF" };
  const value = Data.normalizeTable(input);
  assert.equal(value.color, "#abcdef");
  assert.equal(value.header, true);
  input.rows[1][1] = "changed";
  assert.equal(value.rows[1][1], "42");
  assert.throws(() => value.rows[0].push("mutation"), TypeError);
  assert.throws(() => { value.fill = "#000000"; }, TypeError);
  assert.ok(Data.normalizeTable().rows.length > 0);
  assert.deepEqual(Data.normalizeTable(value), value);
});

test("table normalization rejects ragged, oversized and non-text cells", () => {
  for (const value of [null, [], { rows: [] }, { rows: [[]] }, { rows: [["a"], ["b", "c"]] }, { rows: [[1]] },
    { rows: [["a".repeat(2001)]] }, { rows: Array.from({ length: 21 }, () => ["x"]) }, { rows: [Array(11).fill("x")] },
    { header: "yes" }, { fontSize: NaN }, { fontSize: 0 }, { color: "red" }, { fill: "url(x)" }, { border: "none" }, { html: "x" }]) {
    assert.throws(() => Data.normalizeTable(value));
  }
  assert.equal(Data.normalizeTable({ rows: Array.from({ length: 20 }, () => Array(10).fill("x".repeat(2000))) }).rows.length, 20);
});

test("plain records and dense data arrays reject inherited, hidden and accessor input without executing getters", () => {
  let calls = 0;
  const accessor = { get rows() { calls++; return [["bad"]]; } };
  const arrayGetter = ["x"];
  Object.defineProperty(arrayGetter, "0", { get() { calls++; return "bad"; }, enumerable: true });
  const extra = ["x"]; extra.extra = true;
  const inheritedArray = ["x"]; Object.setPrototypeOf(inheritedArray, Object.create(Array.prototype));
  for (const value of [accessor, Object.create({ rows: [["x"]] }), { rows: [arrayGetter] }, { rows: [extra] }, { rows: [inheritedArray] },
    { rows: [Array(1)] }, Object.defineProperty({}, "rows", { value: [["x"]] }), { [Symbol("x")]: 1 }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => Data.normalizeTable(value));
  }
  const seriesAccessor = { get name() { calls++; return "bad"; }, values: [1] };
  assert.throws(() => Data.normalizeChart({ categories: ["x"], series: [seriesAccessor] }));
  assert.equal(calls, 0);
});

test("chart normalization validates coherent series and pie data without mutating callers", () => {
  const input = structuredClone(chart), value = Data.normalizeChart(input);
  assert.deepEqual(value.colors, ["#123abc", "#ef4567"]);
  input.series[0].values[0] = 999;
  assert.equal(value.series[0].values[0], -10);
  assert.throws(() => value.series[0].values.push(5), TypeError);
  assert.ok(Data.normalizeChart().categories.length);
  for (const override of [{ type: "scatter" }, { categories: [] }, { categories: Array(21).fill("x") }, { series: [] },
    { series: Array.from({ length: 6 }, () => ({ name: "x", values: [1, 2] })) }, { series: [{ name: "x", values: [1] }] },
    { series: [{ name: "x", values: [Infinity, 2] }] }, { series: [{ name: "x", values: [1e9 + 1, 2] }] },
    { series: [{ name: "x", values: ["1", 2] }] }, { colors: [] }, { colors: ["red"] }, { type: "pie" }]) {
    assert.throws(() => Data.normalizeChart({ ...chart, ...override }));
  }
  assert.throws(() => Data.normalizeChart({ type: "pie", categories: ["a", "b"], series: [{ name: "x", values: [0, 0] }] }));
  assert.throws(() => Data.normalizeChart({ type: "pie", categories: ["a", "b"], series: [{ name: "x", values: [-1, 2] }] }));
  assert.equal(Data.normalizeChart({ type: "pie", categories: ["a", "b"], series: [{ name: "x", values: [0, 2] }] }).type, "pie");
});

test("table renderer escapes cell text, marks headers and fits uniform cells inside the caller's frame", () => {
  const { document } = parseHTML('<div id="host" style="position:absolute;left:12px"><i>old</i></div>');
  const host = document.getElementById("host");
  Data.render(host, { kind: "table", w: 600, h: 240, table: { rows: [["헤더", "<script>x</script>"], ["내용", "2"]], headerFill: "#123456", fill: "#abcdef", border: "#456789" } });
  assert.equal(host.querySelector("i"), null);
  assert.equal(host.querySelector("script"), null);
  assert.equal(host.querySelectorAll("th").length, 2);
  assert.equal(host.querySelectorAll("td").length, 2);
  assert.equal(host.querySelectorAll("th")[1].textContent, "<script>x</script>");
  assert.equal(host.querySelector("th").style.backgroundColor, "#123456");
  assert.equal(host.querySelector("td").style.backgroundColor, "#abcdef");
  assert.match(host.querySelector("td").style.border, /#456789/);
  assert.equal(host.firstElementChild.style.width, "100%");
  assert.equal(host.firstElementChild.style.height, "100%");
  assert.equal(host.style.left, "12px");
});

test("SVG bar and line renderers preserve negative values, series colors and categorical labels", () => {
  const { document } = parseHTML('<div id="host"></div>'), host = document.getElementById("host");
  for (const type of ["bar", "line"]) {
    Data.render(host, { kind: "chart", w: 720, h: 400, chart: { ...chart, type } });
    const svg = host.querySelector("svg");
    assert.equal(svg.getAttribute("viewBox"), "0 0 720 400");
    assert.equal(svg.getAttribute("width"), "100%");
    assert.equal(host.querySelector("img"), null);
    assert.match(svg.textContent, /<img src=x>/);
    assert.match(svg.textContent, /실적/);
    assert.match(svg.textContent, /-10/);
    assert.ok(svg.querySelector('[data-sd-series="0"]'));
    const marks = [...svg.querySelectorAll(type === "bar" ? "rect[data-sd-value]" : "circle[data-sd-value]")];
    assert.equal(marks.length, 4);
    assert.equal(marks[0].getAttribute("fill"), "#123abc");
    assert.equal(marks[0].getAttribute("data-sd-value"), "-10");
    assert.ok(marks.every(mark => !/NaN|Infinity/.test(mark.outerHTML)));
  }
});

test("pie renderer draws a full single nonzero slice and never produces invalid SVG for zero categories", () => {
  const { document } = parseHTML('<div></div>'), host = document.querySelector("div");
  Data.render(host, { kind: "chart", w: 640, h: 360, chart: { type: "pie", categories: ["zero", "all"], series: [{ name: "share", values: [0, 5] }], colors: ["#123456", "#abcdef"] } });
  const slice = host.querySelector('[data-sd-value="5"]');
  assert.ok(slice);
  assert.equal(slice.getAttribute("fill"), "#abcdef");
  assert.doesNotMatch(host.innerHTML, /NaN|Infinity/);
  assert.equal(host.querySelectorAll('[data-sd-value="0"]').length, 0);
  assert.match(host.textContent, /zero/);
});

test("quoted TSV preserves multiline cells, tabs, quotes, CRLF and intentional final empty cells", () => {
  const rows = [["항목\t이름", "값\n둘째 줄", 'He said "yes"', ""], ["Windows\r\nline", "", "plain", ""], ["", "", "", ""]];
  const serialized = Data.serializeGrid(rows);
  assert.deepEqual(Data.parseGrid(serialized), rows);
  assert.deepEqual(Data.parseGrid('A\tB\t\r\n"one\r\ntwo"\t"a""b"\t\r\n'), [["A", "B", ""], ["one\r\ntwo", 'a"b', ""]]);
  assert.deepEqual(Data.parseGrid(""), [[""]]);
  assert.deepEqual(Data.parseGrid("A\t"), [["A", ""]]);
  assert.deepEqual(Data.parseGrid('""\n""'), [[""], [""]]);
  assert.deepEqual(Data.parseGrid("A\n\n"), [["A"], [""]]);
});

test("quoted TSV rejects malformed quoting, non-string cells and oversized input", () => {
  for (const value of ['"unfinished', '"quoted"suffix', '"quoted" \tB', 'unquoted"quote', null, 42, "x".repeat(2000001)]) assert.throws(() => Data.parseGrid(value));
  for (const value of [null, [], [[]], [[12]], [Array(1)], [["x".repeat(2000001)]]]) assert.throws(() => Data.serializeGrid(value));
  let calls = 0;
  const cells = ["x"]; Object.defineProperty(cells, "0", { enumerable: true, get() { calls++; return "x"; } });
  assert.throws(() => Data.serializeGrid([cells]));
  assert.equal(calls, 0);
});
