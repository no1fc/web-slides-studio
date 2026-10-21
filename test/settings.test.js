import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { startStudio } from "../src/server.js";
const initial = "initial-password-123";
const changed = "changed-password-456";
const makeRoot = () => mkdtemp(join(tmpdir(), "studio-settings-"));
function request(app, cookie = "") {
  return (path, method = "GET", data) =>
    fetch(app.origin + "/api" + path, {
      method,
      headers: {
        Origin: app.origin,
        Cookie: cookie,
        ...(data instanceof Buffer
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(data === undefined
        ? {}
        : { body: Buffer.isBuffer(data) ? data : JSON.stringify(data) }),
    });
}
async function login(app, password) {
  const r = await request(app)("/login", "POST", { password });
  return {
    status: r.status,
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
test("password changes require current password, rotate sessions, persist hashes and survive restart", async () => {
  const root = await makeRoot();
  let app = await startStudio({
    root,
    port: 0,
    contentPort: 0,
    password: initial,
  });
  try {
    const a = await login(app, initial),
      b = await login(app, initial);
    const req = request(app, a.cookie);
    assert.equal(
      (
        await request(app)("/password", "POST", {
          currentPassword: initial,
          newPassword: changed,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await req("/password", "POST", {
          currentPassword: "wrong",
          newPassword: changed,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await req("/password", "POST", {
          currentPassword: initial,
          newPassword: "short",
        })
      ).status,
      400,
    );
    const r = await req("/password", "POST", {
      currentPassword: initial,
      newPassword: changed,
    });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie").split(";")[0];
    assert.notEqual(cookie, a.cookie);
    assert.equal((await request(app, a.cookie)("/session")).status, 401);
    assert.equal((await request(app, b.cookie)("/session")).status, 401);
    assert.equal((await request(app, cookie)("/session")).status, 200);
    assert.equal((await login(app, initial)).status, 401);
    assert.equal((await login(app, changed)).status, 200);
    const saved = await readFile(join(root, "_auth.json"), "utf8");
    assert.ok(!saved.includes(initial) && !saved.includes(changed));
    // Windows uses ACLs rather than the POSIX permission bits returned by stat.
    if (process.platform !== "win32")
      assert.equal((await stat(join(root, "_auth.json"))).mode & 0o777, 0o600);
    await app.close();
    app = await startStudio({
      root,
      port: 0,
      contentPort: 0,
      password: initial,
    });
    assert.equal((await login(app, initial)).status, 401);
    assert.equal((await login(app, changed)).status, 200);
  } finally {
    await app.close();
  }
});
test("files inventory, source ZIP, protected originals and referenced history, unused upload cleanup", async () => {
  const app = await startStudio({
    root: await makeRoot(),
    port: 0,
    contentPort: 0,
  });
  const req = request(app);
  try {
    const z = new JSZip();
    z.file(
      "index.html",
      '<html><head><title>files</title></head><body><section class="slide"><h1>files</h1></section></body></html>',
    );
    z.file("image.png", Buffer.from("original"));
    const d = await (
      await req("/decks", "POST", await z.generateAsync({ type: "nodebuffer" }))
    ).json();
    const base = "/decks/" + d.id;
    const added = await (
      await req(base + "/assets?name=extra.png", "POST", Buffer.from("extra"))
    ).json();
    let files = await (await req(base + "/files")).json();
    assert.equal(files.files.length, 3);
    assert.ok(files.totalBytes > 0);
    assert.ok(files.revisionBytes > 0);
    assert.equal(files.archiveRetained, false);
    assert.equal(
      files.files.find((f) => f.path === "image.png").canDelete,
      false,
    );
    assert.equal(files.files.find((f) => f.path === added.src).canDelete, true);
    assert.equal(
      await (
        await req(base + "/files?path=" + encodeURIComponent(added.src))
      ).text(),
      "extra",
    );
    const zip = await JSZip.loadAsync(
      await (await req(base + "/source")).arrayBuffer(),
    );
    assert.ok(zip.file("index.html"));
    assert.ok(zip.file(added.src));
    assert.ok(!zip.file("meta.json"));
    assert.ok(!zip.file("_auth.json"));
    assert.equal(
      (await req(base + "/files", "DELETE", { path: "../meta.json" })).status,
      400,
    );
    assert.equal(
      (await req(base + "/files", "DELETE", { path: "index.html" })).status,
      409,
    );
    const s = structuredClone(d.state);
    s.patches.e0 = { src: added.src };
    await req(base + "/save", "POST", { revision: 1, state: s });
    assert.equal(
      (await req(base + "/files", "DELETE", { path: added.src })).status,
      409,
    );
    await req(base + "/save", "POST", { revision: 2, state: d.state });
    assert.equal(
      (await req(base + "/files", "DELETE", { path: added.src })).status,
      409,
    );
    const unused = await (
      await req(base + "/assets?name=unused.png", "POST", Buffer.from("unused"))
    ).json();
    assert.equal(
      (await req(base + "/files", "DELETE", { path: unused.src })).status,
      200,
    );
    assert.equal(
      (await req(base + "/files?path=" + encodeURIComponent(unused.src)))
        .status,
      404,
    );
    files = await (await req(base + "/files")).json();
    assert.equal(
      files.files.some((f) => f.path === unused.src),
      false,
    );
    const stale = structuredClone(d.state);
    stale.patches.e0 = { src: unused.src };
    assert.equal(
      (await req(base + "/save", "POST", { revision: 3, state: stale })).status,
      400,
    );
  } finally {
    await app.close();
  }
});
