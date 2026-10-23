import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import pptxgen from "pptxgenjs";
import { withoutNotesHtml, withoutNotesDeck, redactNoteText } from "./notes-policy.js";
import { renderDeck } from "./deck.js";
import { collectFiles } from "./files.js";
import { finalizeTextPptx } from "./text-export.js";
import { finalizeEffectsPptx } from "./effects-export.js";
import { finalizeDataPptx } from "./data-export.js";
import { prepareNativeObjects, addNativeObjects, finalizeObjectPptx } from "./object-export.js";
const publicDir = new URL("../public/", import.meta.url);
export async function exportDeck({ store, deck, format, url, contentOrigin, includeNotes = true }) {
  const originalDeck=deck;
  if(!includeNotes) deck=withoutNotesDeck(deck);
  const effectMappings = [];
  const root = store.path(deck.id, "assets");
  if (format === "html") {
    const zip = new JSZip();
    for (const p of await collectFiles(root)) {
      if (p === "index.html") continue;
      let bytes=await readFile(join(root,p));
      if(!includeNotes && /\.(html|js|json|css|svg)$/i.test(p)) {
        let text=bytes.toString('utf8');
        text=/\.html$/i.test(p)?withoutNotesHtml(text,originalDeck):redactNoteText(text,originalDeck);
        bytes=Buffer.from(text);
      }
      zip.file(p, bytes);
    }
    let html = renderDeck(
      await readFile(join(root, "index.html"), "utf8"),
      { ...deck.state, notes: { ...deck.sourceNotes, ...deck.state.notes } },
    );
    if(!includeNotes) html=withoutNotesHtml(html,originalDeck);
    const config = JSON.stringify({
      edit: false,
      managerOrigin: "",
      state: deck.state,
    }).replaceAll("<", "\\u003c");
    const bootstrap =
      '<script>try{const m=new Map();Object.defineProperty(window,"localStorage",{value:{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}})}catch{}</script>';
    html = html
      .replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8"><script src="assets/studio-presentation.js"></script>' + bootstrap)
      .replace(
        /<\/body>/i,
        `<script id="sd-config" type="application/json">${config}</script><script src="assets/studio-object-model.js"></script><script src="assets/studio-data-model.js"></script><script src="assets/studio-effects.js"></script><script src="assets/studio-text-model.js"></script><script src="assets/studio-text-editor.js"></script><script src="assets/studio-viewer.js"></script></body>`,
      );
    zip.file("index.html", html);
    for (const [source, target] of [["presentation.js", "studio-presentation.js"], ["data-model.js", "studio-data-model.js"], ["effects.js", "studio-effects.js"], ["object-model.js", "studio-object-model.js"], ["text-model.js", "studio-text-model.js"], ["text-editor.js", "studio-text-editor.js"], ["bridge.js", "studio-viewer.js"]]) {
      zip.file("assets/" + target, await readFile(new URL(source, publicDir)));
    }
    zip.file(
      "README.txt",
      `SDLAB Slides\n저장 버전: ${deck.revision}\n압축을 풀고 index.html을 브라우저에서 여세요.\n이 파일은 발표용입니다. 수정 내용은 자료실에서 관리하세요.\n${includeNotes ? "발표자 노트도 HTML 원본에 포함되며, 파일을 받은 사람이 읽을 수 있습니다." : "발표자 노트는 제외했습니다."}\n`,
    );
    return {
      buffer: await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
      }),
      mime: "application/zip",
      extension: "zip",
    };
  }
  let browser;
  let timeout;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      env: { PATH: process.env.PATH, HOME: "/tmp", LANG: "C.UTF-8" },
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-unsafe-swiftshader",
      ],
    });
    timeout = setTimeout(() => browser.close().catch(() => {}), 180000);
    timeout.unref();
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const prefix = new URL(url).pathname.replace(/index\.html$/, "");
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      const allowed =
        u.origin === contentOrigin &&
        (u.pathname.startsWith(prefix) ||
          ["/_studio/presentation.js", "/_studio/bridge.js", "/_studio/object-model.js", "/_studio/text-model.js", "/_studio/text-editor.js", "/_studio/data-model.js", "/_studio/effects.js"].includes(u.pathname)) &&
        route.request().method() === "GET";
      return allowed ? route.continue() : route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForFunction(() => !!window.__sd);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.__sd.clean());
    const count = await page.evaluate(() => window.__sd.count);
    if (count !== deck.state.order.length)
      throw new Error("슬라이드 수가 저장 버전과 일치하지 않습니다.");
    const pdf = format === "pdf" ? await PDFDocument.create() : null;
    const ppt = format.startsWith("pptx") ? new pptxgen() : null;
    if (ppt) {
      ppt.layout = "LAYOUT_WIDE";
      ppt.author = "SDLAB Slides";
      ppt.subject = `Revision ${deck.revision}`;
      ppt.title = deck.title;
      ppt.lang = "ko-KR";
      ppt.theme = {
        headFontFace: deck.state.theme?.fonts?.heading || "Arial",
        bodyFontFace: deck.state.theme?.fonts?.body || "Arial",
        lang: "ko-KR",
      };
    }
    const nativeTextSlides = [];
    const nativePictureSlides = [];
    for (let i = 0; i < count; i++) {
      await page.evaluate((n) => window.__sd.go(n), i);
      await page.waitForTimeout(1000);
      await page.evaluate(async () => {
        await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
        window.SDObjects?.refresh(document);
      });
      if (pdf) {
        const bytes = await page.screenshot({ type: "jpeg", quality: 94 });
        const img = await pdf.embedJpg(bytes);
        pdf
          .addPage([960, 540])
          .drawImage(img, { x: 0, y: 0, width: 960, height: 540 });
        continue;
      }
      const slide = ppt.addSlide();
      const nativeTextShapes = [];
      nativeTextSlides.push(nativeTextShapes);
      const nativePictures = [];
      nativePictureSlides.push(nativePictures);
      let prepared = { entries: [], hideIds: [] };
      if (format === "pptx-editable") {
        prepared = await prepareNativeObjects(await page.evaluate(() => window.__sd.collect()), {
          root, url, contentOrigin,
          captureLegacyImage: e => page.locator(`[data-sd-id="${e.id}"]`).screenshot({ type: "png", timeout: 4000 }),
          convertSourceImage: source => page.evaluate(async src => {
            const image = new Image(); image.src = src; await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            canvas.getContext("2d").drawImage(image, 0, 0);
            return canvas.toDataURL("image/png");
          }, source),
        });
        await page.evaluate(
          (ids) => window.__sd.hideNative(ids),
          prepared.hideIds,
        );
      }
      const background = await page.screenshot({ type: "jpeg", quality: 94 });
      slide.addImage({
        data: "image/jpeg;base64," + background.toString("base64"),
        x: 0,
        y: 0,
        w: 13.333333,
        h: 7.5,
      });
      const mapping = []; effectMappings.push(mapping);
      addNativeObjects(slide, prepared.entries, nativeTextShapes, nativePictures, mapping);
      const skippedEffects = deck.state.added.filter(a => a.slide === deck.state.order[i] && ["appear", "fade"].includes(deck.state.animations?.[a.id]) && !mapping.some(m => m.id === a.id || m.id.startsWith(a.id + "--")));
      const note = deck.state.notes?.[deck.state.order[i]] ?? deck.sourceNotes?.[deck.state.order[i]] ?? "";
      const provenance = `SDLAB Slides · 저장 버전 ${deck.revision} · ${i + 1}/${count}\n웹의 3D 배경은 정지 화면입니다. 편집 모드는 글꼴 및 줄바꿈 차이가 있을 수 있습니다.`;
      const warning = skippedEffects.length ? `\n호환성 알림: 배경 이미지에 포함된 개체 ${skippedEffects.length}개의 진입 효과는 적용하지 않았습니다.` : "";
      slide.addNotes((note ? `${note}\n\n${provenance}` : provenance) + warning);
      if (format === "pptx-editable")
        await page.evaluate(() => window.__sd.showNative());
    }
    if (pdf)
      return {
        buffer: Buffer.from(await pdf.save()),
        mime: "application/pdf",
        extension: "pdf",
      };
    return {
      buffer: await finalizeEffectsPptx(await finalizeDataPptx(await finalizeObjectPptx(await finalizeTextPptx(await ppt.write({ outputType: "nodebuffer" }), nativeTextSlides), nativePictureSlides)), deck.state, effectMappings),
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: "pptx",
    };
  } finally {
    clearTimeout(timeout);
    await browser?.close();
  }
}
