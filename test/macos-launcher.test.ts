import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertAuthorizedRestartGeneration,
  assertAuthorizedRestartInstallation,
  assertAuthorizedRestartReady,
  buildWatcherRecoveryAuthorization,
  buildCodexLaunchSpec,
  buildCodexRestartHandoffSpec,
  buildLaunchAgentPlist,
  buildWatcherLaunchScript,
  observeRunningCodex,
  parseDebugPort,
  parseProcessStartedAt,
  runExclusiveRestartHandoff,
  runGuardedWatcherRecovery,
  selectCodexInstallation,
  selectLaunchAgentNodePath,
  spawnDetachedRestartHandoff
} from "../launcher/macos/codex-deck-macos.js";
import { codexDeckStateRoot } from "../src/codex-deck-paths.js";

const execFile = promisify(execFileCallback);

const installationFixture = (appPath: string, version = "1.0") => ({
  appPath, version, bundleId: "com.openai.codex", buildVersion: "123",
  executableName: "ChatGPT", executablePath: `${appPath}/Contents/MacOS/ChatGPT`
});

test("running renamed Codex is discovered without scanning unrelated installed applications", async () => {
  const codex = installationFixture("/Applications/Unexpected Name.app");
  const selected = await selectCodexInstallation(
    ["/Applications/Other.app", codex.appPath, codex.appPath],
    async (path) => path === codex.appPath ? codex : null,
    async () => { throw new Error("full scan must not run when Codex is already identified"); }
  );
  assert.deepEqual(selected, codex);
});

test("multiple running Codex installations prefer the newest numeric version", async () => {
  const old = installationFixture("/Applications/Old.app", "1.9");
  const current = installationFixture("/Applications/New.app", "1.10");
  const selected = await selectCodexInstallation(
    [old.appPath, current.appPath],
    async (path) => path === old.appPath ? old : current,
    async () => { throw new Error("running installations do not need fallback"); }
  );
  assert.equal(selected.appPath, "/Applications/New.app");
});

test("discovery falls back when running candidates are not valid Codex installations", async () => {
  const old = installationFixture("/Applications/Old.app", "1.9");
  const current = installationFixture("/Applications/Codex.app", "1.10");
  const selected = await selectCodexInstallation(
    ["/Applications/Other.app"],
    async (path) => path === old.appPath ? old : path === current.appPath ? current : null,
    async () => [old.appPath, current.appPath]
  );
  assert.equal(selected.appPath, "/Applications/Codex.app");
});

test("discovery rejects absent or invalid installations instead of inventing a launch target", async () => {
  await assert.rejects(selectCodexInstallation([], async () => null, async () => []), /No installed Codex app/);
});

test("closed-app watcher observation never scans stopped installations", async () => {
  const result = await observeRunningCodex([
    { pid: 100, ppid: 1, startedAt: "Sun Oct  4 07:55:38 2026", command: "/usr/bin/daemon" },
    { pid: 200, ppid: 100, startedAt: "Sun Oct  4 07:55:38 2026", command: "/Applications/Codex.app/Contents/MacOS/ChatGPT" }
  ], async () => { throw new Error("No main app exists; no installed-app lookup should run"); });
  assert.deepEqual(result, { installation: null, main: null });
});

test("watcher observes the actual running Codex generation without fallback discovery", async () => {
  const codex = installationFixture("/Applications/Renamed.app");
  const row = { pid: 200, ppid: 1, startedAt: "Sun Oct  4 07:55:38 2026", command: `${codex.executablePath} --example` };
  const result = await observeRunningCodex([row], async (path) => {
    assert.equal(path, "/Applications/Renamed.app");
    return codex;
  });
  assert.deepEqual(result.installation, codex);
  assert.equal(result.main?.generation, "200:Sun Oct  4 07:55:38 2026:/Applications/Renamed.app/Contents/MacOS/ChatGPT");
});

test("watcher rejects unrelated main apps without performing stopped-app discovery", async () => {
  const result = await observeRunningCodex([
    { pid: 200, ppid: 1, startedAt: "Sun Oct  4 07:55:38 2026", command: "/Applications/Other.app/Contents/MacOS/Other" }
  ], async () => null);
  assert.deepEqual(result, { installation: null, main: null });
});

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

test("watcher parses process start time and fails closed on invalid timestamps", () => {
  const value = "Sun Sep 20 11:16:51 2026";
  assert.equal(parseProcessStartedAt(value), Date.parse(value));
  assert.equal(parseProcessStartedAt("not-a-process-time"), null);
});

test("macOS restart handoff survives the Codex terminal that requested it", () => {
  const spec = buildCodexRestartHandoffSpec("/tmp/codex-deck-macos.mjs", 43123, "/tmp/node");
  assert.equal(spec.command, "/tmp/node");
  assert.deepEqual(spec.args, ["/tmp/codex-deck-macos.mjs", "restart-handoff", "43123"]);
  assert.deepEqual(spec.options, { detached: true, stdio: "ignore" });
});

test("detached restart helper outlives its calling terminal process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "helper-finished");
  const helper = join(root, "helper.mjs");
  const parent = join(root, "parent.mts");
  await writeFile(helper, `import { writeFile } from "node:fs/promises";
setTimeout(() => void writeFile(${JSON.stringify(marker)}, "finished\\n"), 150);
`);
  await writeFile(parent, `import { buildCodexRestartHandoffSpec, spawnDetachedRestartHandoff } from ${JSON.stringify(resolve("launcher/macos/codex-deck-macos.ts"))};
async function main() {
  const spec = buildCodexRestartHandoffSpec(${JSON.stringify(helper)}, 43123, process.execPath);
  await spawnDetachedRestartHandoff(spec);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`);

  await execFile(process.execPath, ["--import", "tsx", parent]);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await access(marker).then(() => true).catch(() => false)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(await readFile(marker, "utf8"), "finished\n");
});

test("restart authorization rejects a replacement Codex generation", () => {
  assert.doesNotThrow(() => assertAuthorizedRestartGeneration({ generation: "expected" }, "expected"));
  assert.throws(
    () => assertAuthorizedRestartGeneration({ generation: "replacement" }, "expected"),
    /changed before the explicit restart/
  );
});

test("restart authorization stays pinned to the approved Codex installation", () => {
  const authorization = {
    expectedAppPath: "/Applications/Codex.app",
    expectedExecutablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT"
  };
  assert.doesNotThrow(() => assertAuthorizedRestartInstallation({
    appPath: authorization.expectedAppPath,
    executablePath: authorization.expectedExecutablePath
  }, authorization));
  assert.throws(() => assertAuthorizedRestartInstallation({
    appPath: "/Users/tester/Applications/Codex.app",
    executablePath: "/Users/tester/Applications/Codex.app/Contents/MacOS/ChatGPT"
  }, authorization), /installation changed before the explicit restart/);
});

test("watcher startup recovery is pinned to the exact observed Codex generation", () => {
  const main = {
    pid: 43123,
    startedAt: "Sun Sep 20 11:16:51 2026",
    generation: "43123:started:/Applications/Codex.app/Contents/MacOS/ChatGPT",
    installation: {
      appPath: "/Applications/Codex.app",
      executablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT"
    }
  };
  assert.deepEqual(buildWatcherRecoveryAuthorization(main, main.generation), {
    expectedGeneration: main.generation,
    expectedAppPath: main.installation.appPath,
    expectedExecutablePath: main.installation.executablePath,
    requireLiveProcess: true,
    restartDeadline: Date.parse(main.startedAt) + 60_000
  });
  assert.throws(() => buildWatcherRecoveryAuthorization(main, "replacement"), /generation changed/);
  assert.throws(() => buildWatcherRecoveryAuthorization(null, main.generation), /no longer running/);
});

test("startup recovery triggered after stabilization retains the full guarded shutdown budget", async () => {
  const main = {
    pid: 43123,
    startedAt: "Sun Sep 20 11:16:51 2026",
    generation: "43123:started:/Applications/Codex.app/Contents/MacOS/ChatGPT",
    installation: {
      appPath: "/Applications/Codex.app",
      executablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT"
    }
  };
  const startedAt = Date.parse(main.startedAt);
  const calls: string[] = [];
  const times = [startedAt + 20_000, startedAt + 21_000, startedAt + 22_000, startedAt + 23_000];
  await runGuardedWatcherRecovery(main, buildWatcherRecoveryAuthorization(main, main.generation), {
    now: () => times.shift()!,
    terminate: async () => { calls.push("terminate"); },
    confirmAbsent: async () => { calls.push("confirm-absent"); },
    launch: async () => { calls.push("launch"); }
  });
  assert.deepEqual(calls, ["terminate", "confirm-absent", "launch"]);
});

test("watcher recovery cancels when Codex disappears or crosses the startup deadline", () => {
  const authorization = {
    expectedGeneration: "43123:started:/Applications/Codex.app/Contents/MacOS/ChatGPT",
    expectedAppPath: "/Applications/Codex.app",
    expectedExecutablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
    requireLiveProcess: true as const,
    restartDeadline: 30_000
  };
  assert.throws(() => assertAuthorizedRestartReady(null, authorization, 20_000), /no longer running/);
  assert.throws(() => assertAuthorizedRestartReady({
    generation: authorization.expectedGeneration
  }, authorization, 30_001), /startup window expired/);
  assert.doesNotThrow(() => assertAuthorizedRestartReady({
    generation: authorization.expectedGeneration
  }, authorization, 30_000));
});

test("guarded watcher recovery never starts late or launches after its deadline", async () => {
  const authorization = {
    expectedGeneration: "B",
    expectedAppPath: "/Applications/Codex.app",
    expectedExecutablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
    requireLiveProcess: true as const,
    restartDeadline: 30_000
  };
  const main = { generation: "B" };
  const calls: string[] = [];
  const validTimes = [10_000, 20_000, 21_000, 22_000];
  await runGuardedWatcherRecovery(main, authorization, {
    now: () => validTimes.shift()!,
    terminate: async () => { calls.push("terminate"); },
    confirmAbsent: async () => { calls.push("confirm-absent"); },
    launch: async () => { calls.push("launch"); }
  });
  assert.deepEqual(calls, ["terminate", "confirm-absent", "launch"]);

  calls.length = 0;
  const crossingTimes = [10_000, 30_001];
  await assert.rejects(runGuardedWatcherRecovery(main, authorization, {
    now: () => crossingTimes.shift()!,
    terminate: async () => { calls.push("terminate"); },
    confirmAbsent: async () => { calls.push("confirm-absent"); },
    launch: async () => { calls.push("launch"); }
  }), /startup window expired/);
  assert.deepEqual(calls, ["terminate"], "a deadline crossing never verifies or launches late");

  calls.length = 0;
  await assert.rejects(runGuardedWatcherRecovery(main, authorization, {
    now: () => 14_000,
    terminate: async () => { calls.push("terminate"); },
    confirmAbsent: async () => { calls.push("confirm-absent"); },
    launch: async () => { calls.push("launch"); }
  }), /insufficient time/);
  assert.deepEqual(calls, [], "recovery never signals Codex without the full shutdown budget remaining");
});

test("LaunchAgent selection prefers a validated durable Node path", () => {
  const attempts: string[] = [];
  const selected = selectLaunchAgentNodePath(
    ["/opt/homebrew/bin/node", "/versioned/node"],
    (candidate) => {
      attempts.push(candidate);
      return candidate === "/opt/homebrew/bin/node" ? "v22.22.0" : "v24.0.0";
    }
  );
  assert.equal(selected, "/opt/homebrew/bin/node");
  assert.deepEqual(attempts, ["/opt/homebrew/bin/node"]);
  assert.throws(() => selectLaunchAgentNodePath(["/old/node"], () => "v18.0.0"), /Node.js 20 or newer/);
});

test("restart handoffs serialize and persist completed or rejected results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-handoff-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "restart.lock");
  const firstStatusPath = join(root, "first.json");
  const secondStatusPath = join(root, "second.json");
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstCanFinish = new Promise<void>((resolveFinish) => { releaseFirst = resolveFinish; });
  const firstStarted = new Promise<void>((resolveStarted) => { firstEntered = resolveStarted; });
  const request = (operationId: string) => ({
    operationId,
    expectedPid: 43123,
    expectedGeneration: "43123:started:/Applications/Codex.app/Contents/MacOS/ChatGPT",
    expectedAppPath: "/Applications/Codex.app",
    expectedExecutablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
    requestedAt: "2026-09-18T19:30:00.000Z"
  });

  const first = runExclusiveRestartHandoff(request("first"), { lockPath, statusPath: firstStatusPath }, async () => {
    firstEntered();
    await firstCanFinish;
  });
  await firstStarted;
  assert.equal(await runExclusiveRestartHandoff(request("second"), { lockPath, statusPath: secondStatusPath }, async () => {}), 3);
  releaseFirst();
  assert.equal(await first, 0);

  assert.equal(JSON.parse(await readFile(firstStatusPath, "utf8")).status, "completed");
  assert.equal(JSON.parse(await readFile(secondStatusPath, "utf8")).status, "rejected");
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

test("LaunchAgent executes the validated Node runtime directly without a shell", () => {
  const launcher = buildWatcherLaunchScript("/tmp/Codex Deck/runtime.mjs");
  const plist = buildLaunchAgentPlist("/tmp/Codex Deck/runtime.mjs", "/opt/homebrew/bin/node");
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
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/tmp\/Codex Deck\/runtime\.mjs<\/string>/);
  assert.match(plist, /<string>watch<\/string>/);
  assert.doesNotMatch(plist, /<string>\/bin\/zsh<\/string>/);
  assert.doesNotMatch(plist, /watcher-launch\.sh/);
  assert.doesNotMatch(plist, /<key>ProcessType<\/key>/);
  assert.doesNotMatch(plist, /<string>Background<\/string>/);
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
