import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const derive = promisify(scrypt);
export class PasswordStore {
  constructor(store) {
    this.store = store;
    this.file = join(store.root, "_auth.json");
    this.record = null;
    this.pending = Promise.resolve();
  }
  async init(initial) {
    try {
      this.record = JSON.parse(await readFile(this.file, "utf8"));
      if (
        this.record.algorithm !== "scrypt-v1" ||
        !/^[a-f0-9]{32}$/.test(this.record.salt) ||
        !/^[a-f0-9]{128}$/.test(this.record.hash)
      )
        throw new Error("암호 저장 파일이 올바르지 않습니다.");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      if (initial) await this.save(initial);
    }
  }
  get enabled() {
    return !!this.record;
  }
  locked(fn) {
    const next = this.pending.catch(() => {}).then(fn);
    this.pending = next;
    return next;
  }
  async verify(password) {
    if (typeof password !== "string" || password.length > 128) return false;
    if (!this.record) return false;
    const hash = await derive(password, this.record.salt, 64);
    return timingSafeEqual(hash, Buffer.from(this.record.hash, "hex"));
  }
  async save(password) {
    const salt = randomBytes(16).toString("hex");
    const record = {
      algorithm: "scrypt-v1",
      salt,
      hash: (await derive(password, salt, 64)).toString("hex"),
    };
    await this.store.atomic(this.file, record);
    this.record = record;
  }
}
