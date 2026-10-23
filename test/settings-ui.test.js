import { openRibbonTab } from './editor-ui-helpers.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
test("file manager downloads files and password form validates, changes and logs back in", async () => {
  const app = await startStudio({
    root: await mkdtemp(join(tmpdir(), "studio-ui-")),
    port: 0,
    contentPort: 0,
    password: "initial-password-123",
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  try {
    const p = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    await p.goto(app.origin);
    await p.locator("#password").fill("initial-password-123");
    await p.locator("#loginForm button").click();
    await p.waitForSelector("#library:not([hidden])");
    assert.equal(await p.locator("#passwordBtn").count(), 1);
    await p.locator("#newBtn").click();
    await p.waitForSelector("#editor:not([hidden])");
    await openRibbonTab(p, 'file');
  await p.locator("#filesBtn").click();
    await p.waitForSelector(".file-row");
    assert.match(await p.locator("#dialogBody").innerText(), /ZIP 자체는/);
    assert.match(
      await p.locator(".file-row").first().innerText(),
      /index.html/,
    );
    const downloaded = p.waitForEvent("download");
    await p.locator(".file-row a").first().click();
    assert.equal((await downloaded).suggestedFilename(), "index.html");
    await p.locator("#closeDialog").click();
    await p.locator("#editorSettingsBtn").click();
    await p.locator("#settingsPasswordBtn").click();
    await p.locator("#currentPassword").fill("wrong");
    await p.locator("#newPassword").fill("new-password-789");
    await p.locator("#confirmPassword").fill("new-password-789");
    await p.locator("#passwordForm button[type=submit]").click();
    await p.waitForFunction(() =>
      document
        .getElementById("passwordError")
        .textContent.includes("현재 비밀번호"),
    );
    assert.equal(await p.locator("#shell").isVisible(), true);
    await p.locator("#currentPassword").fill("initial-password-123");
    await p.locator("#confirmPassword").fill("does-not-match");
    await p.locator("#passwordForm button[type=submit]").click();
    assert.match(await p.locator("#passwordError").innerText(), /일치/);
    await p.locator("#confirmPassword").fill("new-password-789");
    await p.locator("#passwordForm button[type=submit]").click();
    await p.waitForSelector("#dialog", { state: "hidden" });
    await p.locator("#libraryBtn").click();
    await p.locator("#logoutBtn").click();
    await p.waitForSelector("#login:not([hidden])");
    await p.locator("#password").fill("new-password-789");
    await p.locator("#loginForm button").click();
    await p.waitForSelector("#shell:not([hidden])");
  } finally {
    await browser.close();
    await app.close();
  }
});
