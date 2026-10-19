import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import pptxgen from "pptxgenjs";
import { renderDeck } from "./deck.js";
import { collectFiles } from "./files.js";
const publicDir = new URL("../public/", import.meta.url);
export async function exportDeck({ store, deck, format, url, contentOrigin }) {
  const root = store.path(deck.id, "assets");
  if (format === "html") {
    const zip = new JSZip();
    for (const p of await collectFiles(root)) {
      if (p === "index.html") continue;
      zip.file(p, await readFile(join(root, p)));
    }
    let html = renderDeck(
      await readFile(join(root, "index.html"), "utf8"),
      deck.state,
    );
    const config = JSON.stringify({
      edit: false,
      managerOrigin: "",
      state: deck.state,
    }).replaceAll("<", "\\u003c");
    const bootstrap =
      '<script>try{const m=new Map();Object.defineProperty(window,"localStorage",{value:{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}})}catch{}</script>';
    html = html
      .replace(/<head([^>]*)>/i, "<head$1>" + bootstrap)
      .replace(
        /<\/body>/i,
        `<script id="sd-config" type="application/json">${config}</script><script src="assets/studio-viewer.js"></script></body>`,
      );
    zip.file("index.html", html);
    zip.file(
      "assets/studio-viewer.js",
      await readFile(new URL("bridge.js", publicDir)),
    );
    zip.file(
      "README.txt",
      `SDLAB Slides\n저장 버전: ${deck.revision}\n압축을 풀고 index.html을 브라우저에서 여세요.\n이 파일은 발표용입니다. 수정 내용은 자료실에서 관리하세요.\n`,
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
          u.pathname === "/_studio/bridge.js") &&
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
    }
    for (let i = 0; i < count; i++) {
      await page.evaluate((n) => window.__sd.go(n), i);
      await page.waitForTimeout(1000);
      if (pdf) {
        const bytes = await page.screenshot({ type: "jpeg", quality: 94 });
        const img = await pdf.embedJpg(bytes);
        pdf
          .addPage([960, 540])
          .drawImage(img, { x: 0, y: 0, width: 960, height: 540 });
        continue;
      }
      const slide = ppt.addSlide();
      let native = [];
      const nativeImages = new Map();
      if (format === "pptx-editable") {
        native = await page.evaluate(() => window.__sd.collect());
        native = native.filter(
          (e) =>
            e.x >= 0 &&
            e.y >= 0 &&
            e.x + e.w <= 1922 &&
            e.y + e.h <= 1082 &&
            e.w > 0 &&
            e.h > 0,
        );
        for (const e of native.filter((e) => e.kind === "image")) {
          try {
            nativeImages.set(
              e.id,
              await page
                .locator(`[data-sd-id="${e.id}"]`)
                .screenshot({ type: "png", timeout: 4000 }),
            );
          } catch {
            native = native.filter((n) => n.id !== e.id);
          }
        }
        await page.evaluate(
          (ids) => window.__sd.hideNative(ids),
          native.map((e) => e.id),
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
      for (const e of native) {
        const box = { x: e.x / 144, y: e.y / 144, w: e.w / 144, h: e.h / 144 };
        if (e.kind === "image") {
          slide.addImage({
            data:
              "image/png;base64," + nativeImages.get(e.id).toString("base64"),
            ...box,
          });
        } else {
          slide.addText(e.text, {
            ...box,
            fontFace: "맑은 고딕",
            fontSize: Math.max(4, e.fontSize / 2),
            color: e.color,
            bold: e.bold,
            align: e.align,
            margin: 0,
            breakLine: false,
            valign: "top",
            fit: "shrink",
            rotate: e.rotate,
            lang: "ko-KR",
          });
        }
      }
      slide.addNotes(
        `SDLAB Slides · 저장 버전 ${deck.revision} · ${i + 1}/${count}\n웹의 3D 배경은 정지 화면입니다. 편집 모드는 글꼴 및 줄바꿈 차이가 있을 수 있습니다.`,
      );
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
      buffer: await ppt.write({ outputType: "nodebuffer" }),
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: "pptx",
    };
  } finally {
    clearTimeout(timeout);
    await browser?.close();
  }
}
