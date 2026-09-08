import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  assert.match(launcher, /"\$HOME"\/Applications\/Codex\.app\/Contents\/Resources\/cua_node\/bin\/node/);
  assert.match(launcher, /"\$HOME"\/Applications\/ChatGPT\.app\/Contents\/Resources\/cua_node\/bin\/node/);
  assert.doesNotMatch(launcher, /CODEX_DECK_APP_PATH/);
  assert.ok(launcher.indexOf("/usr/bin/mdfind") > launcher.indexOf('for node_candidate in "${candidates[@]}"'));
  assert.match(launcher, /\/bin\/kill -KILL/);
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

test("watcher launcher accepts a per-user Codex app without starting Spotlight", {
  skip: process.platform !== "darwin"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-user-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const appPath = join(home, "Applications", "Codex.app");
  const fakeNode = join(appPath, "Contents", "Resources", "cua_node", "bin", "node");
  const fakeMdfind = join(root, "mdfind");
  const mdfindMarker = join(root, "mdfind-called");
  const launcherPath = join(root, "watcher-launch.sh");
  await mkdir(join(fakeNode, ".."), { recursive: true });
  await writeFile(fakeNode, `#!/bin/zsh
if [[ "$1" == "--version" ]]; then
  print -r -- "v20.0.0"
  exit 0
fi
  print -r -- "user-app-node-started"
`);
  await writeFile(fakeMdfind, `#!/bin/zsh
touch '${mdfindMarker}'
sleep 10
`);
  const launcher = buildWatcherLaunchScript(join(root, "missing-runtime.mjs"))
    .replace("  /opt/homebrew/bin/node", `  ${join(root, "missing-homebrew-node")}`)
    .replace("  /usr/local/bin/node", `  ${join(root, "missing-local-node")}`)
    .replace("  /Applications/Codex.app", `  ${join(root, "missing-codex.app")}`)
    .replace("  /Applications/ChatGPT.app", `  ${join(root, "missing-chatgpt.app")}`)
    .replaceAll("/usr/bin/mdfind", fakeMdfind);
  await writeFile(launcherPath, launcher);
  await Promise.all([chmod(fakeNode, 0o755), chmod(fakeMdfind, 0o755), chmod(launcherPath, 0o755)]);

  const { stdout } = await execFile("/bin/zsh", [launcherPath], {
    env: { ...process.env, HOME: home },
    timeout: 1500
  });
  assert.equal(stdout, "user-app-node-started\n");
  await assert.rejects(access(mdfindMarker));
});

test("watcher launcher bounds Spotlight when no direct Node candidate is usable", {
  skip: process.platform !== "darwin"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-spotlight-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const fakeMdfind = join(root, "mdfind");
  const mdfindMarker = join(root, "mdfind-called");
  const launcherPath = join(root, "watcher-launch.sh");
  await mkdir(home, { recursive: true });
  await writeFile(fakeMdfind, `#!/bin/zsh
trap '' TERM
touch '${mdfindMarker}'
while true; do :; done
`);
  let launcher = buildWatcherLaunchScript(join(root, "missing-runtime.mjs"));
  launcher = launcher
    .replaceAll("/opt/homebrew/bin/node", join(root, "missing-homebrew-node"))
    .replaceAll("/usr/local/bin/node", join(root, "missing-local-node"))
    .replaceAll("/Applications/Codex.app", join(root, "missing-codex.app"))
    .replaceAll("/Applications/ChatGPT.app", join(root, "missing-chatgpt.app"))
    .replaceAll("/usr/bin/mdfind", fakeMdfind)
    .replace(/>> '[^'\n]*watcher\.log'/, `>> '${join(root, "watcher.log")}'`);
  await writeFile(launcherPath, launcher);
  await Promise.all([chmod(fakeMdfind, 0o755), chmod(launcherPath, 0o755)]);

  const startedAt = Date.now();
  await assert.rejects(
    execFile("/bin/zsh", [launcherPath], {
      env: { ...process.env, HOME: home },
      timeout: 4000
    }),
    (error: unknown) => {
      assert.equal((error as { code?: number | string }).code, 78);
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 3500);
  await access(mdfindMarker);
});

test("watcher launcher reaps Spotlight and removes its temp file when signaled", {
  skip: process.platform !== "darwin"
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-signal-"));
  const home = join(root, "home");
  const fakeMdfind = join(root, "mdfind");
  const mdfindPidPath = join(root, "mdfind.pid");
  const launcherPath = join(root, "watcher-launch.sh");
  let mdfindPid: number | undefined;
  let launcherProcess: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    launcherProcess?.kill("SIGKILL");
    if (mdfindPid != null) {
      try {
        process.kill(mdfindPid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(home, { recursive: true });
  await writeFile(fakeMdfind, `#!/bin/zsh
trap '' TERM HUP INT
print -r -- "$$" > '${mdfindPidPath}'
while true; do :; done
`);
  let launcher = buildWatcherLaunchScript(join(root, "missing-runtime.mjs"));
  launcher = launcher
    .replaceAll("/opt/homebrew/bin/node", join(root, "missing-homebrew-node"))
    .replaceAll("/usr/local/bin/node", join(root, "missing-local-node"))
    .replaceAll("/Applications/Codex.app", join(root, "missing-codex.app"))
    .replaceAll("/Applications/ChatGPT.app", join(root, "missing-chatgpt.app"))
    .replaceAll("/usr/bin/mdfind", fakeMdfind)
    .replace(/>> '[^'\n]*watcher\.log'/, `>> '${join(root, "watcher.log")}'`);
  await writeFile(launcherPath, launcher);
  await Promise.all([chmod(fakeMdfind, 0o755), chmod(launcherPath, 0o755)]);

  const child = spawn("/bin/zsh", [launcherPath], {
    env: { ...process.env, HOME: home, TMPDIR: root },
    stdio: "ignore"
  });
  launcherProcess = child;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      mdfindPid = Number.parseInt(await readFile(mdfindPidPath, "utf8"), 10);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(mdfindPid != null && Number.isSafeInteger(mdfindPid));
  assert.ok((await readdir(root)).some((name) => name.startsWith("codex-deck-mdfind.")));

  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("launcher did not exit after SIGTERM")), 1500))
  ]);
  assert.throws(() => process.kill(mdfindPid!, 0), { code: "ESRCH" });
  mdfindPid = undefined;
  assert.equal((await readdir(root)).some((name) => name.startsWith("codex-deck-mdfind.")), false);
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
