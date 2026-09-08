import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodexMicroRendererBridge } from "../../src/codex-micro-renderer-bridge.js";
import { CodexRelayServer, validateRelayServerConfig, type RelayServerConfig } from "../../src/codex-relay-server.js";
import {
  configureLocalMobilePairing, LOCAL_MOBILE_CONFIG, LOCAL_PAIRING_QR
} from "../../src/mobile-local-pairing.js";
import { applyRuntimeOverride, verifyMicroRuntime } from "../runtime-override.js";
import {
  createWatcherPolicyState,
  evaluateWatcherPolicy,
  resumeWatcherPolicyState,
  type WatcherPolicyState
} from "./watcher-policy.js";

const CODEX_BUNDLE_ID = "com.openai.codex";
const AGENT_LABEL = "com.simeo.codex-deck.watcher";
const STATE_ROOT = join(homedir(), "Library", "Application Support", "CodexDeck");
const BRIDGE_STATE_PATH = join(STATE_ROOT, "codex-micro-bridge.json");
const HOST_STATE_PATH = join(STATE_ROOT, "host.json");
const WATCHER_STATE_PATH = join(STATE_ROOT, "watcher-state.json");
const WATCHER_LOG_PATH = join(STATE_ROOT, "watcher.log");
const WATCHER_STDERR_PATH = join(STATE_ROOT, "watcher.stderr.log");
const WATCHER_LOCK_PATH = join(STATE_ROOT, "watcher.lock");
const RELAY_SERVER_CONFIG_PATH = join(STATE_ROOT, "relay-server.json");
const MOBILE_LOCAL_CONFIG_PATH = join(STATE_ROOT, LOCAL_MOBILE_CONFIG);
const INSTALLED_RUNTIME_PATH = join(STATE_ROOT, "codex-deck-macos.mjs");
const WATCHER_LAUNCHER_PATH = join(STATE_ROOT, "watcher-launch.sh");
const LAUNCH_AGENT_PATH = join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
const POLL_MS = 1_000;
const LOG_LIMIT_BYTES = 1_000_000;

type CodexInstallation = {
  appPath: string;
  bundleId: string;
  version: string;
  buildVersion: string;
  executableName: string;
  executablePath: string;
};

type MainProcess = {
  pid: number;
  ppid: number;
  startedAt: string;
  command: string;
  generation: string;
  installation: CodexInstallation;
};

type HostState = { hostId: string; hostName: string };
type BridgeState = HostState & {
  port: number;
  updatedAt: string;
  platform: "darwin";
  codexVersion: string;
};

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || `${command} exited ${result.status}`).trim();
    throw new Error(detail);
  }
  return result.stdout.trim();
}

function plistValue(infoPath: string, key: string): string {
  return run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPath]);
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); }
  catch { return false; }
}

function parseProcessRows(output: string): Array<{ pid: number; ppid: number; startedAt: string; command: string }> {
  const rows: Array<{ pid: number; ppid: number; startedAt: string; command: string }> = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;
  for (const line of output.split("\n")) {
    const match = line.match(pattern);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3]!, command: match[4]! });
  }
  return rows;
}

function processRows(): ReturnType<typeof parseProcessRows> {
  return parseProcessRows(run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="]));
}

function appPathFromExecutable(command: string): string | null {
  const match = command.match(/^(.+?\.app)\/Contents\/MacOS\/[^/]+(?:\s|$)/);
  return match?.[1] ?? null;
}

async function installationFromApp(appPath: string): Promise<CodexInstallation | null> {
  const infoPath = join(appPath, "Contents", "Info.plist");
  try {
    const bundleId = plistValue(infoPath, "CFBundleIdentifier");
    if (bundleId !== CODEX_BUNDLE_ID) return null;
    const executableName = plistValue(infoPath, "CFBundleExecutable");
    const executablePath = join(appPath, "Contents", "MacOS", executableName);
    const executable = await stat(executablePath);
    if (!executable.isFile()) throw new Error(`Codex executable is not a file: ${executablePath}`);
    return {
      appPath,
      bundleId,
      version: plistValue(infoPath, "CFBundleShortVersionString"),
      buildVersion: plistValue(infoPath, "CFBundleVersion"),
      executableName,
      executablePath
    };
  } catch { return null; }
}

async function standardAppCandidates(): Promise<string[]> {
  const roots = ["/Applications", join(homedir(), "Applications")];
  const found: string[] = [];
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.endsWith(".app")) found.push(join(root, entry.name));
      }
    } catch { /* The optional app directory may not exist. */ }
  }
  return found;
}

export async function discoverCodexInstallation(): Promise<CodexInstallation> {
  if (platform() !== "darwin") throw new Error("The macOS launcher only runs on macOS.");
  const candidates: string[] = [];
  if (process.env.CODEX_DECK_APP_PATH) candidates.push(resolve(process.env.CODEX_DECK_APP_PATH));

  for (const row of processRows()) {
    if (row.ppid !== 1) continue;
    const appPath = appPathFromExecutable(row.command);
    if (appPath) candidates.push(appPath);
  }

  const spotlight = run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${CODEX_BUNDLE_ID}'`], { allowFailure: true });
  if (spotlight) candidates.push(...spotlight.split("\n").filter((path) => path.endsWith(".app")));
  candidates.push(...await standardAppCandidates());

  const installations: CodexInstallation[] = [];
  for (const candidate of [...new Set(candidates)]) {
    if (!await isDirectory(candidate)) continue;
    const installation = await installationFromApp(candidate);
    if (installation) installations.push(installation);
  }
  if (installations.length === 0) {
    throw new Error(`No installed Codex app with bundle identifier ${CODEX_BUNDLE_ID} was found.`);
  }

  const runningPaths = new Set(processRows().filter((row) => row.ppid === 1).map((row) => appPathFromExecutable(row.command)));
  installations.sort((left, right) => {
    const running = Number(runningPaths.has(right.appPath)) - Number(runningPaths.has(left.appPath));
    return running || right.version.localeCompare(left.version, undefined, { numeric: true });
  });
  return installations[0]!;
}

function findMainProcess(installation: CodexInstallation): MainProcess | null {
  const row = processRows().find((candidate) =>
    candidate.ppid === 1 &&
    (candidate.command === installation.executablePath || candidate.command.startsWith(`${installation.executablePath} `))
  );
  if (!row) return null;
  return {
    ...row,
    generation: `${row.pid}:${row.startedAt}:${installation.executablePath}`,
    installation
  };
}

export function parseDebugPort(command: string): number | null {
  const port = Number(command.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/)?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function hasLoopbackDebugAddress(command: string): boolean {
  return /(?:^|\s)--remote-debugging-address(?:=|\s+)127\.0\.0\.1(?:\s|$)/.test(command);
}

async function fetchJson<T>(url: string, timeout = 1_000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return await response.json() as T;
}

async function healthyDebugPort(main: MainProcess | null): Promise<number | null> {
  if (!main || !hasLoopbackDebugAddress(main.command)) return null;
  const port = parseDebugPort(main.command);
  if (!port) return null;
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`, 750);
    const targets = await fetchJson<Array<{ type?: string; url?: string }>>(`http://127.0.0.1:${port}/json/list`, 750);
    return targets.some((target) => target.type === "page" && target.url?.startsWith("app://")) ? port : null;
  } catch { return null; }
}

async function chooseLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return null; }
}

async function computerName(): Promise<string> {
  const name = run("/usr/sbin/scutil", ["--get", "ComputerName"], { allowFailure: true });
  return name || hostname();
}

async function hostState(): Promise<HostState> {
  const existing = await readJson<Partial<HostState>>(HOST_STATE_PATH);
  const hostId = typeof existing?.hostId === "string" && /^[0-9a-f-]{36}$/i.test(existing.hostId)
    ? existing.hostId
    : randomUUID();
  const value = { hostId, hostName: await computerName() };
  if (existing?.hostId !== value.hostId || existing.hostName !== value.hostName) await atomicWriteJson(HOST_STATE_PATH, value);
  return value;
}

async function writeBridgeState(port: number, installation: CodexInstallation): Promise<BridgeState> {
  const host = await hostState();
  const state: BridgeState = {
    port,
    updatedAt: new Date().toISOString(),
    platform: "darwin",
    ...host,
    codexVersion: installation.version
  };
  await atomicWriteJson(BRIDGE_STATE_PATH, state);
  return state;
}

export function isBridgeStateStale(statePort: unknown, activePort: number | null): boolean {
  const port = Number(statePort);
  return !Number.isInteger(port) || port < 1 || port > 65_535 || activePort == null || port !== activePort;
}

async function removeStaleBridgeState(activePort: number | null, log?: (message: string) => Promise<void>): Promise<boolean> {
  const removed = await removeStaleBridgeStateFile(BRIDGE_STATE_PATH, activePort);
  if (removed && log) await log("Removed stale bridge state.");
  return removed;
}

export async function removeStaleBridgeStateFile(path: string, activePort: number | null): Promise<boolean> {
  const state = await readJson<{ port?: unknown }>(path);
  if (!state) return false;
  if (!isBridgeStateStale(state.port, activePort)) return false;
  await rm(path, { force: true });
  return true;
}

export function buildCodexLaunchSpec(installation: Pick<CodexInstallation, "appPath">, port: number): { command: string; args: string[] } {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid debugging port: ${port}`);
  return {
    command: "/usr/bin/open",
    args: [
      "-n",
      "-a",
      installation.appPath,
      "--args",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`
    ]
  };
}

async function launchCodex(installation: CodexInstallation, port: number): Promise<void> {
  // Launch through LaunchServices so macOS associates TCC/Input Monitoring
  // state with the signed app bundle, while still passing Electron's CDP flags.
  const spec = buildCodexLaunchSpec(installation, port);
  const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function terminateCodex(main: MainProcess): Promise<void> {
  process.kill(main.pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { process.kill(main.pid, 0); }
    catch { return; }
    await delay(250);
  }
  throw new Error(`Codex main process ${main.pid} did not exit after SIGTERM; it was not force-killed.`);
}

const delay = (milliseconds: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function enableBridge(installation: CodexInstallation, port: number): Promise<{ override: unknown; verification: unknown }> {
  await writeBridgeState(port, installation);
  const override = await applyRuntimeOverride(port, 30_000);
  const verification = await verifyMicroRuntime(port, 30_000);
  await writeBridgeState(port, installation);
  return { override, verification };
}

async function rotateLog(): Promise<void> {
  try {
    if ((await stat(WATCHER_LOG_PATH)).size < LOG_LIMIT_BYTES) return;
  } catch { return; }
  await rm(`${WATCHER_LOG_PATH}.3`, { force: true });
  for (const [from, to] of [[`${WATCHER_LOG_PATH}.2`, `${WATCHER_LOG_PATH}.3`], [`${WATCHER_LOG_PATH}.1`, `${WATCHER_LOG_PATH}.2`], [WATCHER_LOG_PATH, `${WATCHER_LOG_PATH}.1`]] as const) {
    try { await rename(from, to); } catch { /* A rotation source may not exist. */ }
  }
}

async function log(message: string): Promise<void> {
  await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  await rotateLog();
  const file = await open(WATCHER_LOG_PATH, "a", 0o600);
  try { await file.write(`${new Date().toISOString()} [${process.pid}] ${message}\n`); }
  finally { await file.close(); }
}

function safeLog(message: string): void {
  void log(message).catch((error) => {
    console.error(`${new Date().toISOString()} [${process.pid}] Watcher logging failed: ${String(error)}`);
  });
}

export async function acquirePidLock(lockPath = WATCHER_LOCK_PATH): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch {
    const existing = Number((await readFile(join(lockPath, "pid"), "utf8").catch(() => "")).trim());
    if (Number.isInteger(existing)) {
      try { process.kill(existing, 0); return null; }
      catch { /* Reclaim a stale lock below. */ }
    }
    const stale = `${lockPath}.stale.${process.pid}.${Date.now()}`;
    try { await rename(lockPath, stale); }
    catch { return null; }
    await rm(stale, { recursive: true, force: true });
    try { await mkdir(lockPath, { mode: 0o700 }); }
    catch { return null; }
  }
  await writeFile(join(lockPath, "pid"), `${process.pid}\n`, { mode: 0o600 });
  return async () => { await rm(lockPath, { recursive: true, force: true }); };
}

async function runWatcher(): Promise<number> {
  const release = await acquirePidLock();
  if (!release) {
    await log("A watcher instance is already active; duplicate exiting safely.");
    return 0;
  }
  let released = false;
  let relayServer: CodexRelayServer | undefined;
  let mobileLocalRelayServer: CodexRelayServer | undefined;
  let relayControl: CodexMicroRendererBridge | undefined;
  let relaySignature = "";
  const cleanup = async () => {
    await relayServer?.close().catch(() => {});
    await mobileLocalRelayServer?.close().catch(() => {});
    relayControl?.close();
    if (!released) { released = true; await release(); }
  };
  process.once("SIGTERM", () => { safeLog("Watcher received SIGTERM."); void cleanup().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { safeLog("Watcher received SIGINT."); void cleanup().finally(() => process.exit(0)); });
  process.on("unhandledRejection", (reason) => { safeLog(`Unhandled watcher rejection: ${String(reason)}`); });

  await log("Watcher started.");
  let policy = resumeWatcherPolicyState(await readJson<WatcherPolicyState>(WATCHER_STATE_PATH));
  let enabledSignature = "";
  try {
    while (true) {
      try {
        const installation = await discoverCodexInstallation();
        const main = findMainProcess(installation);
        const port = await healthyDebugPort(main);
        const decision = evaluateWatcherPolicy(policy, {
          now: Date.now(), generation: main?.generation ?? null, bridgeHealthy: port != null
        });
        policy = decision.state;
        await atomicWriteJson(WATCHER_STATE_PATH, policy);

        const relayConfig = await readJson<RelayServerConfig>(RELAY_SERVER_CONFIG_PATH);
        const mobileLocalConfig = await readJson<RelayServerConfig>(MOBILE_LOCAL_CONFIG_PATH);
        const nextRelaySignature = JSON.stringify([
          relayConfig?.enabled ? relayConfig : null,
          mobileLocalConfig?.enabled ? mobileLocalConfig : null
        ]);
        if (nextRelaySignature !== relaySignature) {
          await relayServer?.close();
          await mobileLocalRelayServer?.close();
          relayControl?.close();
          relayServer = undefined;
          mobileLocalRelayServer = undefined;
          relayControl = undefined;
          relaySignature = "";
          if (relayConfig?.enabled || mobileLocalConfig?.enabled) {
            const identity = await hostState();
            relayControl = new CodexMicroRendererBridge(safeLog);
            if (relayConfig?.enabled) {
              relayServer = new CodexRelayServer(
                relayConfig,
                { ...identity, platform: "darwin", codexVersion: installation.version },
                relayControl, safeLog
              );
              await relayServer.start();
            }
            if (mobileLocalConfig?.enabled) {
              mobileLocalRelayServer = new CodexRelayServer(
                mobileLocalConfig,
                { ...identity, platform: "darwin", codexVersion: installation.version }, relayControl,
                (message) => safeLog(`Nearby mobile relay: ${message}`)
              );
              await mobileLocalRelayServer.start();
            }
          }
          relaySignature = nextRelaySignature;
        }
        const relayHost = {
          ...await hostState(), platform: "darwin" as const, codexVersion: installation.version
        };
        relayServer?.updateHost(relayHost);
        mobileLocalRelayServer?.updateHost(relayHost);

        if (port != null) {
          const signature = `${main!.generation}:${port}`;
          if (signature !== enabledSignature) {
            const result = await enableBridge(installation, port);
            enabledSignature = signature;
            await log(`Reused healthy loopback bridge on port ${port}: ${JSON.stringify(result.verification)}`);
          }
        } else {
          enabledSignature = "";
          await removeStaleBridgeState(null, log);
        }
      } catch (error) {
        await log(`Watcher iteration failed: ${String(error)}`);
      }
      await delay(POLL_MS);
    }
  } finally {
    await cleanup();
  }
}

export function buildWatcherLaunchScript(runtimePath = INSTALLED_RUNTIME_PATH): string {
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/zsh
set -u

runtime=${shellQuote(runtimePath)}
typeset -a candidates
candidates=(
  /opt/homebrew/bin/node
  /usr/local/bin/node
  /Applications/Codex.app/Contents/Resources/cua_node/bin/node
  /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
  "$HOME"/Applications/Codex.app/Contents/Resources/cua_node/bin/node
  "$HOME"/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
)
for node_candidate in "$HOME"/.nvm/versions/node/*/bin/node(N); do
  candidates+=("$node_candidate")
done

launch_with_node() {
  local node_candidate="$1"
  local node_version node_major
  [[ -x "$node_candidate" ]] || return 0
  node_version=$("$node_candidate" --version 2>/dev/null) || return 0
  node_major=\${\${node_version#v}%%.*}
  [[ "$node_major" == <-> && "$node_major" -ge 20 ]] || return 0
  exec "$node_candidate" "$runtime" watch
}

for node_candidate in "\${candidates[@]}"; do
  launch_with_node "$node_candidate"
done

spotlight_pid=""
spotlight_results=""
cleanup_spotlight() {
  trap - TERM INT HUP EXIT
  if [[ -n "$spotlight_pid" ]] && /bin/kill -0 "$spotlight_pid" 2>/dev/null; then
    /bin/kill -TERM "$spotlight_pid" 2>/dev/null
    /bin/sleep 0.1
    if /bin/kill -0 "$spotlight_pid" 2>/dev/null; then
      /bin/kill -KILL "$spotlight_pid" 2>/dev/null
    fi
  fi
  if [[ -n "$spotlight_pid" ]]; then
    wait "$spotlight_pid" 2>/dev/null
    spotlight_pid=""
  fi
  if [[ -n "$spotlight_results" ]]; then
    /bin/rm -f "$spotlight_results"
    spotlight_results=""
  fi
}
trap 'cleanup_spotlight; exit 143' TERM
trap 'cleanup_spotlight; exit 130' INT
trap 'cleanup_spotlight; exit 129' HUP
trap cleanup_spotlight EXIT

spotlight_results=$(/usr/bin/mktemp "\${TMPDIR:-/tmp}/codex-deck-mdfind.XXXXXX" 2>/dev/null) || spotlight_results=""
if [[ -n "$spotlight_results" ]]; then
  /usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.openai.codex"' > "$spotlight_results" 2>/dev/null &
  spotlight_pid=$!
  typeset -i spotlight_checks=0
  while /bin/kill -0 "$spotlight_pid" 2>/dev/null && (( spotlight_checks < 20 )); do
    /bin/sleep 0.1
    (( spotlight_checks += 1 ))
  done
  if /bin/kill -0 "$spotlight_pid" 2>/dev/null; then
    /bin/kill -TERM "$spotlight_pid" 2>/dev/null
    /bin/sleep 0.1
    if /bin/kill -0 "$spotlight_pid" 2>/dev/null; then
      /bin/kill -KILL "$spotlight_pid" 2>/dev/null
    fi
  fi
  wait "$spotlight_pid" 2>/dev/null
  spotlight_status=$?
  spotlight_pid=""
  typeset -a spotlight_candidates
  spotlight_candidates=()
  if [[ "$spotlight_status" -eq 0 ]]; then
    while IFS= read -r app_candidate; do
      [[ -n "$app_candidate" ]] || continue
      spotlight_candidates+=("$app_candidate/Contents/Resources/cua_node/bin/node")
    done < "$spotlight_results"
  fi
  /bin/rm -f "$spotlight_results"
  spotlight_results=""
  for node_candidate in "\${spotlight_candidates[@]}"; do
    launch_with_node "$node_candidate"
  done
fi
trap - TERM INT HUP EXIT

print -r -- "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) [launcher] Node.js 20 or newer was not found; watcher did not start." >> ${shellQuote(WATCHER_LOG_PATH)}
exit 78
`;
}

export function buildLaunchAgentPlist(watcherLauncherPath = WATCHER_LAUNCHER_PATH): string {
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${xml(watcherLauncherPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>${xml(WATCHER_STDERR_PATH)}</string>
</dict>
</plist>
`;
}

function builtRuntimeSource(): string {
  const current = resolve(process.argv[1]!);
  if (current.endsWith(".mjs")) return current;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "release", "codex-deck-launcher-macos", "codex-deck-macos.mjs");
}

function currentUserId(): number {
  if (typeof process.getuid !== "function") throw new Error("A POSIX user ID is required to manage the macOS LaunchAgent.");
  return process.getuid();
}

async function installLaunchAgent(): Promise<void> {
  const source = builtRuntimeSource();
  if (!await stat(source).then((value) => value.isFile()).catch(() => false)) {
    throw new Error("Build the macOS launcher first with `npm run build`.");
  }
  await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  await mkdir(dirname(LAUNCH_AGENT_PATH), { recursive: true });
  const temporaryRuntime = `${INSTALLED_RUNTIME_PATH}.${process.pid}.tmp`;
  await copyFile(source, temporaryRuntime);
  await chmod(temporaryRuntime, 0o700);
  await rename(temporaryRuntime, INSTALLED_RUNTIME_PATH);
  await atomicWrite(WATCHER_LAUNCHER_PATH, buildWatcherLaunchScript(), 0o700);
  await atomicWrite(LAUNCH_AGENT_PATH, buildLaunchAgentPlist(), 0o644);
  await hostState();
  run("/bin/launchctl", ["bootout", `gui/${currentUserId()}`, LAUNCH_AGENT_PATH], { allowFailure: true });
  run("/bin/launchctl", ["bootstrap", `gui/${currentUserId()}`, LAUNCH_AGENT_PATH]);
  console.log(`LaunchAgent installed: ${LAUNCH_AGENT_PATH}`);
  console.log("An already-running normal Codex session is recorded and left untouched.");
}

async function uninstallLaunchAgent(): Promise<void> {
  run("/bin/launchctl", ["bootout", `gui/${currentUserId()}`, LAUNCH_AGENT_PATH], { allowFailure: true });
  await rm(LAUNCH_AGENT_PATH, { force: true });
  for (const path of [
    INSTALLED_RUNTIME_PATH, WATCHER_LAUNCHER_PATH, BRIDGE_STATE_PATH, WATCHER_STATE_PATH,
    WATCHER_LOG_PATH, `${WATCHER_LOG_PATH}.1`, `${WATCHER_LOG_PATH}.2`, `${WATCHER_LOG_PATH}.3`,
    WATCHER_STDERR_PATH, MOBILE_LOCAL_CONFIG_PATH, join(STATE_ROOT, LOCAL_PAIRING_QR)
  ]) {
    await rm(path, { force: true });
  }
  await rm(WATCHER_LOCK_PATH, { recursive: true, force: true });
  console.log("Codex Deck LaunchAgent and Nearby credentials removed. host.json and the icons directory were preserved.");
}

async function dryRun(): Promise<void> {
  const installation = await discoverCodexInstallation();
  const main = findMainProcess(installation);
  const port = await healthyDebugPort(main);
  const staleState = await readJson<{ port?: unknown }>(BRIDGE_STATE_PATH);
  const relayConfig = await readJson<RelayServerConfig>(RELAY_SERVER_CONFIG_PATH);
  const mobileLocalConfig = await readJson<RelayServerConfig>(MOBILE_LOCAL_CONFIG_PATH);
  console.log(`Codex app: ${installation.appPath}`);
  console.log(`Bundle ID: ${installation.bundleId}`);
  console.log(`Version: ${installation.version} (${installation.buildVersion})`);
  console.log(`Executable: ${installation.executablePath}`);
  console.log(`Main process: ${main ? `${main.pid} (${main.generation})` : "not running"}`);
  console.log(`Reusable loopback bridge: ${port ?? "none"}`);
  console.log(`Bridge state file: ${staleState ? "present (not modified in dry-run)" : "absent"}`);
  console.log(`Multi-host relay: ${relayConfig?.enabled ? `configured for ${relayConfig.listenHost}:${relayConfig.port}` : "disabled"}`);
  console.log(`Nearby iPhone node: ${mobileLocalConfig?.enabled ? `configured on private LAN port ${mobileLocalConfig.port}` : "disabled"}`);
  if (main && !port) console.log("Action: a real restart would be required; dry-run left Codex untouched.");
  else if (!main) console.log("Action: start Codex with a random loopback port.");
  else console.log("Action: reuse the current bridge and apply the runtime override.");
}

async function configureRelay(listenHost: string | undefined, portValue: string | undefined): Promise<void> {
  const port = portValue == null ? 47_651 : Number.parseInt(portValue, 10);
  const config: RelayServerConfig = {
    enabled: true,
    listenHost: listenHost?.trim() ?? "",
    port,
    token: randomBytes(32).toString("base64url")
  };
  validateRelayServerConfig(config);
  await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  await atomicWriteJson(RELAY_SERVER_CONFIG_PATH, config);
  console.log(`Mac relay configured on ${config.listenHost}:${config.port}.`);
  console.log("Copy this file content to the Windows relay configurator; treat the token like a password:");
  console.log(JSON.stringify({ enabled: true, url: `ws://${config.listenHost}:${config.port}`, token: config.token }, null, 2));
  console.log("The running watcher detects this file automatically; Codex is not restarted.");
}

async function disableRelay(): Promise<void> {
  await rm(RELAY_SERVER_CONFIG_PATH, { force: true });
  console.log("Mac relay disabled. The watcher will close the listener without restarting Codex.");
}

async function configureMobileLocal(portValue: string | undefined, rotate: boolean): Promise<void> {
  const port = portValue == null ? 47_653 : Number.parseInt(portValue, 10);
  const result = await configureLocalMobilePairing({ stateRoot: STATE_ROOT, port, rotate });
  console.log(`Nearby iPhone node configured for ${result.hostName} on ${result.address}:${result.port}.`);
  console.log("Scan the opened QR code with the iPhone Camera. The watcher detects this without restarting Codex.");
  run("/usr/bin/open", [result.qrPath], { allowFailure: true });
}

async function disableMobileLocal(): Promise<void> {
  await rm(MOBILE_LOCAL_CONFIG_PATH, { force: true });
  await rm(join(STATE_ROOT, LOCAL_PAIRING_QR), { force: true });
  console.log("Nearby iPhone node disabled. The watcher will stop advertising it without restarting Codex.");
}

async function startOnce(allowRestart: boolean): Promise<number> {
  let installation = await discoverCodexInstallation();
  const main = findMainProcess(installation);
  let port = await healthyDebugPort(main);
  if (main && !port && !allowRestart) {
    console.error("Codex is already running without a reusable loopback bridge.");
    console.error("A restart requires explicit permission. Re-run with --restart only after saving unsent composer text.");
    return 2;
  }
  if (main && !port) {
    await terminateCodex(main);
    installation = await discoverCodexInstallation();
  }
  if (!port) {
    port = await chooseLoopbackPort();
    await launchCodex(installation, port);
  }
  const result = await enableBridge(installation, port);
  console.log(`Codex Deck ready on 127.0.0.1:${port}.`);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function selfTest(): Promise<void> {
  let state = createWatcherPolicyState(0);
  let result = evaluateWatcherPolicy(state, { now: 0, generation: "A", bridgeHealthy: false });
  assert.equal(result.action.type, "preserve-initial-session", "initial existing session remains untouched");
  state = result.state;
  result = evaluateWatcherPolicy(state, { now: 10_000, generation: "A", bridgeHealthy: false });
  assert.equal(result.action.type, "preserve-initial-session", "same initial process is never restarted");

  result = evaluateWatcherPolicy(state, { now: 10_001, generation: "B", bridgeHealthy: false });
  assert.equal(result.action.type, "wait", "a new process must remain stable before recovery");
  state = result.state;
  result = evaluateWatcherPolicy(state, { now: 30_001, generation: "B", bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" }, "a stable new process remains degraded without a restart");
  state = result.state;
  result = evaluateWatcherPolicy(state, { now: 61_000, generation: "C", bridgeHealthy: false });
  assert.equal(result.action.type, "wait", "a new generation also remains untouched");

  state = createWatcherPolicyState(0);
  result = evaluateWatcherPolicy(state, { now: 0, generation: null, bridgeHealthy: false });
  state = result.state;
  result = evaluateWatcherPolicy(state, { now: 8_000, generation: null, bridgeHealthy: false });
  assert.equal(result.action.type, "wait", "the watcher never launches Codex while it is closed");

  state = createWatcherPolicyState(0);
  result = evaluateWatcherPolicy(state, { now: 0, generation: "A", bridgeHealthy: true });
  state = result.state;
  result = evaluateWatcherPolicy(state, { now: 10_000, generation: "B", bridgeHealthy: false });
  assert.equal(result.action.type, "wait", "a replacement process must remain stable before recovery");
  state = result.state;
  result = evaluateWatcherPolicy(state, { now: 30_000, generation: "B", bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" }, "a previous healthy bridge never authorizes background restart");

  state = createWatcherPolicyState(0);
  result = evaluateWatcherPolicy(state, { now: 0, generation: null, bridgeHealthy: false });
  state = result.state;
  result = evaluateWatcherPolicy(state, { now: 2_000, generation: "RACE", bridgeHealthy: false });
  assert.equal(result.action.type, "preserve-initial-session", "LaunchAgent startup race preserves the first normal session");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-deck-self-test-"));
  const lockPath = join(temporaryRoot, "watcher.lock");
  const firstLock = await acquirePidLock(lockPath);
  assert.ok(firstLock, "the first watcher acquires its PID lock");
  assert.equal(await acquirePidLock(lockPath), null, "a duplicate watcher exits safely");
  await firstLock();
  const reclaimedLock = await acquirePidLock(lockPath);
  assert.ok(reclaimedLock, "the lock is available after clean shutdown");
  await reclaimedLock();

  const staleStatePath = join(temporaryRoot, "codex-micro-bridge.json");
  await writeFile(staleStatePath, `${JSON.stringify({ port: 70_000 })}\n`);
  assert.equal(await removeStaleBridgeStateFile(staleStatePath, null), true, "stale port state is removed");
  assert.equal(await stat(staleStatePath).then(() => true).catch(() => false), false, "stale state file no longer exists");
  await rm(temporaryRoot, { recursive: true, force: true });

  assert.equal(isBridgeStateStale(70_000, null), true, "stale/invalid port state is rejected");
  assert.equal(isBridgeStateStale(43123, 43123), false, "the active bridge state is retained");
  console.log("macOS self-test passed: non-destructive degradation, race, stale-state, and single-instance scenarios.");
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? "start";
  if (command === "--dry-run" || command === "dry-run") { await dryRun(); return 0; }
  if (command === "--self-test" || command === "self-test") { await selfTest(); return 0; }
  if (command === "--print-launch-agent" || command === "print-launch-agent") {
    process.stdout.write(buildLaunchAgentPlist()); return 0;
  }
  if (command === "install") { await installLaunchAgent(); return 0; }
  if (command === "uninstall") { await uninstallLaunchAgent(); return 0; }
  if (command === "relay-config") { await configureRelay(process.argv[3], process.argv[4]); return 0; }
  if (command === "relay-disable") { await disableRelay(); return 0; }
  if (command === "mobile-local-config") {
    await configureMobileLocal(process.argv.find((value, index) => index > 2 && /^\d+$/.test(value)), process.argv.includes("--rotate"));
    return 0;
  }
  if (command === "mobile-local-disable") { await disableMobileLocal(); return 0; }
  if (command === "watch") return await runWatcher();
  if (command === "start") return await startOnce(process.argv.includes("--restart"));
  if (command === "--restart") return await startOnce(true);
  throw new Error("Usage: start-codex-deck.sh [start [--restart]|dry-run|self-test|install|uninstall|watch|relay-config <127.0.0.1-or-tailscale-ip> [port]|relay-disable|mobile-local-config [port] [--rotate]|mobile-local-disable|print-launch-agent]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Codex Deck: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
