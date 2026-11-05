import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { findMicroSlotAsset } from "../launcher/macos/micro-asset.js";

test("discovers one safe slot asset from a bounded ASAR index", async () => {
  const root = join(process.cwd(), ".codex-private");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "asar-test-"));
  const path = join(dir, "app.asar");
  try {
    const writeIndex = async (files: Record<string, object>) => {
      const index = Buffer.from(JSON.stringify({ files: { webview: { files: { assets: { files } } } } }));
      const prefix = Buffer.alloc(16);
      prefix.writeUInt32LE(index.length + 8, 4);
      prefix.writeUInt32LE(index.length, 12);
      await writeFile(path, Buffer.concat([prefix, index]));
    };
    await writeIndex({ "codex-micro-slot-signals-abc123.js": {} });
    assert.equal(await findMicroSlotAsset(path), "codex-micro-slot-signals-abc123.js");
    await writeIndex({ "codex-micro-slot-signals-a.js": {}, "codex-micro-slot-signals-b.js": {} });
    assert.equal(await findMicroSlotAsset(path), undefined);
    await writeIndex({ "codex-micro-slot-signals-../bad.js": {} });
    assert.equal(await findMicroSlotAsset(path), undefined);
    await writeFile(path, Buffer.alloc(16, 255));
    assert.equal(await findMicroSlotAsset(path), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
