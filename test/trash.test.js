import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startStudio } from "../src/server.js";
async function fixture(fn, opts = {}) {
  const app = await startStudio({
    port: 0,
    contentPort: 0,
    root: await mkdtemp(join(tmpdir(), "studio-trash-")),
    ...opts,
  });
  const request = (path, method = "GET", data) =>
    fetch(app.origin + "/api" + path, {
      method,
      headers: { Origin: app.origin, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  try {
    await fn(app, request);
  } finally {
    await app.close();
  }
}
test("permanent deletion requires trash and removes assets, revisions, links and cached exports", () =>
  fixture(async (app, req) => {
    const d = await (await req("/new", "POST", {})).json();
    assert.equal((await req("/decks/" + d.id, "DELETE")).status, 409);
    await req("/decks/" + d.id + "/save", "POST", {
      revision: 1,
      state: d.state,
    });
    const published = await (
      await req("/decks/" + d.id + "/publish", "POST", { enabled: true })
    ).json();
    const job = await (
      await req("/decks/" + d.id + "/export", "POST", {
        revision: 2,
        format: "html",
      })
    ).json();
    for (let n = 0; n < 100; n++) {
      if ((await (await req("/jobs/" + job.id)).json()).status === "done")
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await req("/jobs/" + job.id + "/download")).status, 200);
    await req("/decks/" + d.id, "PATCH", { deleted: true });
    assert.equal(
      (
        await fetch(app.origin + "/api/decks/" + d.id, {
          method: "DELETE",
          headers: { Origin: "https://invalid.test" },
        })
      ).status,
      403,
    );
    assert.equal((await req("/decks/" + d.id, "DELETE")).status, 200);
    await assert.rejects(access(app.store.path(d.id)), { code: "ENOENT" });
    assert.deepEqual(await (await req("/decks")).json(), []);
    for (const path of [
      "/decks/" + d.id,
      "/decks/" + d.id + "/revisions",
      "/jobs/" + job.id,
      "/jobs/" + job.id + "/download",
    ])
      assert.equal((await req(path)).status, 404);
    assert.equal((await fetch(d.previewUrl)).status, 404);
    assert.equal((await fetch(published.shareUrl)).status, 404);
    assert.equal(
      (await req("/decks/" + d.id, "PATCH", { deleted: false })).status,
      404,
    );
    assert.equal(
      (await req("/decks/" + d.id + "/assets?name=test.png", "POST", {}))
        .status,
      404,
    );
    await assert.rejects(access(app.store.path(d.id)), { code: "ENOENT" });
  }));
test("permanent deletion is blocked while exporting and without login", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  try {
    await fixture(
      async (app, req) => {
        const d = await (await req("/new", "POST", {})).json();
        await req("/decks/" + d.id + "/export", "POST", {
          revision: 1,
          format: "html",
        });
        await req("/decks/" + d.id, "PATCH", { deleted: true });
        assert.equal((await req("/decks/" + d.id, "DELETE")).status, 409);
        await access(app.store.path(d.id));
        assert.equal(
          (
            await req("/decks/" + d.id + "/export", "POST", {
              revision: 1,
              format: "html",
            })
          ).status,
          429,
        );
        release();
      },
      {
        exporter: async () => {
          await gate;
          return {
            buffer: Buffer.from("ok"),
            mime: "text/plain",
            extension: "txt",
          };
        },
      },
    );
  } finally {
    release();
  }
  await fixture(
    async (app, req) =>
      assert.equal(
        (await req("/decks/00000000-0000-0000-0000-000000000000", "DELETE"))
          .status,
        401,
      ),
    { password: "test-only-password" },
  );
});
test("sidebar selection colors follow all/folder/trash and permanent delete can be cancelled", () =>
  fixture(async (app, req) => {
    const d = await (await req("/new", "POST", {})).json();
    await req("/decks/" + d.id, "PATCH", {
      title: "삭제 확인 시험 자료",
      folder: "회의",
    });
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    try {
      const p = await browser.newPage({
        viewport: { width: 1400, height: 900 },
      });
      await p.goto(app.origin);
      await p.waitForSelector(".deck-card");
      const color = await p
        .locator("#allBtn")
        .evaluate((e) => getComputedStyle(e).backgroundColor);
      await p.locator("#trashBtn").click();
      await p.waitForFunction(
        (c) =>
          getComputedStyle(document.getElementById("trashBtn"))
            .backgroundColor === c,
        color,
      );
      assert.equal(
        await p
          .locator("#trashBtn")
          .evaluate((e) => getComputedStyle(e).backgroundColor),
        color,
      );
      assert.equal(await p.locator(".nav-item.selected").count(), 1);
      assert.equal(
        await p.locator("#trashBtn").getAttribute("aria-current"),
        "page",
      );
      await p.locator("#folders button").click();
      await p.waitForFunction(
        (c) =>
          getComputedStyle(document.querySelector("#folders button"))
            .backgroundColor === c,
        color,
      );
      assert.equal(
        await p
          .locator("#folders button")
          .evaluate((e) => getComputedStyle(e).backgroundColor),
        color,
      );
      assert.equal(await p.locator(".nav-item.selected").count(), 1);
      await p.locator("#allBtn").click();
      assert.equal(
        await p.locator("#allBtn").getAttribute("aria-current"),
        "page",
      );
      assert.equal(
        await p.getByRole("button", { name: "완전 삭제", exact: true }).count(),
        0,
      );
      await p
        .locator(".deck-actions")
        .getByRole("button", { name: "휴지통", exact: true })
        .click();
      await p.waitForSelector(".deck-card", { state: "detached" });
      await p.locator("#trashBtn").click();
      await p.waitForSelector(".deck-card");
      const button = p.getByRole("button", { name: "완전 삭제", exact: true });
      assert.equal(await button.count(), 1);
      p.once("dialog", (dialog) => {
        assert.match(dialog.message(), /삭제 확인 시험 자료/);
        assert.match(dialog.message(), /복구할 수 없습니다/);
        dialog.dismiss();
      });
      await button.click();
      assert.equal((await app.store.meta(d.id)).deleted, true);
      p.once("dialog", (dialog) => dialog.accept());
      await button.click();
      await p.waitForSelector(".deck-card", { state: "detached" });
      await assert.rejects(access(app.store.path(d.id)), { code: "ENOENT" });
      assert.equal(
        await p.locator("#trashBtn").getAttribute("aria-current"),
        "page",
      );
    } finally {
      await browser.close();
    }
  }));
