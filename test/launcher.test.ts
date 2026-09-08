import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { buildRuntimeOverrideExpression, buildRuntimeVerificationExpression, selectRuntimeTarget } from "../launcher/runtime-override.js";

const execFileAsync = promisify(execFile);

async function evaluateRuntimeExpression(
  expression: string,
  options: { statsig?: unknown; settingsLink?: boolean; inputHandlers?: boolean } = {}
): Promise<{ result: Record<string, unknown>; messages: unknown[] }> {
  const messages: unknown[] = [];
  const handlers = new Map<string, Set<unknown>>([
    ["codex-micro-device-state-changed", new Set([{}])],
    ["codex-micro-hid-event", new Set(options.inputHandlers === false ? [] : [{}])],
    ["codex-micro-joystick-event", new Set(options.inputHandlers === false ? [] : [{}])]
  ]);
  const bus = {
    handlers,
    dispatchHostMessage(message: unknown) { messages.push(message); }
  };
  const executable = expression
    .replaceAll("await import(persistedUrl)", "await globalThis.__codexDeckImport(persistedUrl)")
    .replaceAll("await import(url)", "await globalThis.__codexDeckImport(url)");
  const result = await runInNewContext(executable, {
    __STATSIG__: options.statsig,
    __codexDeckImport: async () => ({ bus }),
    document: {
      querySelector(selector: string) {
        return selector === '[href*="/settings/codex-micro"]' && options.settingsLink ? {} : null;
      },
      querySelectorAll(selector: string) {
        if (selector === "[href*=\"/settings/codex-micro\"]") return options.settingsLink ? [{}] : [];
        return [{ href: "app://-/assets/codex-micro-current.js", src: "" }];
      }
    },
    performance: { getEntriesByType: () => [] },
    setTimeout,
    URL,
    Map,
    Set
  }) as Record<string, unknown>;
  return { result, messages };
}

test("launcher discovers the persisted-signal module without a build hash", () => {
  const expression = buildRuntimeOverrideExpression();
  assert.match(expression, /\/assets\/persisted-signal-/);
  assert.doesNotMatch(expression, /persisted-signal-[A-Za-z0-9_-]+\.js/);
  assert.match(expression, /codex-micro-has-ever-been-detected/);
});

test("launcher rejects an unsafe feature-gate expression", () => {
  assert.throws(() => buildRuntimeOverrideExpression("1);alert(1)//"), /digits only/);
});

test("runtime override targets the main renderer instead of macOS avatar surfaces", () => {
  const target = selectRuntimeTarget([
    { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://route" },
    { type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge", webSocketDebuggerUrl: "ws://mascot" },
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://main" }
  ]);

  assert.equal(target?.webSocketDebuggerUrl, "ws://main");
});

test("startup monitoring survives Codex updates without duplicate watchers", async () => {
  const [watcher, launcher, build] = await Promise.all([
    readFile(new URL("../launcher/Watch-CodexDeck.ps1", import.meta.url), "utf8"),
    readFile(new URL("../launcher/Start-CodexDeck.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-launcher.mjs", import.meta.url), "utf8")
  ]);

  assert.match(watcher, /Local\\CodexDeckBridgeWatcher/);
  assert.match(watcher, /Get-AppxPackage -Name 'OpenAI\.Codex'/);
  assert.match(watcher, /Test-RecoveryAllowed/);
  assert.match(watcher, /rapid main-process replacement recovers/);
  assert.match(watcher, /current session was left untouched/i);
  assert.match(watcher, /Clear-StalePortFile/);
  assert.equal(watcher.match(/Invoke-CodexDeckLauncher -ForceRestart/g)?.length, 1);

  assert.match(launcher, /Watch-CodexDeck\.ps1/);
  assert.match(launcher, /-RecoverExistingSession/);
  assert.match(launcher, /Start-BridgeWatcher/);
  assert.match(launcher, /Get-InstalledLauncherRoot/);
  assert.match(launcher, /Install-WatcherBundle/);
  assert.match(launcher, /LocalAppData.*CodexDeck.*launcher/is);
  assert.match(build, /Watch-CodexDeck\.ps1/);
  assert.match(build, /Configure-CodexDeckRelay\.ps1/);
  assert.match(build, /Configure-CodexDeckMobile\.ps1/);
  assert.match(build, /replace\(\/\\r\\n\/g, "\\n"\)/);
  assert.match(build, /Cloud-sync conflict/);
  assert.match(build, /"package\.json", "browser\.js", "index\.js", "wrapper\.mjs"/);
  assert.doesNotMatch(build, /cp\(resolve\("node_modules\/ws"\).*recursive: true/s);
});

test("watcher recovery decision self-test passes in PowerShell", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows PowerShell watcher self-test runs on Windows");
    return;
  }

  const watcherPath = fileURLToPath(new URL("../launcher/Watch-CodexDeck.ps1", import.meta.url));
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", watcherPath, "-SelfTest"
  ]);
  assert.match(stdout, /self-test passed \(9 cases\)/i);
});

test("launcher supports the current shared-chunk native detection path", () => {
  const expression = buildRuntimeOverrideExpression();
  assert.match(expression, /native-device-event/);
  assert.match(expression, /codex-micro-device-state-changed/);
  assert.match(expression, /dispatchHostMessage/);
  assert.match(expression, /deviceEventDispatched/);
  assert.match(expression, /3207467860/);
});

test("runtime activation uses native Micro handlers when legacy Statsig is unavailable", async () => {
  const activation = await evaluateRuntimeExpression(buildRuntimeOverrideExpression());
  assert.equal(activation.result.ready, true);
  assert.equal(activation.result.clients, 0);
  assert.equal(activation.result.deviceEventDispatched, true);
  assert.equal(activation.messages.length, 1);

  const verification = await evaluateRuntimeExpression(buildRuntimeVerificationExpression());
  assert.equal(verification.result.ready, true);
  assert.equal(verification.result.nativeEventBus, true);
  assert.equal(verification.result.hidHandlers, 1);
  assert.equal(verification.result.joystickHandlers, 1);
});

test("runtime activation retains the legacy Statsig gate path", async () => {
  const client = {
    overrideAdapter: { getGateOverride: (gate: { name: string; value: boolean }) => gate },
    _memoCache: { stale: true },
    checkGate(name: string) {
      return Boolean(this.overrideAdapter.getGateOverride({ name, value: false }).value);
    },
    $emt() {}
  };
  const activation = await evaluateRuntimeExpression(buildRuntimeOverrideExpression(), {
    statsig: { firstInstance: client, instances: {} }
  });
  assert.equal(activation.result.ready, true);
  assert.equal((activation.result.enabled as unknown[]).length, 1);
  assert.equal((activation.result.enabled as unknown[])[0], true);
  assert.equal(Object.keys(client._memoCache).length, 0);
});

test("runtime verification fails closed without native input handlers", async () => {
  const verification = await evaluateRuntimeExpression(buildRuntimeVerificationExpression(), {
    inputHandlers: false
  });
  assert.equal(verification.result.ready, false);
  assert.equal(verification.result.hidHandlers, 0);
  assert.equal(verification.result.joystickHandlers, 0);
});

test("launcher verifies the settings gate and native Micro handlers", () => {
  const expression = buildRuntimeVerificationExpression();
  assert.match(expression, /settings\/codex-micro/);
  assert.match(expression, /codex-micro-hid-event/);
  assert.match(expression, /codex-micro-joystick-event/);
  assert.match(expression, /nativeEventBus/);
});
