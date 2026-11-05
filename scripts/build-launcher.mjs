import { build } from "esbuild";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("release/codex-deck-launcher");
const macOutput = resolve("release/codex-deck-launcher-macos");
await rm(output, { recursive: true, force: true });
await rm(macOutput, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(macOutput, { recursive: true });

await build({
  entryPoints: [resolve("launcher/runtime-override.ts")],
  outfile: resolve(output, "runtime-override.mjs"),
  bundle: true,
  external: ["ws"],
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false
});

await build({
  entryPoints: [resolve("launcher/mobile-pairing-cli.ts")],
  outfile: resolve(output, "mobile-pairing.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
});

// Copy the runtime package from an explicit allowlist. Cloud-sync conflict
// copies (for example `index 3.js`) must never leak into release archives.
const wsSource = resolve("node_modules/ws");
const wsOutput = resolve(output, "node_modules/ws");
await mkdir(resolve(wsOutput, "lib"), { recursive: true });
for (const filename of ["LICENSE", "package.json", "browser.js", "index.js", "wrapper.mjs"]) {
  await cp(resolve(wsSource, filename), resolve(wsOutput, filename));
}
for (const filename of [
  "buffer-util.js", "constants.js", "event-target.js", "extension.js",
  "limiter.js", "permessage-deflate.js", "receiver.js", "sender.js",
  "stream.js", "subprotocol.js", "validation.js", "websocket.js",
  "websocket-server.js"
]) {
  await cp(resolve(wsSource, "lib", filename), resolve(wsOutput, "lib", filename));
}

for (const filename of ["Start Codex Deck.cmd", "Start-CodexDeck.ps1", "Watch-CodexDeck.ps1", "Configure-CodexDeckRelay.ps1", "Configure-CodexDeckMobile.ps1", "README.txt"]) {
  await cp(resolve("launcher", filename), resolve(output, filename));
}
await cp(resolve("docs"), resolve(output, "docs"), { recursive: true });
await cp(resolve("README.md"), resolve(output, "README.md"));
await cp(resolve("LICENSE"), resolve(output, "LICENSE"));
await cp(resolve("SECURITY.md"), resolve(output, "SECURITY.md"));
await cp(resolve("CONTRIBUTING.md"), resolve(output, "CONTRIBUTING.md"));

await build({
  entryPoints: [resolve("launcher/macos/codex-deck-macos.ts")],
  outfile: resolve(macOutput, "codex-deck-macos.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
});

for (const filename of ["start-codex-deck.sh", "Start Codex Deck.command"]) {
  const destination = resolve(macOutput, filename);
  const contents = await readFile(resolve("launcher", filename), "utf8");
  await writeFile(destination, contents.replace(/\r\n/g, "\n"), { encoding: "utf8", mode: 0o755 });
  await chmod(destination, 0o755);
}
await cp(resolve("docs"), resolve(macOutput, "docs"), { recursive: true });
await cp(resolve("README.md"), resolve(macOutput, "README.md"));
await cp(resolve("LICENSE"), resolve(macOutput, "LICENSE"));
await cp(resolve("SECURITY.md"), resolve(macOutput, "SECURITY.md"));
await cp(resolve("CONTRIBUTING.md"), resolve(macOutput, "CONTRIBUTING.md"));
