import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";

test("public help explains import limits and import stays available in a populated library", async () => {
  const app = await startStudio({ root: await mkdtemp(join(tmpdir(), "studio-help-")), port: 0, contentPort: 0, password: "test-help-password" });
  let browser;
  try {
    const response = await fetch(`${app.origin}/help.html`);
    assert.equal(response.status, 200);
    assert.equal((await fetch(`${app.origin}/api/decks`)).status, 401);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(app.origin);
    assert.equal(await page.locator('#login a[href="/help.html"]').isVisible(), true);
    const help = await browser.newPage();
    await help.goto(`${app.origin}/help.html`);
    assert.match(await help.locator("#formats").innerText(), /PPTX/);
    assert.match(await help.locator("#formats").innerText(), /2,000/);
    for (const width of [320, 390, 1440]) {
      await help.setViewportSize({ width, height: 900 });
      assert.equal(await help.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    for (const href of await help.locator('a[href^="#"]').evaluateAll(links => links.map(a => a.getAttribute("href")))) {
      assert.equal(await help.locator(href).count(), 1);
    }
    await page.locator("#password").fill("test-help-password");
    await page.locator("#loginForm button").click();
    await page.waitForSelector("#library:not([hidden])");
    await page.locator("#newBtn").click();
    await page.waitForSelector("#editor:not([hidden])");
    assert.equal(await page.locator('.topbar a[href="/help.html"]').isVisible(), true);
    await page.locator("#libraryBtn").click();
    await page.waitForSelector(".deck-card");
    assert.equal(await page.locator("#pptxImportBtn").isVisible(), true);
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#pptxImportBtn").click();
    assert.equal(await (await chooser).element().getAttribute("accept"), ".pptx");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  } finally {
    await browser?.close();
    await app.close();
  }
});
