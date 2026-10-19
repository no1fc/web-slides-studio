import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
import { importArchive } from "../src/archive.js";
async function fixture(fn) {
  const app = await startStudio({
    port: 0,
    contentPort: 0,
    root: await mkdtemp(join(tmpdir(), "studio-recovery-")),
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  try {
    const z = new JSZip();
    z.file(
      "index.html",
      '<html><head><title>테스트</title><style>main{width:1920px;height:1080px}.slide{display:none}.slide.active{display:block}h1{font-size:90px}</style></head><body><main id="stage"><section class="slide" data-scene="hero"><h1>제목</h1></section><section class="slide" data-scene="dim"><h1>둘째</h1></section></main></body></html>',
    );
    const d = await app.store.create(
      await importArchive(await z.generateAsync({ type: "nodebuffer" })),
    );
    await fn(app, browser, d);
  } finally {
    await browser.close();
    await app.close();
  }
}
async function open(app, browser, d) {
  const p = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  await p.goto(app.origin + "/#deck=" + d.id);
  await p.waitForSelector("#slideList .slide-item");
  await p.waitForTimeout(400);
  return p;
}
test("scene overrides survive duplication and original option removes override", () =>
  fixture(async (app, browser, d) => {
    const p = await open(app, browser, d);
    await p.locator("#sceneValue").selectOption("dim");
    await p.waitForTimeout(700);
    await p.locator("#duplicateSlideBtn").click();
    await p.waitForTimeout(700);
    let s = (await app.store.get(d.id)).state;
    assert.equal(s.scenes[s.order[1]], "dim");
    await p.locator("#slideList .slide-item").first().click();
    await p.locator("#sceneValue").selectOption("");
    await p.waitForTimeout(700);
    s = (await app.store.get(d.id)).state;
    assert.equal(Object.hasOwn(s.scenes, "s0"), false);
  }));
test("conflicting edits can be saved deliberately as a new version", () =>
  fixture(async (app, browser, d) => {
    const a = await open(app, browser, d),
      b = await open(app, browser, d);
    for (const [p, text] of [
      [a, "첫 번째 창"],
      [b, "보존할 두 번째 창"],
    ]) {
      const f = p.frames().find((f) => f.url().startsWith(app.contentOrigin));
      await f.locator(".slide.active h1").click();
      await p.locator("#textValue").fill(text);
      await p.locator("#textValue").dispatchEvent("change");
      await p.waitForTimeout(1000);
    }
    await b.waitForSelector("#conflictKeepBtn", { timeout: 2000 });
    await b.locator("#conflictKeepBtn").click();
    await b.waitForTimeout(1000);
    const saved = await app.store.get(d.id);
    assert.equal(saved.state.patches.e0.text, "보존할 두 번째 창");
    assert.equal(saved.revision, 3);
    assert.equal(
      (await app.store.get(d.id, 2)).state.patches.e0.text,
      "첫 번째 창",
    );
  }));
