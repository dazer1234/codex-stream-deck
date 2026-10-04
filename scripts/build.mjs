import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import "./generate-plugin-icons.mjs";

const output = resolve("dist/com.simeo.codex-deck.sdPlugin");
// Keep the package root itself because Windows may have a directory handle open
// while Stream Deck is installed. Clearing every child still prevents stale
// files from another OS (notably Finder AppleDouble `._*` entries) leaking into
// the next build.
await mkdir(output, { recursive: true });
for (const entry of await readdir(output)) {
  await rm(resolve(output, entry), { recursive: true, force: true });
}
await mkdir(resolve(output, "bin"), { recursive: true });
await mkdir(resolve(output, "static/imgs"), { recursive: true });
await mkdir(resolve(output, "static/layouts"), { recursive: true });
await mkdir(resolve(output, "static/property-inspector"), { recursive: true });
for (const filename of [
  "category-icon.svg", "category-icon@2x.svg",
  "dial.svg", "dial@2x.svg",
  "key.svg", "key@2x.svg",
  "plugin-icon.png", "plugin-icon@2x.png"
]) {
  await cp(resolve("static/imgs", filename), resolve(output, "static/imgs", filename));
}
await cp(resolve("static/manifest.json"), resolve(output, "manifest.json"));
await cp(resolve("static/property-inspector/usage-limit.html"), resolve(output, "static/property-inspector/usage-limit.html"));
await cp(resolve("static/property-inspector/agent.html"), resolve(output, "static/property-inspector/agent.html"));
await cp(resolve("static/property-inspector/codex-dial.html"), resolve(output, "static/property-inspector/codex-dial.html"));
await cp(resolve("static/layouts/codex-dial.json"), resolve(output, "static/layouts/codex-dial.json"));

await build({
  entryPoints: [resolve("src/plugin.ts")],
  outfile: resolve(output, "bin/plugin.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
});
