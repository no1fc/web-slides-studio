import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
import { prepareDeck } from "../src/deck.js";
import { exportDeck } from "../src/export.js";

test("PPTX captures delayed finite entrances and pseudo-elements without changing saved animations", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-export-animation-"));
  const app = await startStudio({ root, port: 0, contentPort: 0 });
  let browser;
  try {
    const prepared = prepareDeck(`<html><head><style>
      html,body{margin:0;background:white}#stage{width:1920px;height:1080px;position:relative}
      .slide{position:absolute;inset:0;display:none}.slide.active{display:block}
      .entrance{position:absolute;left:100px;top:100px;width:200px;height:200px;background:rgb(255,0,0);opacity:0}
      .slide.active .entrance{animation:enter 2s 30s forwards}
      .entrance::after{content:"";position:absolute;left:300px;top:0;width:200px;height:200px;background:rgb(0,0,255);opacity:0;animation:enter 2s 30s forwards}
      .decoration{position:absolute;left:700px;top:100px;width:200px;height:200px;background:rgb(255,255,0);animation:spin 2s linear infinite}
      @keyframes enter{from{opacity:0;transform:translateY(100px)}to{opacity:1;transform:translateY(0)}}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style></head><body><main id="stage"><section class="slide active"><div class="entrance"></div><div class="decoration"></div></section><section class="slide"><div class="entrance"></div></section></main></body></html>`);
    const deck = await app.store.create({ ...prepared, files: new Map([["index.html", Buffer.from(prepared.html)]]) });
    const assetPath = app.store.path(deck.id, "assets/index.html");
    const before = await readFile(assetPath, "utf8");
    const args = { store: app.store, deck, url: `${app.contentOrigin}/v/${deck.id}/${deck.previewToken}/index.html`, contentOrigin: app.contentOrigin };
    const output = await exportDeck({ ...args, format: "pptx" });
    const zip = await JSZip.loadAsync(output.buffer);
    const media = Object.values(zip.files).filter(file => /^ppt\/media\/.*\.jpe?g$/.test(file.name));
    assert.equal(media.length, 2);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    for (const [index, file] of media.entries()) {
      const pixels = await page.evaluate(async src => {
        const image = new Image(); image.src = src; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
        return [150, 450, 800].map(x => [...context.getImageData(x, 200, 1, 1).data]);
      }, "data:image/jpeg;base64," + await file.async("base64"));
      assert.ok(pixels[0][0] > 240 && pixels[0][1] < 15, `delayed entrance must be red, got ${pixels[0]}`);
      assert.ok(pixels[1][2] > 240 && pixels[1][0] < 15, `pseudo-element must be blue, got ${pixels[1]}`);
      if (index === 0) assert.ok(pixels[2][0] > 240 && pixels[2][1] > 240 && pixels[2][2] < 15, "infinite decoration remains visible without waiting for completion");
    }
    assert.equal(await readFile(assetPath, "utf8"), before);
    assert.equal((await app.store.get(deck.id)).revision, deck.revision);
    const html = await JSZip.loadAsync((await exportDeck({ ...args, format: "html" })).buffer);
    assert.match(await html.file("index.html").async("string"), /animation:enter 2s 30s forwards/);
    await page.goto(args.url);
    assert.equal(await page.locator(".slide.active .entrance").evaluate(el => getComputedStyle(el).opacity), "0", "regular presentation still plays its original entrance");
  } finally {
    await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true });
  }
});
