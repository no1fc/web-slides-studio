import "../public/data-model.js";
import JSZip from "jszip";

const Data = globalThis.SDData;
const color = value => value.slice(1).toUpperCase();
const finite = value => typeof value === "number" && Number.isFinite(value);

/** Add a native editable table or chart. Scene coordinates are 144 px/in. */
export function addDataObject(slide, object, objectName) {
  if (!object || !["table", "chart"].includes(object.kind) || ![object.x, object.y, object.w, object.h].every(finite) || object.w <= 0 || object.h <= 0 || object.rotate || Object.hasOwn(object, "group")) throw new Error("네이티브 표·차트의 위치·크기·회전 값 오류");
  const frame = { x: object.x / 144, y: object.y / 144, w: object.w / 144, h: object.h / 144, objectName };
  if (object.kind === "table") {
    const table = Data.normalizeTable(object.table);
    const rows = table.rows.map((row, index) => row.map(text => ({ text, options: {
      bold: table.header && index === 0, fill: { color: color(table.header && index === 0 ? table.headerFill : table.fill) },
    } })));
    slide.addTable(rows, { ...frame, autoPage: false, rowH: frame.h / rows.length, colW: Array(rows[0].length).fill(frame.w / rows[0].length),
      margin: 8 / 144, fontFace: "Arial", fontSize: table.fontSize / 2, color: color(table.color),
      border: { type: "solid", pt: .5, color: color(table.border) }, align: "left", valign: "middle", breakLine: false, paraSpaceAfter: 0 });
    return;
  }
  const chart = Data.normalizeChart(object.chart), layout = Data.chartLayout(chart);
  const count = chart.type === "pie" ? chart.categories.length : chart.series.length;
  const chartColors = Array.from({ length: count }, (_, index) => color(chart.colors[index % chart.colors.length]));
  const data = chart.series.map(series => ({ name: series.name, labels: [...chart.categories], values: [...series.values] }));
  slide.addChart(chart.type, data, { ...frame, chartColors, showTitle: false, showLegend: true, legendPos: "b", showValue: false, showLabel: false,
    showPercent: false, showSerName: false,
    legendFontFace: "Arial", legendFontSize: chart.fontSize / 2, legendColor: "17212B",
    chartArea: { fill: { color: "FFFFFF" }, roundedCorners: false }, plotArea: { fill: { color: "FFFFFF" } },
    layout: chart.type === "pie" ? { x: .08, y: .07, w: .84, h: .7 } : { x: layout.x, y: layout.y, w: layout.w, h: layout.h },
    catAxisLabelFontFace: "Arial", catAxisLabelFontSize: chart.fontSize / 2, catAxisLabelColor: "17212B", catAxisLabelPos: "low", catAxisLineColor: "64748B", catAxisLineSize: .5,
    catAxisMajorTickMark: "none", catAxisMinorTickMark: "none", catAxisLabelRotate: 0, catAxisLabelFrequency: 1,
    valAxisLabelFontFace: "Arial", valAxisLabelFontSize: chart.fontSize / 2, valAxisLabelColor: "17212B", valAxisLabelFormatCode: "General", valAxisLineShow: false,
    valAxisMajorTickMark: "none", valAxisMinorTickMark: "none", valAxisMinVal: layout.min, valAxisMaxVal: layout.max, valAxisMajorUnit: layout.step,
    valGridLine: { color: "DCE2E8", size: .5 }, catGridLine: { style: "none" },
    // OOXML gap width is relative to a single bar, whereas SVG reserves 30%
    // of each category for spacing around the entire cluster.
    barDir: "col", barGrouping: "clustered", barGapWidthPct: Math.round(300 / 7 * chart.series.length), lineSize: 1.5, lineDataSymbol: "circle", lineDataSymbolSize: 4, lineDataSymbolLineSize: .001, lineSmooth: false, firstSliceAng: 0 });
}

/** Repair PptxGenJS 4 table IDs before object animation targets are added.
 * Its table counter is independent of the other shapes, producing duplicate
 * cNvPr IDs in mixed slides. Preserve every existing non-table ID and name.
 * This function accepts only our generated PPTX, never untrusted imports.
 */
export async function finalizeDataPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const file of zip.file(/^ppt\/slides\/slide\d+\.xml$/)) {
    const original = await file.async("string"), counts = new Map();
    for (const match of original.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    let next = Math.max(1, ...[...counts.keys()].map(Number)) + 1;
    const xml = original.replace(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g, frame => {
      if (!/<a:tbl[\s>]/.test(frame)) return frame;
      return frame.replace(/(<p:cNvPr\b[^>]*\bid=")(\d+)(")/, (all, before, id, after) => {
        if (counts.get(id) < 2) return all;
        counts.set(id, counts.get(id) - 1);
        return before + next++ + after;
      });
    });
    if (xml !== original) { zip.file(file.name, xml); changed = true; }
  }
  return changed ? zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : buffer;
}
