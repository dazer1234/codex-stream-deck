import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const auditScript = fileURLToPath(new URL("../scripts/audit-release.mjs", import.meta.url));

test("release audit accepts explicit clean roots and rejects private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-audit-"));
  try {
    const clean = join(root, "clean");
    await mkdir(clean);
    await writeFile(join(clean, "README.txt"), "public release fixture\n", "utf8");
    const cleanResult = spawnSync(process.execPath, [auditScript, clean], { encoding: "utf8" });
    assert.equal(cleanResult.status, 0, cleanResult.stderr);
    assert.match(cleanResult.stdout, /passed for 1 artifact roots/);

    await writeFile(join(clean, "relay-client.json"), "{}\n", "utf8");
    const privateResult = spawnSync(process.execPath, [auditScript, clean], { encoding: "utf8" });
    assert.equal(privateResult.status, 1);
    assert.match(privateResult.stderr, /private runtime state must not be packaged/);

    await rm(join(clean, "relay-client.json"));
    await writeFile(join(clean, "._manifest.json"), "local metadata\n", "utf8");
    const metadataResult = spawnSync(process.execPath, [auditScript, clean], { encoding: "utf8" });
    assert.equal(metadataResult.status, 1);
    assert.match(metadataResult.stderr, /platform metadata must not be packaged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release audit requires every packaged Codex Dial asset declared by a plugin manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-dial-audit-"));
  try {
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      Actions: [{ UUID: "com.simeo.codex-deck.codex-dial", Controllers: ["Encoder"] }]
    }), "utf8");

    const missingResult = spawnSync(process.execPath, [auditScript, root], { encoding: "utf8" });
    assert.equal(missingResult.status, 1);
    for (const relative of [
      "static/property-inspector/codex-dial.html",
      "static/layouts/codex-dial.json",
      "static/imgs/dial.svg",
      "static/imgs/dial@2x.svg"
    ]) {
      assert.match(missingResult.stderr, new RegExp(`missing packaged Codex Dial asset: ${relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      await mkdir(join(root, relative, ".."), { recursive: true });
      await writeFile(join(root, relative), "fixture\n", "utf8");
    }

    const completeResult = spawnSync(process.execPath, [auditScript, root], { encoding: "utf8" });
    assert.equal(completeResult.status, 0, completeResult.stderr);
    assert.match(completeResult.stdout, /passed for 1 artifact roots/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
