import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { readBounded } from "../src/archive.js";
test("actual inflated bytes are bounded, independent of ZIP metadata", async () => {
  const z = new JSZip();
  z.file("data.txt", "x".repeat(4096));
  const zip = await JSZip.loadAsync(
    await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  await assert.rejects(readBounded(zip.file("data.txt"), 1024), /압축 해제/);
});
