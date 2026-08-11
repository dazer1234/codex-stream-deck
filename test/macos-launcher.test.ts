import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildCodexLaunchSpec, buildLaunchAgentPlist, buildWatcherLaunchScript, parseDebugPort } from "../launcher/macos/codex-deck-macos.js";
import { codexDeckStateRoot } from "../src/codex-deck-paths.js";

const execFile = promisify(execFileCallback);

test("macOS launcher uses LaunchServices and passes loopback-only CDP arguments", () => {
  const spec = buildCodexLaunchSpec({ appPath: "/Applications/Unexpected Codex Name.app" }, 43123);
  assert.equal(spec.command, "/usr/bin/open");
  assert.deepEqual(spec.args, [
    "-n",
    "-a",
    "/Applications/Unexpected Codex Name.app",
    "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=43123"
  ]);
  assert.doesNotMatch(spec.args.join(" "), /0\.0\.0\.0/);
});

test("macOS launcher validates ports and parses both supported flag forms", () => {
  assert.throws(() => buildCodexLaunchSpec({ appPath: "/Applications/Codex.app" }, 0), /Invalid debugging port/);
  assert.equal(parseDebugPort("Codex --remote-debugging-port=43123"), 43123);
  assert.equal(parseDebugPort("Codex --remote-debugging-port 43124"), 43124);
  assert.equal(parseDebugPort("Codex --remote-debugging-port=70000"), null);
});

test("bridge and user icon state use the native macOS Application Support root", () => {
  assert.equal(
    codexDeckStateRoot("darwin", "/Users/tester"),
    "/Users/tester/Library/Application Support/CodexDeck"
  );
  assert.equal(
    codexDeckStateRoot("win32", "C:\\Users\\tester", "C:\\Users\\tester\\AppData\\Local"),
    "C:\\Users\\tester\\AppData\\Local\\CodexDeck"
  );
});

test("LaunchAgent uses a dynamic Node resolver instead of pinning an NVM version", () => {
  const launcher = buildWatcherLaunchScript("/tmp/Codex Deck/runtime.mjs");
  const plist = buildLaunchAgentPlist("/tmp/Codex Deck/watcher-launch.sh");
  assert.match(launcher, /\/opt\/homebrew\/bin\/node/);
  assert.match(launcher, /\/usr\/local\/bin\/node/);
  assert.match(launcher, /\.nvm\/versions\/node\/\*\/bin\/node/);
  assert.match(launcher, /\/Applications\/Codex\.app\/Contents\/Resources\/cua_node\/bin\/node/);
  assert.match(launcher, /\/Applications\/ChatGPT\.app\/Contents\/Resources\/cua_node\/bin\/node/);
  assert.doesNotMatch(launcher, /mdfind/);
  assert.match(launcher, /Node\.js 20 or newer/);
  assert.match(plist, /<string>\/bin\/zsh<\/string>/);
  assert.match(plist, /watcher-launch\.sh/);
  assert.match(plist, /watcher\.stderr\.log/);
  assert.doesNotMatch(plist, /\.nvm\/versions\/node\/v\d/);
});

test("watcher launcher starts a direct Node candidate without waiting for Spotlight", {
  skip: process.platform !== "darwin"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const fakeNode = join(home, ".nvm", "versions", "node", "v20.0.0", "bin", "node");
  const fakeMdfind = join(root, "mdfind");
  const mdfindMarker = join(root, "mdfind-called");
  const runtime = join(root, "runtime.mjs");
  const launcherPath = join(root, "watcher-launch.sh");
  await mkdir(join(fakeNode, ".."), { recursive: true });
  await writeFile(fakeNode, `#!/bin/zsh
if [[ "$1" == "--version" ]]; then
  print -r -- "v20.0.0"
  exit 0
fi
print -r -- "watcher-started"
`);
  await writeFile(fakeMdfind, `#!/bin/zsh
touch '${mdfindMarker}'
sleep 10
`);
  await writeFile(runtime, `process.stdout.write("watcher-started\\n");\n`);
  const launcher = buildWatcherLaunchScript(runtime).replaceAll("/usr/bin/mdfind", fakeMdfind);
  await writeFile(launcherPath, launcher);
  await Promise.all([chmod(fakeNode, 0o755), chmod(fakeMdfind, 0o755), chmod(launcherPath, 0o755)]);

  const { stdout } = await execFile("/bin/zsh", [launcherPath], {
    env: { ...process.env, HOME: home },
    timeout: 1500
  });
  assert.equal(stdout, "watcher-started\n");
  await assert.rejects(access(mdfindMarker));
});

test("manual and double-click launch resolve Node outside an interactive shell", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../launcher/start-codex-deck.sh", import.meta.url), "utf8"));
  assert.match(source, /\.nvm\/versions\/node\/\*\/bin\/node/);
  assert.match(source, /Contents\/Resources\/cua_node\/bin\/node/);
  assert.match(source, /node_major/);
  assert.doesNotMatch(source, /exec \/usr\/bin\/env node/);
});

test("macOS release packaging preserves executable launchers", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../scripts/package-macos-release.sh", import.meta.url), "utf8"));
  assert.match(source, /chmod 755/);
  assert.match(source, /start-codex-deck\.sh/);
  assert.match(source, /Start Codex Deck\.command/);
  assert.match(source, /ditto -c -k/);
});

test("macOS runtime supports relay pairing without exposing the CDP listener", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../launcher/macos/codex-deck-macos.ts", import.meta.url), "utf8"));
  assert.match(source, /relay-config/);
  assert.match(source, /RELAY_SERVER_CONFIG_PATH/);
  assert.match(source, /CodexRelayServer/);
  assert.doesNotMatch(source, /remote-debugging-address=0\.0\.0\.0/);
});
