import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import "../public/text-model.js";

const T = globalThis.SDText;
const rich = runs => ({ paragraphs: [{ runs }] });

test("theme runs remain distinct from absolute runs and reject ambiguous or invalid references", () => {
  const source = rich([{ text: "Head", fontTheme: "heading", colorTheme: "accent" }, { text: "ing", fontTheme: "heading", colorTheme: "accent" }, { text: " body", fontTheme: "body", colorTheme: "text" }]);
  assert.deepEqual(T.normalizeRichText(source), rich([{ text: "Heading", fontTheme: "heading", colorTheme: "accent" }, { text: " body", fontTheme: "body", colorTheme: "text" }]));
  assert.equal(source.paragraphs[0].runs.length, 3);
  for (const style of [{ fontTheme: "caption" }, { colorTheme: "background" }, { fontTheme: null }, { colorTheme: 1 }, { fontTheme: "body", fontFamily: "Arial" }, { colorTheme: "accent", color: "#112233" }])
    assert.throws(() => T.normalizeRichText(rich([{ text: "bad", ...style }])));
});

test("selected absolute formatting detaches only its corresponding theme reference", () => {
  const source = rich([{ text: "ABCD", fontTheme: "heading", colorTheme: "text" }]);
  const changed = T.formatRichText(source, { start: 1, end: 3 }, "character", { fontFamily: "Georgia", bold: true });
  assert.deepEqual(changed.paragraphs[0].runs, [
    { text: "A", fontTheme: "heading", colorTheme: "text" },
    { text: "BC", fontFamily: "Georgia", colorTheme: "text", bold: true },
    { text: "D", fontTheme: "heading", colorTheme: "text" },
  ]);
  const colored = T.formatRichText(changed, { start: 2, end: 4 }, "character", { color: "#ABCDEF" });
  assert.deepEqual(colored.paragraphs[0].runs.slice(2), [
    { text: "C", fontFamily: "Georgia", color: "#abcdef", bold: true },
    { text: "D", fontTheme: "heading", color: "#abcdef" },
  ]);
  assert.deepEqual(source, rich([{ text: "ABCD", fontTheme: "heading", colorTheme: "text" }]));
});

test("setting theme references clears absolute values only within the selected range", () => {
  const source = rich([{ text: "ABC", fontFamily: "Georgia", color: "#112233" }]);
  assert.deepEqual(T.formatRichText(source, { start: 1, end: 2 }, "character", { fontTheme: "body", colorTheme: "accent" }), rich([
    { text: "A", fontFamily: "Georgia", color: "#112233" },
    { text: "B", fontTheme: "body", colorTheme: "accent" },
    { text: "C", fontFamily: "Georgia", color: "#112233" },
  ]));
  assert.deepEqual(T.formatRichText(source, null, "character", { fontTheme: "heading", colorTheme: "text" }), rich([{ text: "ABC", fontTheme: "heading", colorTheme: "text" }]));
  assert.throws(() => T.formatRichText(source, null, "character", { fontTheme: "body", fontFamily: "Arial" }));
});

test("rendering uses theme CSS variables while canonical markup keeps references and explicit runs", () => {
  const { document } = parseHTML("<html><body><div></div></body></html>");
  const el = document.querySelector("div"), source = rich([
    { text: "Theme", fontTheme: "heading", colorTheme: "accent" },
    { text: "Fixed", fontFamily: "Georgia", color: "#112233" },
    { text: "Body", fontTheme: "body", colorTheme: "text" },
  ]);
  T.renderRichText(el, source);
  const spans = [...el.querySelectorAll("[data-sd-run]")];
  assert.equal(spans[0].style.fontFamily, "var(--sd-theme-heading-font)");
  assert.equal(spans[0].style.color, "var(--sd-theme-accent)");
  assert.equal(spans[0].style.webkitTextFillColor, "var(--sd-theme-accent)");
  assert.equal(spans[1].style.fontFamily, "Georgia");
  assert.equal(spans[1].style.color, "#112233");
  assert.equal(spans[2].style.fontFamily, "var(--sd-theme-body-font)");
  assert.equal(spans[2].style.color, "var(--sd-theme-text)");
  assert.deepEqual(JSON.parse(el.dataset.sdRichText), source);
});
