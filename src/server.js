import http from "node:http";
import { readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { Workflows } from "./workflows.js";
import { withoutNotesHtml, withoutNotesDeck, redactNoteText } from "./notes-policy.js";
import { Store } from "./store.js";
import { PasswordStore } from "./auth.js";
import { inventory, sourceArchive, collectFiles } from "./files.js";
import { importArchive, safePath } from "./archive.js";
import { renderDeck, prepareDeck, validateState } from "./deck.js";
import { authoringSource } from "./authoring.js";
import { renderThumbnail } from "./thumbnail.js";
const base = fileURLToPath(new URL("..", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
};
function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}
async function body(req, limit = 2_500_000) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) {
      const e = new Error("파일 또는 요청 크기가 제한을 초과했습니다.");
      e.status = 413;
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function json(req) {
  try {
    return JSON.parse((await body(req)).toString());
  } catch (e) {
    if (e.status) throw e;
    throw new Error("JSON 데이터 오류");
  }
}
const enc = (v) => JSON.stringify(v).replaceAll("<", "\\u003c");
export async function startStudio(opts = {}) {
  const host = opts.host || "127.0.0.1";
  const password = opts.password || "";
  if (
    !["127.0.0.1", "localhost", "::1"].includes(host) &&
    (!opts.origin?.startsWith("https://") ||
      !opts.contentOrigin?.startsWith("https://"))
  )
    throw new Error(
      "외부 운영은 관리자 암호 및 별도의 HTTPS 관리/콘텐츠 주소가 필요합니다.",
    );
  const store = new Store(resolve(opts.root || join(base, "data")));
  await store.init();
  const workflows = new Workflows(store);
  const shareSessions = new Map();
  const auth = new PasswordStore(store);
  await auth.init(password);
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !auth.enabled)
    throw new Error("외부 운영에는 관리자 암호가 필요합니다.");
  const sessions = new Map(),
    attempts = new Map(),
    jobs = new Map();
  let busy = false;
  let origin, contentOrigin, renderOrigin;
  const audienceToken = d => createHash("sha256").update("audience:" + d.previewToken).digest("hex");
  const expose = (d) => ({
    ...Object.fromEntries(Object.entries(d).filter(([key]) => !["sharePassword", "shareAccessVersion"].includes(key))),
    sharePasswordProtected: !!d.sharePassword,
    shareLegacyNotes: !!d.shareToken && d.shareIncludeNotes === undefined,
    previewUrl: `${contentOrigin}/v/${d.id}/${d.previewToken}/index.html?rev=${d.revision}`,
    audienceUrl: `${contentOrigin}/a/${d.id}/${audienceToken(d)}/index.html?rev=${d.revision}`,
    shareUrl: d.shareToken
      ? `${contentOrigin}/v/${d.id}/${d.shareToken}/index.html`
      : null,
  });
  const exposeProposal = (id, p, deck) => ({...p, beforeUrl: `${contentOrigin}/v/${id}/${deck.previewToken}/index.html?rev=${p.baseRevision}`, afterUrl: `${contentOrigin}/v/${id}/${deck.previewToken}/index.html?proposal=${p.id}`});
  const createImport = async (input, bytes, key) => {
    if (key && (!/^[a-f0-9]{64}$/.test(key) || createHash('sha256').update(bytes).digest('hex') !== key)) throw new Error('업로드 파일 확인 값이 다릅니다. 다시 선택해 주세요.');
    return store.locked('_imports',async()=>{
      if (key) { const existing=(await store.list()).find(d=>!d.deleted && d.importKey===key); if(existing) return store.get(existing.id); }
      const d=await store.create(input);
      if(key) {const meta=await store.meta(d.id);await store.atomic(store.path(d.id,'meta.json'),{...meta,importKey:key});}
      return store.get(d.id);
    });
  };
  const issueSession = (res) => {
    const sid = randomBytes(32).toString("hex");
    sessions.set(sid, Date.now() + 12 * 3600000);
    res.setHeader(
      "Set-Cookie",
      `studio_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${origin.startsWith("https:") ? "; Secure" : ""}`,
    );
  };
  const wrapped = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!res.headersSent)
        send(res, e.status || (e.code === "ENOENT" ? 404 : 400), {
          error: e.code === "ENOENT" ? "자료를 찾을 수 없습니다." : e.message,
        });
      else res.end();
    }
  };
  const manager = http.createServer(
    wrapped(async (req, res) => {
      const url = new URL(req.url, origin);
      if (req.headers.host !== new URL(origin).host) {
        send(res, 421, { error: "요청 호스트가 다릅니다." });
        return;
      }
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers.origin !== origin
      ) {
        send(res, 403, { error: "관리 화면에서 다시 시도해 주세요." });
        return;
      }
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${contentOrigin}; frame-src ${contentOrigin}; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
      );
      if (url.pathname === "/api/login" && req.method === "POST") {
        const key = req.socket.remoteAddress;
        const now = Date.now();
        const a = attempts.get(key) || { count: 0, at: now };
        if (now - a.at > 60000) {
          a.count = 0;
          a.at = now;
        }
        if (++a.count > 10) {
          send(res, 429, { error: "잠시 후 다시 로그인해 주세요." });
          return;
        }
        attempts.set(key, a);
        const b = await json(req);
        await auth.locked(async () => {
          if (auth.enabled && !(await auth.verify(b.password))) {
            send(res, 401, { error: "암호를 확인해 주세요." });
            return;
          }
          issueSession(res);
          send(res, 200, { ok: true });
        });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const sid = /studio_session=([a-f0-9]+)/.exec(
          req.headers.cookie || "",
        )?.[1];
        if (auth.enabled && (!sid || (sessions.get(sid) || 0) < Date.now())) {
          send(res, 401, { error: "로그인이 필요합니다." });
          return;
        }
        if (url.pathname === "/api/session") {
          send(res, 200, { local: !auth.enabled });
          return;
        }
        if (url.pathname === "/api/password" && req.method === "POST") {
          const b = await json(req);
          await auth.locked(async () => {
            if (!auth.enabled) {
              send(res, 400, {
                error: "초기 관리자 암호를 서버에 설정해 주세요.",
              });
              return;
            }
            if (!sessions.has(sid)) {
              send(res, 401, { error: "다시 로그인해 주세요." });
              return;
            }
            const key = "password:" + sid,
              now = Date.now();
            const a = attempts.get(key) || { count: 0, at: now };
            if (now - a.at > 60000) {
              a.count = 0;
              a.at = now;
            }
            attempts.set(key, a);
            if (++a.count > 5) {
              send(res, 429, { error: "잠시 후 다시 시도해 주세요." });
              return;
            }
            if (!(await auth.verify(b.currentPassword))) {
              send(res, 401, { error: "현재 비밀번호가 올바르지 않습니다." });
              return;
            }
            if (
              typeof b.newPassword !== "string" ||
              b.newPassword.length < 12 ||
              b.newPassword.length > 128 ||
              b.newPassword === b.currentPassword
            ) {
              send(res, 400, {
                error: "새 비밀번호는 현재와 다른 12~128자로 입력해 주세요.",
              });
              return;
            }
            await auth.save(b.newPassword);
            sessions.clear();
            attempts.delete(key);
            issueSession(res);
            send(res, 200, { ok: true });
          });
          return;
        }
        if (url.pathname === "/api/logout" && req.method === "POST") {
          sessions.delete(sid);
          res.setHeader(
            "Set-Cookie",
            "studio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          send(res, 200, { ok: true });
          return;
        }
        if (url.pathname === "/api/ai-connection" || url.pathname === "/api/ai/connection-report") {
          const file = join(store.root, '_ai-connection.json');
          if (req.method === 'POST') {
            const b=await json(req), checks={};
            for (const key of ['server','authentication','tools','workspace']) checks[key]=['ok','error','unknown'].includes(b.checks?.[key])?b.checks[key]:'unknown';
            if(typeof b.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(b.version)) throw new Error('MCP 버전 보고 형식 오류');
            await store.atomic(file,{version:b.version,client:['codex','claude','unknown'].includes(b.client)?b.client:'unknown',platform:['win32','darwin','linux','unknown'].includes(b.platform)?b.platform:'unknown',checks,reportedAt:new Date().toISOString()});
          } else if(req.method !== 'GET') { send(res,405,{error:'지원하지 않는 요청'}); return; }
          let report=null;try{report=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
          send(res,200,{report,minimumVersion:'0.3.0'});return;
        }
        if(url.pathname==='/api/import/check' && req.method==='POST') {
          const input=await importArchive(await body(req,40*1024*1024));send(res,200,{slides:input.slides.length,files:input.files.size,title:input.title});return;
        }
        if(url.pathname==='/api/templates') {
          if(req.method==='GET')send(res,200,await workflows.templates());
          else if(req.method==='POST')send(res,201,await workflows.saveTemplate(await json(req)));
          else send(res,405,{error:'지원하지 않는 요청'});return;
        }
        const template=/^\/api\/templates\/([a-z0-9-]+)\/create$/.exec(url.pathname);
        if(template && req.method==='POST'){send(res,201,expose(await workflows.createTemplate(template[1],await json(req))));return;}
        if(url.pathname==='/api/brands') {
          if(req.method==='GET')send(res,200,await workflows.brands());
          else if(req.method==='POST')send(res,201,await workflows.saveBrand(await json(req)));
          else send(res,405,{error:'지원하지 않는 요청'});return;
        }
        const brand=/^\/api\/brands\/([a-f0-9-]{36})\/apply$/.exec(url.pathname);
        if(brand&&req.method==='POST'){send(res,200,expose(await workflows.applyBrand(brand[1],await json(req))));return;}
        const proposal=/^\/api\/decks\/([a-f0-9-]{36})\/proposals(?:\/([a-f0-9-]{36})(?:\/(apply|reject))?)?$/.exec(url.pathname);
        if(proposal){
          const [,id,pid,action]=proposal,deck=await store.meta(id);
          if(!pid&&req.method==='GET')send(res,200,(await workflows.proposals(id)).map(p=>exposeProposal(id,p,deck)));
          else if(!pid&&req.method==='POST')send(res,201,exposeProposal(id,await workflows.propose(id,await json(req)),deck));
          else if(!action&&req.method==='GET')send(res,200,exposeProposal(id,await workflows.proposal(id,pid),deck));
          else if(action==='apply'&&req.method==='POST')send(res,200,expose(await workflows.apply(id,pid,await json(req))));
          else if(action==='reject'&&req.method==='POST')send(res,200,exposeProposal(id,await workflows.reject(id,pid),deck));
          else send(res,405,{error:'지원하지 않는 요청'});return;
        }
        const revisionName=/^\/api\/decks\/([a-f0-9-]{36})\/revision-name$/.exec(url.pathname);
        if(revisionName&&req.method==='POST'){const b=await json(req);send(res,200,await store.nameRevision(revisionName[1],b.revision,b.name));return;}
        if (url.pathname === "/api/decks" && req.method === "GET") {
          send(res, 200, (await store.list()).map(expose));
          return;
        }
        if (url.pathname === "/api/decks" && req.method === "POST") {
          const bytes=await body(req,40*1024*1024);
          const input = await importArchive(bytes);
          send(res, 201, expose(await createImport(input,bytes,req.headers["x-import-key"])));
          return;
        }
        if (url.pathname === "/api/import-pptx" && req.method === "POST") {
          const { importPptx } = await import("./pptx-import.js");
          const bytes=await body(req,40*1024*1024);
          const input = await importPptx(bytes);
          // Preview and confirmation both parse the supplied file. No temporary
          // public asset store or unbounded server-side upload session is needed.
          input.state = validateState(input.state, input);
          if (url.searchParams.get("confirm") !== "1") send(res, 200, input.report);
          else send(res, 201, expose(await createImport(input,bytes,req.headers["x-import-key"])));
          return;
        }
        if (url.pathname === "/api/new" && req.method === "POST") {
          const html =
            '<!doctype html><html lang="ko"><head><title>새 발표 자료</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#101c27;color:#fff;font-family:Arial,sans-serif}main{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;padding:100px;box-sizing:border-box;display:none}.slide.active{display:block}h1{font-size:96px}p{font-size:36px}</style></head><body><main id="stage"><section class="slide active"><h1>새로운 이야기를 시작하세요</h1><p>글과 이미지를 선택해 나만의 발표 자료로 만드세요.</p></section></main></body></html>';
          const d = prepareDeck(html);
          send(
            res,
            201,
            expose(
              await store.create({
                ...d,
                files: new Map([["index.html", Buffer.from(d.html)]]),
              }),
            ),
          );
          return;
        }
        const m = /^\/api\/decks\/([a-f0-9-]{36})(?:\/(\w+))?$/.exec(
          url.pathname,
        );
        if (m) {
          const [, id, action] = m;
          if (!action && req.method === "GET") {
            send(res, 200, expose(await store.get(id)));
            return;
          }
          if (!action && req.method === "PATCH") {
            send(res, 200, expose(await store.update(id, await json(req))));
            return;
          }
          if (!action && req.method === "DELETE") {
            await store.locked(id, async () => {
              const d = await store.meta(id);
              if (!d.deleted) {
                const e = new Error(
                  "휴지통으로 이동한 자료만 완전히 삭제할 수 있습니다.",
                );
                e.status = 409;
                throw e;
              }
              if (
                [...jobs.values()].some(
                  (j) => j.deckId === id && j.status === "working",
                )
              ) {
                const e = new Error(
                  "다운로드 파일을 만드는 중입니다. 완료 후 삭제해 주세요.",
                );
                e.status = 409;
                throw e;
              }
              await rm(store.path(id), { recursive: true });
              for (const [key, job] of jobs)
                if (job.deckId === id) jobs.delete(key);
            });
            send(res, 200, { ok: true });
            return;
          }
          if (action === "save" && req.method === "POST") {
            const b = await json(req);
            send(res, 200, expose(await store.save(id, b.revision, b.state, {source: ["manual", "ai"].includes(b.source) ? b.source : undefined, summary: typeof b.summary === "string" ? b.summary : "자료 저장"})));
            return;
          }
          if (action === "authoring" && req.method === "GET") {
            const d = await store.get(id);
            const html = await readFile(store.path(id, "assets/index.html"), "utf8");
            send(res, 200, authoringSource(html, d.state, url.searchParams.get("slide")));
            return;
          }
          if (action === "validate" && req.method === "POST") {
            const b = await json(req);
            send(res, 200, { state: validateState(b.state, await store.meta(id)) });
            return;
          }
          if (action === "revisions" && req.method === "GET") {
            send(res, 200, await store.revisions(id));
            return;
          }
          if (action === "restore" && req.method === "POST") {
            const b = await json(req);
            const d = await store.get(id, b.target);
            send(res, 200, expose(await store.save(id, b.revision, d.state, {source: "restore", summary: `버전 ${b.target} 복원`})));
            return;
          }
          if (action === "publish" && req.method === "POST") {
            const b = await json(req);
            send(res,200,expose(await store.publish(id,b.enabled === true,b)));
            return;
          }
          if (action === "duplicate" && req.method === "POST") {
            send(res, 201, expose(await store.duplicate(id)));
            return;
          }
          if (action === "files" && req.method === "GET") {
            await store.locked(id, async () => {
              await store.meta(id);
              const path = url.searchParams.get("path");
              if (path !== null) {
                safePath(path);
                const files = await collectFiles(store.path(id, "assets"));
                if (!files.includes(path)) {
                  send(res, 404, { error: "파일을 찾을 수 없습니다." });
                  return;
                }
                res.setHeader(
                  "Content-Disposition",
                  "attachment; filename*=UTF-8''" +
                    encodeURIComponent(path.split("/").at(-1)),
                );
                send(
                  res,
                  200,
                  await readFile(store.path(id, "assets", path)),
                  "application/octet-stream",
                );
              } else send(res, 200, await inventory(store, id));
            });
            return;
          }
          if (action === "source" && req.method === "GET") {
            await store.locked(id, async () => {
              await store.meta(id);
              res.setHeader(
                "Content-Disposition",
                'attachment; filename="source-files.zip"',
              );
              send(res, 200, await sourceArchive(store, id), "application/zip");
            });
            return;
          }
          if (action === "files" && req.method === "DELETE") {
            const path = safePath((await json(req)).path);
            await store.locked(id, async () => {
              const info = await inventory(store, id);
              const file = info.files.find((f) => f.path === path);
              if (!file) {
                send(res, 404, { error: "파일을 찾을 수 없습니다." });
                return;
              }
              if (!file.canDelete) {
                send(res, 409, {
                  error:
                    "원본 또는 저장 버전에서 사용하는 파일은 삭제할 수 없습니다. 자료 전체는 휴지통에서 완전 삭제할 수 있습니다.",
                });
                return;
              }
              if (
                [...jobs.values()].some(
                  (j) => j.deckId === id && j.status === "working",
                )
              ) {
                send(res, 409, {
                  error: "다운로드 파일 생성이 끝난 후 삭제해 주세요.",
                });
                return;
              }
              await rm(store.path(id, "assets", path));
              const meta = await store.meta(id);
              meta.uploadedFiles = (meta.uploadedFiles || []).filter(
                (p) => p !== path,
              );
              await store.atomic(store.path(id, "meta.json"), meta);
              for (const [key, job] of jobs)
                if (job.deckId === id) jobs.delete(key);
              send(res, 200, { ok: true });
            });
            return;
          }
          if (action === "assets" && req.method === "POST") {
            const ext = extname(
              url.searchParams.get("name") || "",
            ).toLowerCase();
            if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext))
              throw new Error("PNG/JPG/WebP/GIF 이미지를 선택해 주세요.");
            const b = await body(req, 12 * 1024 * 1024);
            const name = "assets/" + randomBytes(12).toString("hex") + ext;
            await store.locked(id, async () => {
              const meta = await store.meta(id);
              const info = await inventory(store, id);
              if (
                info.files.length >= 300 ||
                info.assetBytes + b.length > 64 * 1024 * 1024
              )
                throw new Error(
                  "자료는 300개 파일, 64MB까지 저장할 수 있습니다.",
                );
              await mkdir(store.path(id, "assets/assets"), { recursive: true });
              await writeFile(store.path(id, "assets", name), b, {
                mode: 0o600,
              });
              meta.uploadedFiles = [...(meta.uploadedFiles || []), name];
              await store.atomic(store.path(id, "meta.json"), meta);
            });
            send(res, 201, { src: name });
            return;
          }
          if (action === "export" && req.method === "POST") {
            if (busy) {
              send(res, 429, {
                error:
                  "다른 파일을 만드는 중입니다. 완료 후 다시 시도해 주세요.",
              });
              return;
            }
            const b = await json(req);
            if (!["html", "pdf", "pptx", "pptx-editable"].includes(b.format))
              throw new Error("출력 형식 오류");
            return store.locked(id, async () => {
              const d = await store.get(id, b.revision);
              if (d.deleted) {
                send(res, 409, {
                  error: "휴지통의 자료는 복원한 후 다운로드해 주세요.",
                });
                return;
              }
              if (busy) {
                send(res, 429, {
                  error:
                    "다른 파일을 만드는 중입니다. 완료 후 다시 시도해 주세요.",
                });
                return;
              }
              const key = randomBytes(16).toString("hex");
              const job = {
                id: key,
                deckId: id,
                revision: d.revision,
                status: "working",
                format: b.format,
              };
              jobs.set(key, job);
              busy = true;
              setImmediate(async () => {
                try {
                  const { exportDeck } = await import("./export.js");
                  const result = await (opts.exporter || exportDeck)({
                    store,
                    deck: d,
                    format: b.format,
                    includeNotes: b.includeNotes === true,
                    url: (expose(d).previewUrl + (b.includeNotes === true ? "" : "&omitNotes=1")).replace(
                      contentOrigin,
                      renderOrigin,
                    ),
                    contentOrigin: renderOrigin,
                  });
                  Object.assign(job, { status: "done", ...result });
                } catch (e) {
                  job.status = "error";
                  job.error = "파일 생성 실패: " + e.message;
                } finally {
                  busy = false;
                  setTimeout(() => jobs.delete(key), 30 * 60000).unref();
                }
              });
              send(res, 202, { id: key });
            });
          }
        }
        const j = /^\/api\/jobs\/([a-f0-9]{32})(\/download)?$/.exec(
          url.pathname,
        );
        if (j && req.method === "GET") {
          const job = jobs.get(j[1]);
          if (!job) {
            send(res, 404, { error: "출력 작업이 만료되었습니다." });
            return;
          }
          if (j[2]) {
            if (job.status !== "done")
              throw new Error("아직 파일이 준비되지 않았습니다.");
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="slides-r${job.revision}.${job.extension}"`,
            );
            send(res, 200, job.buffer, job.mime);
            return;
          }
          const { buffer, ...publicJob } = job;
          send(res, 200, publicJob);
          return;
        }
        send(res, 404, { error: "요청을 찾을 수 없습니다." });
        return;
      }
      if (url.pathname === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      const p = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!["index.html", "help.html", "style.css", "app.js", "workflow-ui.js", "upload-ui.js", "upload-check.js", "time.js", "ai-connection.js", "presenter.js", "presenter.html", "presenter.css", "preflight-ui.js", "authoring-ui.js", "slide-ui.js", "slide-model.js", "data-ui.js", "data-grid.css", "ribbon-ui.js", "link-ui.js", "data-model.js", "jszip.min.js", "text-model.js", "object-model.js"].includes(p)) {
        send(res, 404, { error: "페이지를 찾을 수 없습니다." });
        return;
      }
      const file =
        p === "jszip.min.js"
          ? join(base, "node_modules/jszip/dist/jszip.min.js")
          : join(base, "public", p);
      send(res, 200, await readFile(file), types[extname(p)]);
    }),
  );
  const content = http.createServer(
    wrapped(async (req, res) => {
      if (
        req.headers.host !== new URL(contentOrigin).host &&
        !(
          req.headers.host === new URL(renderOrigin).host &&
          ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
            req.socket.remoteAddress,
          )
        )
      ) {
        send(res, 421, { error: "호스트 오류" });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
        send(res, 405, { error: "읽기 전용" });
        return;
      }
      const url = new URL(req.url, contentOrigin);
      if (["/_studio/presentation.js", "/_studio/bridge.js", "/_studio/text-model.js", "/_studio/text-editor.js", "/_studio/object-model.js", "/_studio/data-model.js", "/_studio/effects.js"].includes(url.pathname)) {
        send(
          res,
          200,
          await readFile(join(base, "public", url.pathname.split("/").at(-1))),
          "text/javascript",
        );
        return;
      }
      const m = /^\/[va]\/([a-f0-9-]{36})\/([a-f0-9]{48}|[a-f0-9]{64})\/(.+)$/.exec(
        url.pathname,
      );
      if (!m) {
        send(res, 404, { error: "자료를 찾을 수 없습니다." });
        return;
      }
      const [, id, token, raw] = m;
      const audiencePath=url.pathname.startsWith("/a/");
      const meta = await store.meta(id);
      const preview = !audiencePath && token === meta.previewToken;
      const audience = audiencePath && token === audienceToken(meta);
      const share = !audiencePath && token === meta.shareToken;
      if (meta.deleted || !(preview || audience || share)) {
        send(res, 404, { error: "공유가 종료되었거나 자료가 없습니다." });
        return;
      }
      if (share && meta.shareExpiresAt && Date.parse(meta.shareExpiresAt) <= Date.now()) { send(res,410,{error:'이 공유 링크는 만료되었습니다.'});return; }
      const accessPath=`/v/${id}/${token}/`;
      if (share && meta.sharePassword) {
        const cookie=/studio_share=([a-f0-9]{64})/.exec(req.headers.cookie||'')?.[1];
        const access=shareSessions.get(cookie);
        const authorized=access && access.id===id && access.version===meta.shareAccessVersion && access.expires>Date.now();
        if(req.method==='POST' && raw==='unlock') {
          if(req.headers.origin!==contentOrigin){send(res,403,{error:'공유 화면에서 암호를 입력해 주세요.'});return;}
          const key='share:'+req.socket.remoteAddress+':'+id,now=Date.now();let attempt=attempts.get(key)||{count:0,at:now};
          if(now-attempt.at>60000)attempt={count:0,at:now};attempts.set(key,attempt);
          if(++attempt.count>10){send(res,429,{error:'잠시 후 다시 시도해 주세요.'});return;}
          const form=new URLSearchParams((await body(req,2048)).toString()),password=form.get('password');
          const valid=typeof password==='string'&&password.length<=128&&timingSafeEqual(scryptSync(password,meta.sharePassword.salt,64),Buffer.from(meta.sharePassword.hash,'hex'));
          if(!valid){send(res,401,'암호가 올바르지 않습니다. 뒤로 돌아가 다시 입력해 주세요.','text/plain; charset=utf-8');return;}
          const sid=randomBytes(32).toString('hex');shareSessions.set(sid,{id,version:meta.shareAccessVersion,expires:Date.now()+3600000});
          res.setHeader('Set-Cookie',`studio_share=${sid}; HttpOnly; SameSite=Strict; Path=${accessPath}; Max-Age=3600${contentOrigin.startsWith('https:')?'; Secure':''}`);
          res.writeHead(303,{Location:accessPath+'index.html','Cache-Control':'no-store'});res.end();return;
        }
        if(!authorized) {
          if(raw!=='index.html'){send(res,401,{error:'공유 암호 확인이 필요합니다.'});return;}
          res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
          send(res,401,`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>공유 발표 열기</title><style>body{font:18px system-ui;max-width:420px;margin:15vh auto;padding:24px}input,button{font:inherit;padding:12px;margin-top:12px;box-sizing:border-box;width:100%}</style><h1>공유 발표 열기</h1><form method="post" action="${accessPath}unlock"><label>접근 암호<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label><button>발표 열기</button></form></html>`,'text/html; charset=utf-8');return;
        }
      }
      if(req.method==='POST'){send(res,405,{error:'읽기 전용'});return;}
      if(preview && !audiencePath && url.searchParams.get('mode')==='audience') {
        res.writeHead(302,{Location:`/a/${id}/${audienceToken(meta)}/${raw}`+url.search,'Cache-Control':'no-store'});res.end();return;
      }
      const revision = preview || audience
        ? url.searchParams.has("rev")
          ? Number(url.searchParams.get("rev"))
          : meta.revision
        : meta.publishedRevision;
      const p = safePath(decodeURIComponent(raw));
      res.setHeader(
        "Content-Security-Policy",
        `sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`,
      );
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
      );
      if (p === "index.html") {
        let d = await store.get(id, revision);
        if(preview && url.searchParams.has('proposal')) { const proposal=await workflows.proposal(id,url.searchParams.get('proposal')); d={...d,state:proposal.state}; }
        const omitNotes = audiencePath || url.searchParams.get('mode') === 'audience' || url.searchParams.get('omitNotes') === '1' || !preview && meta.shareIncludeNotes === false;
        const originalDeck = d;
        if(omitNotes) d=withoutNotesDeck(d);
        let source = await readFile(
          store.path(id, "assets/index.html"),
          "utf8",
        );
        if(omitNotes) source=withoutNotesHtml(source,originalDeck);
        const renderState = { ...d.state, notes: { ...d.sourceNotes, ...d.state.notes } };
        if (url.searchParams.get("mode") === "thumbnail") {
          const nonce = randomBytes(18).toString("base64");
          res.setHeader(
            "Content-Security-Policy",
            `sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'none'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`,
          );
          send(res, 200, renderThumbnail(source, renderState, url.searchParams.get("slide"), nonce), "text/html; charset=utf-8");
          return;
        }
        let html = renderDeck(source, renderState);
        if(omitNotes) html=withoutNotesHtml(html,originalDeck);
        // Per-document memory storage prevents an imported deck's old localStorage from overriding saved revisions.
        const bootstrap =
          '<script>(()=>{const m=new Map();const s={getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear()};try{Object.defineProperty(window,"localStorage",{value:s});}catch{}})();</script>';
        const config = {
          managerOrigin: origin,
          edit: preview && !url.searchParams.has("proposal") && url.searchParams.get("mode") === "edit",
          audience: audience || url.searchParams.get("mode") === "audience",
          publishedAt: share ? meta.publishedAt || null : null,
          publishedRevision: share ? meta.publishedRevision : null,
          state: d.state,
          slides: d.slides,
        };
        // External links open outside the presentation sandbox; editing stays isolated.
        if (!config.edit) res.setHeader("Content-Security-Policy", String(res.getHeader("Content-Security-Policy")).replace("sandbox allow-scripts allow-same-origin;", "sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox;"));
        html = html
          .replace(/<head([^>]*)>/i, '<head$1><script src="/_studio/presentation.js"></script>' + bootstrap)
          .replace(
            /<\/body>/i,
            `<script id="sd-config" type="application/json">${enc(config)}</script><script src="/_studio/text-model.js"></script><script src="/_studio/text-editor.js"></script><script src="/_studio/object-model.js"></script><script src="/_studio/data-model.js"></script><script src="/_studio/effects.js"></script><script src="/_studio/bridge.js"></script></body>`,
          );
        send(res, 200, html, "text/html; charset=utf-8");
        return;
      }
      if (/\.html$/i.test(p)) {
        send(res, 404, { error: "발표 진입점은 index.html입니다." });
        return;
      }
      const file = store.path(id, "assets", p);
      const info = await stat(file);
      if (!info.isFile()) throw new Error("파일 오류");
      let bytes=await readFile(file);
      if((audiencePath || !preview&&meta.shareIncludeNotes===false || preview&&url.searchParams.get('omitNotes')==='1') && /\.(js|json|css|svg)$/i.test(p)) bytes=Buffer.from(redactNoteText(bytes.toString('utf8'),await store.get(id,revision)));
      send(res,200,bytes,types[extname(p).toLowerCase()] || "application/octet-stream");
    }),
  );
  await new Promise((r, j) =>
    manager.once("error", j).listen(opts.port ?? 4310, host, r),
  );
  origin = opts.origin || `http://127.0.0.1:${manager.address().port}`;
  try {
    await new Promise((r, j) =>
      content.once("error", j).listen(opts.contentPort ?? 4311, host, r),
    );
    renderOrigin = `http://127.0.0.1:${content.address().port}`;
    contentOrigin =
      opts.contentOrigin || `http://127.0.0.1:${content.address().port}`;
    if (new URL(origin).origin === new URL(contentOrigin).origin)
      throw new Error("관리와 콘텐츠 주소는 달라야 합니다.");
  } catch (e) {
    manager.close();
    throw e;
  }
  return {
    origin,
    contentOrigin,
    store,
    close: async () => {
      manager.closeAllConnections();
      content.closeAllConnections();
      await Promise.all([
        new Promise((r) => manager.close(r)),
        new Promise((r) => content.close(r)),
      ]);
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startStudio({
    host: process.env.HOST,
    port: Number(process.env.PORT) || 4310,
    contentPort: Number(process.env.CONTENT_PORT) || 4311,
    root: process.env.DATA_DIR,
    password: process.env.STUDIO_PASSWORD,
    origin: process.env.APP_ORIGIN,
    contentOrigin: process.env.CONTENT_ORIGIN,
  });
  console.log(`Slides Studio: ${app.origin}\nContent: ${app.contentOrigin}`);
}
