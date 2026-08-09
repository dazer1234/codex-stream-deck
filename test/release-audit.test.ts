import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const auditScript = fileURLToPath(new URL("../scripts/audit-release.mjs", import.meta.url));
const dialUuid = "com.simeo.codex-deck.codex-dial";
const canonicalDial = {
  UUID: dialUuid,
  PropertyInspectorPath: "static/property-inspector/codex-dial.html",
  Encoder: {
    layout: "static/layouts/codex-dial.json",
    Icon: "static/imgs/dial"
  }
};

function audit(root: string) {
  return spawnSync(process.execPath, [auditScript, root], { encoding: "utf8" });
}

async function writeAssets(root: string, paths: string[]): Promise<void> {
  for (const relative of paths) {
    await mkdir(join(root, relative, ".."), { recursive: true });
    await writeFile(join(root, relative), "fixture\n", "utf8");
  }
}

async function writeCanonicalDialAssets(root: string): Promise<void> {
  await writeAssets(root, [
    canonicalDial.PropertyInspectorPath,
    canonicalDial.Encoder.layout,
    `${canonicalDial.Encoder.Icon}.svg`,
    `${canonicalDial.Encoder.Icon}@2x.svg`
  ]);
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
      Actions: [canonicalDial]
    }), "utf8");

    const missingResult = audit(root);
    assert.equal(missingResult.status, 1);
    const required = [
      "static/property-inspector/codex-dial.html",
      "static/layouts/codex-dial.json",
      "static/imgs/dial.svg",
      "static/imgs/dial@2x.svg"
    ];
    for (const relative of required) {
      assert.match(missingResult.stderr, new RegExp(`missing packaged Codex Dial asset: ${relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    await writeAssets(root, required);

    const completeResult = audit(root);
    assert.equal(completeResult.status, 0, completeResult.stderr);
    assert.match(completeResult.stdout, /passed for 1 artifact roots/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("release audit follows safe manifest-declared Codex Dial asset paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "codex-deck-declared-assets-audit-"));
  try {
    const relocated = join(parent, "relocated.sdPlugin");
    const relocatedDial = {
      UUID: dialUuid,
      PropertyInspectorPath: "ui/dial-inspector.html",
      Encoder: { layout: "feedback/dial-layout.json", Icon: "art/encoder/dial-mark" }
    };
    await mkdir(relocated);
    await writeFile(join(relocated, "manifest.json"), JSON.stringify({ Actions: [relocatedDial] }), "utf8");
    await writeAssets(relocated, [
      relocatedDial.PropertyInspectorPath,
      relocatedDial.Encoder.layout,
      `${relocatedDial.Encoder.Icon}.svg`,
      `${relocatedDial.Encoder.Icon}@2x.svg`
    ]);
    const relocatedResult = audit(relocated);
    assert.equal(relocatedResult.status, 0, relocatedResult.stderr);

    const wrong = join(parent, "wrong-declarations.sdPlugin");
    const wrongDial = {
      UUID: dialUuid,
      PropertyInspectorPath: "declared/missing-inspector.html",
      Encoder: { layout: "declared/missing-layout.json", Icon: "declared/missing-icon" }
    };
    await mkdir(wrong);
    await writeFile(join(wrong, "manifest.json"), JSON.stringify({ Actions: [wrongDial] }), "utf8");
    await writeCanonicalDialAssets(wrong);
    const wrongResult = audit(wrong);
    assert.equal(wrongResult.status, 1, "canonical files cannot satisfy different declared paths");
    for (const relative of [
      wrongDial.PropertyInspectorPath,
      wrongDial.Encoder.layout,
      `${wrongDial.Encoder.Icon}.svg`,
      `${wrongDial.Encoder.Icon}@2x.svg`
    ]) assert.match(wrongResult.stderr, new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("release audit rejects duplicate, incomplete, typed-wrong, and unsafe Codex Dial declarations", async () => {
  const parent = await mkdtemp(join(tmpdir(), "codex-deck-unsafe-dial-audit-"));
  try {
    const cases: Array<[string, unknown, RegExp]> = [
      ["missing-dial", { Actions: [] }, /exactly one Codex Dial action/],
      ["duplicate-dial", { Actions: [canonicalDial, canonicalDial] }, /exactly one Codex Dial action/],
      ["missing-encoder", { Actions: [{ UUID: dialUuid, PropertyInspectorPath: canonicalDial.PropertyInspectorPath }] }, /Encoder must be an object/],
      ["missing-inspector", { Actions: [{ UUID: dialUuid, Encoder: canonicalDial.Encoder }] }, /PropertyInspectorPath must be a non-empty safe relative path/],
      ["wrong-inspector-type", { Actions: [{ ...canonicalDial, PropertyInspectorPath: 7 }] }, /PropertyInspectorPath must be a non-empty safe relative path/],
      ["missing-layout", { Actions: [{ ...canonicalDial, Encoder: { Icon: canonicalDial.Encoder.Icon } }] }, /Encoder\.layout must be a non-empty safe relative path/],
      ["wrong-layout-type", { Actions: [{ ...canonicalDial, Encoder: { ...canonicalDial.Encoder, layout: [] } }] }, /Encoder\.layout must be a non-empty safe relative path/],
      ["missing-icon", { Actions: [{ ...canonicalDial, Encoder: { layout: canonicalDial.Encoder.layout } }] }, /Encoder\.Icon must be a non-empty safe relative extensionless path/],
      ["wrong-icon-type", { Actions: [{ ...canonicalDial, Encoder: { ...canonicalDial.Encoder, Icon: {} } }] }, /Encoder\.Icon must be a non-empty safe relative extensionless path/],
      ["traversal", { Actions: [{ ...canonicalDial, PropertyInspectorPath: "../outside.html" }] }, /PropertyInspectorPath must be a non-empty safe relative path/],
      ["normalized-traversal", { Actions: [{ ...canonicalDial, Encoder: { ...canonicalDial.Encoder, layout: "static/layouts/../manifest.json" } }] }, /Encoder\.layout must be a non-empty safe relative path/],
      ["posix-absolute", { Actions: [{ ...canonicalDial, PropertyInspectorPath: "/tmp/dial.html" }] }, /PropertyInspectorPath must be a non-empty safe relative path/],
      ["windows-absolute", { Actions: [{ ...canonicalDial, Encoder: { ...canonicalDial.Encoder, Icon: "C:\\temp\\dial" } }] }, /Encoder\.Icon must be a non-empty safe relative extensionless path/],
      ["backslash-relative", { Actions: [{ ...canonicalDial, Encoder: { ...canonicalDial.Encoder, layout: "static\\layouts\\dial.json" } }] }, /Encoder\.layout must be a non-empty safe relative path/],
      ["icon-extension", { Actions: [{ ...canonicalDial, Encoder: { ...canonicalDial.Encoder, Icon: "static/imgs/dial.svg" } }] }, /Encoder\.Icon must be a non-empty safe relative extensionless path/]
    ];

    for (const [name, manifest, expected] of cases) {
      const root = join(parent, `${name}.sdPlugin`);
      await mkdir(root);
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest), "utf8");
      await writeCanonicalDialAssets(root);
      const result = audit(root);
      assert.equal(result.status, 1, `${name} must fail closed`);
      assert.match(result.stderr, expected, `${name} reports the rejected declaration`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
