import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { startStudio } from "../src/server.js";
import { importArchive } from "../src/archive.js";
import { exportDeck } from "../src/export.js";
test(
  "HTML/PDF/PPTX exports use same saved revision",
  async () => {
    const app = await startStudio({
      port: 0,
      contentPort: 0,
      root: await mkdtemp(join(tmpdir(), "studio-export-")),
    });
    try {
      const z = new JSZip();
      z.file(
        "index.html",
        '<html><head><title>출력</title><style>body{margin:0;background:#123;color:white}main{width:1920px;height:1080px;position:relative}.slide{position:absolute;inset:0;display:none;padding:80px}.slide.active{display:block}h1{font-size:64px}</style></head><body><main id="stage"><section class="slide"><h1>첫째</h1></section><section class="slide"><h1>둘째</h1></section></main></body></html>',
      );
      let d = await app.store.create(
        await importArchive(await z.generateAsync({ type: "nodebuffer" })),
      );
      d.state.patches.e0 = { text: "변경된 제목" };
      d = await app.store.save(d.id, 1, d.state);
      const args = {
        store: app.store,
        deck: d,
        url: `${app.contentOrigin}/v/${d.id}/${d.previewToken}/index.html?rev=${d.revision}`,
        contentOrigin: app.contentOrigin,
      };
      const html = await exportDeck({ ...args, format: "html" });
      const zip = await JSZip.loadAsync(html.buffer);
      assert.match(await zip.file("index.html").async("string"), /변경된 제목/);
      assert.ok(zip.file("assets/studio-viewer.js"));
      const pdf = await exportDeck({ ...args, format: "pdf" });
      const doc = await PDFDocument.load(pdf.buffer);
      assert.equal(doc.getPageCount(), 2);
      assert.equal(
        doc.getPage(0).getWidth() / doc.getPage(0).getHeight(),
        16 / 9,
      );
      const ppt = await exportDeck({ ...args, format: "pptx-editable" });
      const pz = await JSZip.loadAsync(ppt.buffer);
      assert.equal(
        Object.keys(pz.files).filter((p) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(p),
        ).length,
        2,
      );
      assert.match(
        await pz.file("ppt/slides/slide1.xml").async("string"),
        /변경된 제목/,
      );
    } finally {
      await app.close();
    }
  },
  { timeout: 90000 },
);
