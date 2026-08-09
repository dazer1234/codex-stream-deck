import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const auditScript = fileURLToPath(new URL("../scripts/audit-release.mjs", import.meta.url));

function audit(root: string) {
  return spawnSync(process.execPath, [auditScript, root], { encoding: "utf8" });
}

test("release audit accepts explicit clean roots and rejects private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-audit-"));
  try {
    const clean = join(root, "clean");
    await mkdir(clean);
    await writeFile(join(clean, "README.txt"), "public release fixture\n", "utf8");
    const cleanResult = audit(clean);
    assert.equal(cleanResult.status, 0, cleanResult.stderr);
    assert.match(cleanResult.stdout, /passed for 1 artifact roots/);

    await writeFile(join(clean, "relay-client.json"), "{}\n", "utf8");
    const privateResult = audit(clean);
    assert.equal(privateResult.status, 1);
    assert.match(privateResult.stderr, /private runtime state must not be packaged/);

    await rm(join(clean, "relay-client.json"));
    await writeFile(join(clean, "._manifest.json"), "local metadata\n", "utf8");
    const metadataResult = audit(clean);
    assert.equal(metadataResult.status, 1);
    assert.match(metadataResult.stderr, /platform metadata must not be packaged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release audit fails closed for missing or malformed sdPlugin manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-plugin-manifest-audit-"));
  try {
    const fixtures: Array<[string, string | undefined, RegExp]> = [
      ["sample.sdPlugin", undefined, /plugin manifest is required/],
      ["missing-manifest.sdPlugin", undefined, /plugin manifest is required/],
      ["malformed.sdPlugin", "{", /plugin manifest is not valid JSON/],
      ["array.sdPlugin", "[]", /plugin manifest must be a JSON object/],
      ["actions-missing.sdPlugin", "{}", /plugin manifest Actions must be an array/],
      ["actions-null.sdPlugin", '{"Actions":null}', /plugin manifest Actions must be an array/],
      ["actions-object.sdPlugin", '{"Actions":{}}', /plugin manifest Actions must be an array/]
    ];

    for (const [name, manifest, expected] of fixtures) {
      const plugin = join(root, name);
      await mkdir(plugin);
      if (name === "missing-manifest.sdPlugin") {
        await writeFile(join(plugin, "README.txt"), "fixture\n", "utf8");
      }
      if (manifest !== undefined) await writeFile(join(plugin, "manifest.json"), manifest, "utf8");
      const result = audit(plugin);
      assert.equal(result.status, 1, `${name} must fail closed`);
      assert.match(result.stderr, expected, `${name} reports the manifest contract`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release audit requires every packaged Codex Dial asset declared by a plugin manifest", async () => {
  const parent = await mkdtemp(join(tmpdir(), "codex-deck-dial-audit-"));
  const root = join(parent, "sample.sdPlugin");
  try {
    await mkdir(root);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      Actions: [{ UUID: "com.simeo.codex-deck.codex-dial", Controllers: ["Encoder"] }]
    }), "utf8");

    const missingResult = audit(root);
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

    const completeResult = audit(root);
    assert.equal(completeResult.status, 0, completeResult.stderr);
    assert.match(completeResult.stdout, /passed for 1 artifact roots/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
