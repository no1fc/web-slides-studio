import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  cp,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { initialState, validateState } from "./deck.js";
import { authoringAssets } from "./authoring.js";
export class Store {
  constructor(root) {
    this.root = root;
    this.locks = new Map();
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  path(id, ...rest) {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error("잘못된 자료 ID");
    return join(this.root, id, ...rest);
  }
  async atomic(file, data) {
    const temp = file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, file);
  }
  async locked(id, fn) {
    const prior = this.locks.get(id) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  async create(input) {
    const id = randomUUID();
    const dir = this.path(id);
    await mkdir(join(dir, "revisions"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    for (const [p, bytes] of input.files) {
      const target = join(dir, "assets", p);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes, { mode: 0o600 });
    }
    const now = new Date().toISOString();
    const meta = {
      id,
      title: input.title.slice(0, 180),
      folder: "",
      revision: 1,
      slides: input.slides,
      elements: input.elements,
      createdAt: now,
      updatedAt: now,
      deleted: false,
      previewToken: randomBytes(24).toString("hex"),
      shareToken: null,
      publishedRevision: null,
    };
    await this.atomic(join(dir, "revisions/1.json"), {
      state: initialState(input),
      savedAt: now,
    });
    await this.atomic(join(dir, "meta.json"), meta);
    return this.get(id);
  }
  async meta(id) {
    return JSON.parse(await readFile(this.path(id, "meta.json"), "utf8"));
  }
  async get(id, revision) {
    const meta = await this.meta(id);
    const n = revision ?? meta.revision;
    if (!Number.isSafeInteger(n) || n < 1 || n > meta.revision)
      throw new Error("버전을 찾을 수 없습니다.");
    const snap = JSON.parse(
      await readFile(this.path(id, "revisions", n + ".json"), "utf8"),
    );
    return { ...meta, ...snap, state: validateState(snap.state, meta), revision: n };
  }
  async list() {
    const entries = await readdir(this.root);
    const result = [];
    for (const id of entries) {
      if (!/^[\da-f-]{36}$/.test(id)) continue;
      try {
        result.push(await this.meta(id));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async save(id, baseRevision, raw) {
    return this.locked(id, async () => {
      const meta = await this.meta(id);
      if (baseRevision !== meta.revision) {
        const e = new Error(
          "다른 창에서 수정되었습니다. 새로 열기 전에 현재 변경을 확인해 주세요.",
        );
        e.status = 409;
        throw e;
      }
      const state = validateState(raw, meta);
      const imageItems = [...Object.values(state.patches), ...state.added];
      for (let i = 0; i < imageItems.length; i++) {
        const item = imageItems[i];
        if (item.group) imageItems.push(...item.group.children);
        if (!item.src) continue;
        try {
          if (!(await stat(this.path(id, "assets", item.src))).isFile())
            throw new Error("missing");
        } catch {
          throw new Error(
            "이미지 파일이 삭제되었거나 없습니다. 다시 올려 주세요.",
          );
        }
      }
      for (const asset of authoringAssets(state)) {
        try {
          if (!(await stat(this.path(id, "assets", asset))).isFile()) throw new Error("missing");
        } catch {
          throw new Error(`코드에서 사용하는 파일이 없습니다: ${asset}`);
        }
      }
      const revision = meta.revision + 1;
      const now = new Date().toISOString();
      await this.atomic(this.path(id, "revisions", revision + ".json"), {
        state,
        savedAt: now,
      });
      await this.atomic(this.path(id, "meta.json"), {
        ...meta,
        revision,
        updatedAt: now,
      });
      return this.get(id);
    });
  }
  async update(id, patch) {
    return this.locked(id, async () => {
      const m = await this.meta(id);
      for (const k of ["title", "folder"])
        if (patch[k] !== undefined) {
          if (typeof patch[k] !== "string" || patch[k].length > 180)
            throw new Error("이름이 너무 깁니다.");
          m[k] = patch[k].trim();
        }
      if (typeof patch.deleted === "boolean") m.deleted = patch.deleted;
      if (m.deleted) {
        m.shareToken = null;
        m.publishedRevision = null;
      }
      m.updatedAt = new Date().toISOString();
      await this.atomic(this.path(id, "meta.json"), m);
      return m;
    });
  }
  async publish(id, enabled = true) {
    return this.locked(id, async () => {
      const m = await this.meta(id);
      if (m.deleted) throw new Error("휴지통의 자료는 게시할 수 없습니다.");
      m.shareToken = enabled
        ? m.shareToken || randomBytes(24).toString("hex")
        : null;
      m.publishedRevision = enabled ? m.revision : null;
      await this.atomic(this.path(id, "meta.json"), m);
      return m;
    });
  }
  async revisions(id) {
    const m = await this.meta(id);
    const out = [];
    for (let n = m.revision; n >= Math.max(1, m.revision - 99); n--) {
      const s = JSON.parse(
        await readFile(this.path(id, "revisions", n + ".json"), "utf8"),
      );
      out.push({ revision: n, savedAt: s.savedAt });
    }
    return out;
  }
  async duplicate(id) {
    return this.locked(id, async () => {
      const d = await this.get(id);
      const nid = randomUUID();
      await cp(this.path(id), this.path(nid), { recursive: true });
      const now = new Date().toISOString();
      const m = {
        ...(await this.meta(id)),
        id: nid,
        title: d.title + " 복사본",
        createdAt: now,
        updatedAt: now,
        previewToken: randomBytes(24).toString("hex"),
        shareToken: null,
        publishedRevision: null,
        deleted: false,
      };
      await this.atomic(this.path(nid, "meta.json"), m);
      return this.get(nid);
    });
  }
}
