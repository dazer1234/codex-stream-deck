import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  REASONING_ENCODER_KEYS, resolveAgentDispatch, retainEvaluationPromise, selectCodexMainTarget
} from "../src/codex-micro-renderer-bridge.js";
import * as microBridgeModule from "../src/codex-micro-renderer-bridge.js";
import { ADDITIONAL_KEYCAPS, OFFICIAL_KEYCAP_IDS } from "../src/keycaps.js";
import { visualStatusFromMicro } from "../src/status.js";
import type { MicroSnapshot } from "../src/types.js";

test("official Micro statuses map to the Stream Deck color states", () => {
  assert.equal(visualStatusFromMicro("off"), "empty");
  assert.equal(visualStatusFromMicro("working"), "thinking");
  assert.equal(visualStatusFromMicro("thinking"), "thinking");
  assert.equal(visualStatusFromMicro("unread"), "complete");
  assert.equal(visualStatusFromMicro("done"), "complete");
  assert.equal(visualStatusFromMicro("approval"), "input");
  assert.equal(visualStatusFromMicro("awaiting-approval"), "input");
  assert.equal(visualStatusFromMicro("awaiting-response"), "input");
  assert.equal(visualStatusFromMicro("error"), "error");
  assert.equal(visualStatusFromMicro("idle"), "idle");
});

test("official keycap SVG contents are not bundled in the public source", async () => {
  const controller = await readFile(new URL("../src/controller.ts", import.meta.url), "utf8");
  assert.match(controller, /codexDeckStateRoot\(\)[\s\S]*icons/);
  assert.doesNotMatch(controller, /static\/imgs\/official/);
});

test("renderer bridge uses native Micro events and discovers hashed modules at runtime", async () => {
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  for (const eventName of ["codex-micro-device-state-changed", "codex-micro-hid-event", "codex-micro-joystick-event"]) {
    assert.match(source, new RegExp(eventName));
  }
  assert.match(source, /link\[href\], script\[src\]/);
  assert.match(source, /performance\.getEntriesByType\('resource'\)/);
  assert.match(source, /createSubscriberAtom/);
  assert.match(source, /slots\.length === 6/);
  assert.match(source, /codex-micro-agent-source/);
  assert.match(source, /data-app-action-sidebar-thread-id/);
  assert.match(source, /activeThreadKey/);
  assert.match(source, /data-above-composer-conversation-id/);
  assert.match(source, /data-app-action-sidebar-thread-active/);
  assert.match(source, /directSettingReader/);
  assert.match(source, /get-setting/);
  assert.match(source, /found\.node\.store\.get\.bind\(found\.node\.store\)/);
  assert.doesNotMatch(source, /candidate\?\.token === appScope/);
  assert.doesNotMatch(source, /D90_rd6W|SFcKxWqG|DJFcGyy5/);
});

test("renderer snapshots choose the visible reasoning composer trigger", () => {
  const readActiveReasoningEffort = Reflect.get(microBridgeModule, "readActiveReasoningEffort") as unknown;
  assert.equal(typeof readActiveReasoningEffort, "function");
  const read = readActiveReasoningEffort as (
    elements: Array<{ getAttribute: (name: string) => string | null; visible: boolean }>,
    isVisible: (element: { visible: boolean }) => boolean
  ) => string | undefined;
  const elements = [
    { getAttribute: () => "low", visible: false },
    { getAttribute: () => " high ", visible: true }
  ];
  assert.equal(read(elements, (element) => element.visible), "high");
});

test("forced and normal bridge snapshots carry independent lexical refresh modes", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const expressions: string[] = [];
  const nativeSnapshot: MicroSnapshot = {
    ...snapshotFixture(),
    usage: {
      windows: [{
        id: "five-hour", kind: "five-hour", usedPercent: 25, remainingPercent: 75,
        windowDurationMins: 300, resetsAt: null
      }],
      observedAt: 10_000, resetCreditsAvailable: null, resetCreditsApplicable: null
    }
  };
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(expression: string) => Promise<T>;
    sessionOwnership: { annotate: (value: MicroSnapshot) => Promise<MicroSnapshot> };
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = async <T>(expression: string): Promise<T> => {
    expressions.push(expression);
    return structuredClone(nativeSnapshot) as T;
  };
  testBridge.sessionOwnership = { annotate: async (value) => value };

  await Promise.all([bridge.requestUsageRefresh(), bridge.refresh()]);

  assert.equal(expressions.length, 2, "forced refresh must not require a separate flag evaluation");
  assert.match(expressions[0]!, /const forceUsageRefresh = true/);
  assert.match(expressions[1]!, /const forceUsageRefresh = false/);
  assert.equal(expressions.some((expression) => expression.includes("codex-deck-force-rate-limit-refresh")), false);
});

test("forced usage query failures reject while normal background refresh remains best effort", async () => {
  const readUsageQueryData = Reflect.get(microBridgeModule, "readUsageQueryData") as unknown;
  assert.equal(typeof readUsageQueryData, "function");
  const read = readUsageQueryData as (
    query: { state: { data: unknown; dataUpdatedAt: number }; fetch: () => Promise<unknown> },
    forceUsageRefresh: boolean,
    now?: number,
    refreshState?: Record<symbol, unknown>
  ) => Promise<unknown>;
  const failure = new Error("usage fetch failed");
  const forced = { state: { data: "stale", dataUpdatedAt: 1 }, fetch: async () => { throw failure; } };
  await assert.rejects(read(forced, true, 20_000, {}), failure);

  const normal = { state: { data: "last-known", dataUpdatedAt: 1 }, fetch: async () => { throw failure; } };
  assert.equal(await read(normal, false, 20_000, {}), "last-known");
});

test("forced usage accepts only a normalized rate-limit window after fetch", async () => {
  const normalizeRendererUsage = Reflect.get(microBridgeModule, "normalizeRendererUsage") as unknown;
  assert.equal(typeof normalizeRendererUsage, "function");
  const normalize = normalizeRendererUsage as (
    data: unknown, dataUpdatedAt?: number, now?: number
  ) => MicroSnapshot["usage"];
  const readUsageQueryData = Reflect.get(microBridgeModule, "readUsageQueryData") as (
    query: { state: { data?: unknown; dataUpdatedAt: number }; fetch: () => Promise<unknown> },
    forceUsageRefresh: boolean,
    now?: number,
    refreshState?: Record<symbol, unknown>
  ) => Promise<unknown>;
  const invalidData = [
    undefined,
    { account: "present-without-rate-limit" },
    { rate_limit: { primary_window: { used_percent: "unknown", limit_window_seconds: 18_000 } } }
  ];

  for (const data of invalidData) {
    const query = { state: { data, dataUpdatedAt: 10_000 }, fetch: async () => undefined };
    const fetched = await readUsageQueryData(query, true, 20_000, {});
    assert.equal(normalize(fetched, query.state.dataUpdatedAt, 20_000), undefined);
  }

  const valid = normalize({
    rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 30_000 } }
  }, 10_000, 20_000);
  assert.equal(valid?.windows.length, 1);
  assert.equal(valid?.windows[0]?.kind, "five-hour");
  assert.equal(valid?.windows[0]?.remainingPercent, 75);
});

test("forced bridge snapshots reject absent or empty normalized usage", async () => {
  for (const nativeSnapshot of [
    snapshotFixture(),
    {
      ...snapshotFixture(),
      usage: {
        windows: [], observedAt: 10_000,
        resetCreditsAvailable: null, resetCreditsApplicable: null
      }
    },
    {
      ...snapshotFixture(),
      usage: {
        windows: [{
          id: "five-hour", kind: "five-hour", usedPercent: Number.NaN, remainingPercent: 75,
          windowDurationMins: 300, resetsAt: null
        }],
        observedAt: 10_000, resetCreditsAvailable: null, resetCreditsApplicable: null
      }
    }
  ]) {
    const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
    const testBridge = bridge as unknown as {
      ensureConnected: () => Promise<void>;
      evaluate: <T>(expression: string) => Promise<T>;
      sessionOwnership: { annotate: (value: MicroSnapshot) => Promise<MicroSnapshot> };
    };
    testBridge.ensureConnected = async () => {};
    testBridge.evaluate = async <T>(): Promise<T> => structuredClone(nativeSnapshot) as T;
    testBridge.sessionOwnership = { annotate: async (value) => value };

    await assert.rejects(bridge.requestUsageRefresh(), /valid rate-limit usage/);
  }
});

test("renderer bridge prefers the main index document over macOS avatar surfaces", () => {
  const target = selectCodexMainTarget([
    { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://route" },
    { type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge", webSocketDebuggerUrl: "ws://mascot" },
    { type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=activity-slot-0", webSocketDebuggerUrl: "ws://slot" },
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://main" }
  ]);

  assert.equal(target?.webSocketDebuggerUrl, "ws://main");
});

test("renderer bridge rejects auxiliary-only renderer lists", () => {
  const target = selectCodexMainTarget([
    { type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge", webSocketDebuggerUrl: "ws://mascot" }
  ]);

  assert.equal(target, undefined);
});

test("renderer evaluations retain their awaited promise until CDP has collected the result", () => {
  const expression = retainEvaluationPromise("(async () => true)()", 17);
  assert.match(expression, /__codexDeckPendingEvaluations/);
  assert.match(expression, /codex-deck-17/);
  assert.match(expression, /Promise\.resolve/);
  assert.match(expression, /setTimeout\(\(\) => store\.delete/);
  const namespaced = retainEvaluationPromise("Promise.resolve(true)", "bridge-a-1");
  assert.match(namespaced, /codex-deck-bridge-a-1/);
});

test("agent routing follows the stable thread identity when a cross-host slot is stale", () => {
  const snapshot = {
    slots: Array.from({ length: 6 }, (_, id) => ({
      id,
      threadKey: `local:00000000-0000-4000-8000-00000000000${id}`,
      title: `Task ${id}`,
      status: "idle",
      selected: false
    })),
    layout: {
      version: 1,
      slots: {
        ACT06: { keycapId: "FAST" }, ACT07: { keycapId: "APPR" },
        ACT08: { keycapId: "REJ" }, ACT09: { keycapId: "SPLIT" },
        ACT10_ACT11: { keycapId: "CODEX" }, ACT12: { keycapId: "CODEX" }
      },
      analogStick: { up: {}, right: {}, down: {}, left: {} }
    },
    agentSource: "priority",
    lightingAutoOff: "3-minutes",
    theme: "dark"
  } as MicroSnapshot;
  const movedThread = snapshot.slots[4]!.threadKey!;
  assert.deepEqual(resolveAgentDispatch(snapshot, 2, movedThread), {
    kind: "native", slot: 4, threadKey: movedThread
  });
  const offDeckThread = "local:10000000-0000-4000-8000-000000000099";
  assert.deepEqual(resolveAgentDispatch(snapshot, 2, offDeckThread), {
    kind: "direct", threadKey: offDeckThread
  });
});

test("reasoning controls use the official native encoder rotation events", async () => {
  assert.deepEqual(REASONING_ENCODER_KEYS, {
    decrease: "ENC_CW",
    increase: "ENC_CC"
  });
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  assert.match(source, /act: 2/);
  assert.match(source, /codex-micro-hid-event/);
});

test("manifest exposes both dedicated reasoning adjustment buttons", async () => {
  const manifest = JSON.parse(await readFile(new URL("../static/manifest.json", import.meta.url), "utf8")) as { Actions: Array<{ UUID: string }>; OS: Array<{ Platform: string }> };
  const actions = new Set(manifest.Actions.map((action) => action.UUID));
  assert.equal(actions.has("com.simeo.codex-deck.reasoning-down"), true);
  assert.equal(actions.has("com.simeo.codex-deck.reasoning-up"), true);
  assert.equal(actions.has("com.simeo.codex-deck.host-toggle"), true);
  assert.deepEqual(manifest.OS.map(({ Platform }) => Platform).sort(), ["mac", "windows"]);
});

test("all official keycaps are covered by standalone or native actions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../static/manifest.json", import.meta.url), "utf8")) as { Actions: Array<{ UUID: string }> };
  const actions = new Set(manifest.Actions.map((action) => action.UUID));
  for (const keycap of ADDITIONAL_KEYCAPS) {
    assert.equal(actions.has(`com.simeo.codex-deck.keycap-${keycap.slug}`), true, `missing ${keycap.id}`);
  }
  assert.equal(OFFICIAL_KEYCAP_IDS.length, 30);
  assert.equal(new Set(ADDITIONAL_KEYCAPS.map((keycap) => keycap.id)).size, 29);
  assert.equal(actions.has("com.simeo.codex-deck.dictation"), true, "MIC uses the native press/release action");
});

test("standalone keycaps resolve Codex's live registry instead of hardcoding commands", async () => {
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  assert.match(source, /codex-micro-layout-/);
  assert.match(source, /keycapGetter/);
  assert.match(source, /codex-micro-bridge-/);
  assert.match(source, /runnerLocal/);
  assert.match(source, /\\\\w/);
  assert.match(source, /import\\\\s/);
  assert.match(source, /codex_micro_hid/);
});

test("controller avoids overlapping polls and redundant image writes", async () => {
  const [source, targetSource] = await Promise.all([
    readFile(new URL("../src/controller.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/control-target.ts", import.meta.url), "utf8")
  ]);
  assert.match(source, /lastImages/);
  assert.match(source, /this\.lastImages\.get\(action\.id\) === image/);
  assert.match(source, /scheduleRefresh/);
  assert.match(source, /status === "thinking" \|\| status === "input"/);
  assert.match(source, /pressedAgents/);
  assert.match(source, /pressedControlTargets/);
  assert.match(source, /mobileSnapshotDirty/);
  assert.match(source, /runAndInvalidate/);
  assert.doesNotMatch(source, /const runAndRefresh/);
  assert.doesNotMatch(source, /if \(act === 1\) await this\.refresh\(\)/);
  assert.match(targetSource, /control-target\.json/);
  assert.match(source, /targetPlatform === "darwin"/);
  assert.doesNotMatch(source, /setInterval\(/);
});

test("assigned titleless threads use a new-chat label instead of Not assigned", async () => {
  const source = await readFile(new URL("../src/controller.ts", import.meta.url), "utf8");
  assert.match(source, /agent\?\.threadKey\s*&&\s*health\.state\s*===\s*"ready"\s*\?\s*"New chat"/);
  assert.match(source, /:\s*"Not assigned"/);
});

function snapshotFixture(): MicroSnapshot {
  return {
    slots: Array.from({ length: 6 }, (_, id) => ({
      id, threadKey: null, title: null, status: "idle", selected: false
    })),
    layout: {
      version: 1,
      slots: {
        ACT06: { keycapId: "FAST" }, ACT07: { keycapId: "APPR" }, ACT08: { keycapId: "REJ" },
        ACT09: { keycapId: "SPLIT" }, ACT10_ACT11: { keycapId: "CODEX" }, ACT12: { keycapId: "CODEX" }
      },
      analogStick: { up: {}, right: {}, down: {}, left: {} }
    },
    agentSource: "recent",
    lightingAutoOff: "3-minutes",
    theme: "dark"
  };
}
