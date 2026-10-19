import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { startStudio } from "../src/server.js";
test("API rejects cross-origin writes; published revision is frozen and revocable", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-api-"));
  const app = await startStudio({ port: 0, contentPort: 0, root });
  try {
    const origin = app.origin;
    const bad = await fetch(origin + "/api/decks", {
      method: "POST",
      headers: { Origin: "https://evil.invalid" },
      body: "bad",
    });
    assert.equal(bad.status, 403);
    const z = new JSZip();
    z.file(
      "index.html",
      '<html><head><title>자료</title></head><body><section class="slide"><h1>원본</h1></section></body></html>',
    );
    const response = await fetch(origin + "/api/decks", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/zip" },
      body: await z.generateAsync({ type: "nodebuffer" }),
    });
    assert.equal(response.status, 201);
    const d = await response.json();
    const wrong = await fetch(
      app.contentOrigin + `/v/${d.id}/wrong/index.html`,
    );
    assert.equal(wrong.status, 404);
    const preview = await fetch(d.previewUrl);
    assert.equal(preview.status, 200);
    assert.match(
      preview.headers.get("content-security-policy"),
      /connect-src 'none'/,
    );
    const published = await (
      await fetch(origin + `/api/decks/${d.id}/publish`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: '{"enabled":true}',
      })
    ).json();
    assert.ok(published.shareUrl);
    const unpub = await fetch(origin + `/api/decks/${d.id}/publish`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: '{"enabled":false}',
    });
    assert.equal(unpub.status, 200);
    assert.equal((await fetch(published.shareUrl)).status, 404);
  } finally {
    await app.close();
  }
});
test("password protects private APIs", async () => {
  const app = await startStudio({
    port: 0,
    contentPort: 0,
    root: await mkdtemp(join(tmpdir(), "studio-auth-")),
    password: "a-test-password",
  });
  try {
    assert.equal((await fetch(app.origin + "/api/decks")).status, 401);
    const r = await fetch(app.origin + "/api/login", {
      method: "POST",
      headers: { Origin: app.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "a-test-password" }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  } finally {
    await app.close();
  }
});
test("simultaneous exports reserve one render slot", async () => {
  let release;
  const done = new Promise((r) => (release = r));
  const app = await startStudio({
    port: 0,
    contentPort: 0,
    root: await mkdtemp(join(tmpdir(), "studio-export-lock-")),
    exporter: async () => {
      await done;
      return {
        buffer: Buffer.from("test"),
        mime: "text/plain",
        extension: "txt",
      };
    },
  });
  try {
    const z = new JSZip();
    z.file(
      "index.html",
      '<html><head><title>자료</title></head><body><section class="slide"><h1>원본</h1></section></body></html>',
    );
    const d = await (
      await fetch(app.origin + "/api/decks", {
        method: "POST",
        headers: { Origin: app.origin },
        body: await z.generateAsync({ type: "nodebuffer" }),
      })
    ).json();
    const request = () =>
      fetch(app.origin + `/api/decks/${d.id}/export`, {
        method: "POST",
        headers: { Origin: app.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ format: "pdf", revision: 1 }),
      });
    const res = await Promise.all([request(), request()]);
    assert.deepEqual(res.map((r) => r.status).sort(), [202, 429]);
  } finally {
    release();
    await app.close();
  }
});
test('export rendering uses loopback even with a public content origin', async()=>{let renderArgs;const app=await startStudio({port:0,contentPort:0,root:await mkdtemp(join(tmpdir(),'studio-render-origin-')),contentOrigin:'https://slides-content.example.test',exporter:async args=>{renderArgs=args;return {buffer:Buffer.from('ok'),mime:'text/plain',extension:'txt'};}});try{const z=new JSZip();z.file('index.html','<html><head><title>test</title></head><body><section class="slide">hello</section></body></html>');const d=await (await fetch(app.origin+'/api/decks',{method:'POST',headers:{Origin:app.origin},body:await z.generateAsync({type:'nodebuffer'})})).json();await fetch(app.origin+`/api/decks/${d.id}/export`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({format:'pdf',revision:1})});await new Promise(r=>setTimeout(r,100));assert.equal(new URL(renderArgs.url).hostname,'127.0.0.1');assert.equal((await fetch(renderArgs.url)).status,200);}finally{await app.close();}});
