import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const roots = process.argv.slice(2).length
  ? process.argv.slice(2).map((path) => resolve(path))
  : [resolve("dist/com.simeo.codex-deck.sdPlugin"), resolve("release/codex-deck-launcher"), resolve("release/codex-deck-launcher-macos")];

const forbiddenFiles = new Set([
  "codex-micro-bridge.json", "control-target.json", "host.json", "relay-client.json", "relay-server.json",
  "mobile-relay-server.json", "mobile-local-relay-server.json", "mobile-local-pairing.svg",
  "relay-tunnel.pid", "watcher-state.json", "watcher.log", "watcher.log.1", "watcher.log.2", "watcher.log.3"
]);
const protectedKeycaps = new Set("FAST APPR REJ SPLIT MIC CODEX BUG OAI TERM DWN DEL NEW NAV MAGIC DIFF PLAY GIT BRCH MRG PR PAINT LAB PARTY TIME MIND+ MIND- SETUP FOLD UPL APPS".split(" "));
const forbiddenText = [
  /[A-Z]:\\Users\\(?!Public\\|Default\\|tester\\)[^\\/\s]+/iu,
  /\/Users\/(?!Shared\/|tester\/)[^/\s]+/iu,
  /\b100\.(?:\d{1,3}\.){2}\d{1,3}\b(?!\/10)/u,
  ...String(process.env.CODEX_DECK_PRIVATE_MARKERS ?? "").split("|").filter(Boolean).map((marker) => new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"))
];
const textExtensions = new Set([".cmd", ".command", ".html", ".js", ".json", ".map", ".md", ".mjs", ".ps1", ".sh", ".svg", ".txt"]);
const codexDialAssets = [
  "static/property-inspector/codex-dial.html",
  "static/layouts/codex-dial.json",
  "static/imgs/dial.svg",
  "static/imgs/dial@2x.svg"
];
const failures = [];

async function walk(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await walk(resolve(path, entry));
    return;
  }
  const name = basename(path);
  if (name === ".DS_Store" || name.startsWith("._")) failures.push(`${path}: platform metadata must not be packaged`);
  if (forbiddenFiles.has(name.toLowerCase())) failures.push(`${path}: private runtime state must not be packaged`);
  if (extname(name).toLowerCase() === ".svg" && protectedKeycaps.has(name.slice(0, -4).toUpperCase())) {
    failures.push(`${path}: protected Codex keycap SVG must not be packaged`);
  }
  if (!textExtensions.has(extname(name).toLowerCase()) || info.size > 8 * 1024 * 1024) return;
  const contents = await readFile(path, "utf8");
  for (const pattern of forbiddenText) if (pattern.test(contents)) failures.push(`${path}: contains private setup marker ${pattern}`);
}

async function readPluginManifest(root) {
  const manifestPath = resolve(root, "manifest.json");
  const pluginRoot = basename(root).toLowerCase().endsWith(".sdplugin");
  let source;
  try { source = await readFile(manifestPath, "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      if (pluginRoot) failures.push(`${manifestPath}: plugin manifest is required for a .sdPlugin root`);
      return undefined;
    }
    failures.push(`${manifestPath}: cannot read plugin manifest (${String(error)})`);
    return undefined;
  }
  let manifest;
  try { manifest = JSON.parse(source); }
  catch {
    failures.push(`${manifestPath}: plugin manifest is not valid JSON`);
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    failures.push(`${manifestPath}: plugin manifest must be a JSON object`);
    return undefined;
  }
  if (!Array.isArray(manifest.Actions)) {
    failures.push(`${manifestPath}: plugin manifest Actions must be an array`);
    return undefined;
  }
  return manifest;
}

async function auditDeclaredCodexDialAssets(root) {
  const manifest = await readPluginManifest(root);
  if (!manifest) {
    return;
  }
  const declaresDial = manifest.Actions.some(
    (action) => action?.UUID === "com.simeo.codex-deck.codex-dial"
  );
  if (!declaresDial) return;
  for (const relative of codexDialAssets) {
    try {
      const info = await stat(resolve(root, relative));
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      failures.push(`${root}: missing packaged Codex Dial asset: ${relative}`);
    }
  }
}

for (const root of roots) {
  try {
    await walk(root);
    await auditDeclaredCodexDialAssets(root);
  }
  catch (error) { failures.push(`${root}: cannot audit (${String(error)})`); }
}

if (failures.length) {
  console.error("Release audit failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Release audit passed for ${roots.length} artifact roots.`);
