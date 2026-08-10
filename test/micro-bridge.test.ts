import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveAgentDispatch, retainEvaluationPromise, selectCodexMainTarget
} from "../src/codex-micro-renderer-bridge.js";
import * as microBridgeModule from "../src/codex-micro-renderer-bridge.js";
import { ADDITIONAL_KEYCAPS, OFFICIAL_KEYCAP_IDS } from "../src/keycaps.js";
import { visualStatusFromMicro } from "../src/status.js";
import type { MicroSnapshot } from "../src/types.js";

let guardedRendererHarnessId = 0;

function createGuardedRendererHarness(options: {
  currentEffort?: string;
  visibleTriggerCount?: number;
  modelId?: string;
  supportedEfforts?: string[];
}): {
  evaluate: <T>(expression: string) => Promise<T>;
  runnerCalls: Array<[string, string]>;
} {
  const runnerCalls: Array<[string, string]> = [];
  const globalKey = `__codexDeckGuardedRunnerCalls${++guardedRendererHarnessId}`;
  const runtime = globalThis as unknown as Record<string, unknown>;
  runtime[globalKey] = runnerCalls;
  const runnerSource = [
    "export function guarded(command, source) {",
    `  globalThis[${JSON.stringify(globalKey)}].push([command, source]);`,
    "  return true;",
    "}"
  ].join("\n");
  const runnerUrl = `data:text/javascript,${encodeURIComponent(runnerSource)}`;
  const bridgeUrl = `https://codex.example/assets/codex-micro-bridge-guard-${guardedRendererHarnessId}.js`;
  const bridgeSource = [
    `import{guarded as he}from${JSON.stringify(runnerUrl)};`,
    "enabled&&he('composer.increaseReasoningEffort','codex_micro_hid');"
  ].join("");
  const modelId = options.modelId ?? "gpt-5.6-sol";
  const supportedEfforts = options.supportedEfforts ?? ["low", "medium", "high", "xhigh", "max", "ultra"];
  const queryClient = {
    getQueryCache: () => ({
      getAll: () => [{
        queryKey: ["models", "list", "local", "chatgpt", 100],
        state: { data: { data: [{
          model: modelId,
          supportedReasoningEfforts: supportedEfforts.map((reasoningEffort) => ({ reasoningEffort }))
        }] } }
      }]
    }),
    getQueryData: () => undefined
  };
  const root = {
    "__reactContainer$test": { memoizedProps: { value: queryClient }, child: null, sibling: null }
  };
  const trigger = () => ({
    isConnected: true,
    getClientRects: () => ({ length: 1 }),
    getAttribute: (name: string) => ({
      "data-codex-intelligence-trigger": "true",
      "data-composer-navigation-target": "reasoning",
      "data-selected-reasoning-effort": options.currentEffort ?? null
    })[name] ?? null,
    "__reactProps$test": { selectedValue: { props: { model: modelId } } }
  });
  const triggers = Array.from({ length: options.visibleTriggerCount ?? 1 }, trigger);
  const document = {
    getElementById: (id: string) => id === "root" ? root : null,
    querySelectorAll: (selector: string) => selector === "link[href], script[src]"
      ? [{ href: bridgeUrl, src: "" }]
      : selector === '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]'
        ? triggers
        : []
  };
  const performance = { getEntriesByType: () => [] };
  const fetch = async (url: string) => {
    assert.equal(url, bridgeUrl);
    return { text: async () => bridgeSource };
  };
  const getComputedStyle = () => ({ display: "block", visibility: "visible" });

  return {
    runnerCalls,
    evaluate: async <T>(expression: string): Promise<T> => {
      try {
        const run = new Function(
          "document", "performance", "fetch", "getComputedStyle",
          `return (${expression});`
        ) as (document: unknown, performance: unknown, fetch: unknown, getComputedStyle: unknown) => Promise<T>;
        return await run(document, performance, fetch, getComputedStyle);
      } finally {
        delete runtime[globalKey];
      }
    }
  };
}

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

test("renderer snapshots require one unique visible semantic reasoning target", () => {
  const readActiveReasoningEffort = Reflect.get(microBridgeModule, "readActiveReasoningEffort") as unknown;
  assert.equal(typeof readActiveReasoningEffort, "function");
  const read = readActiveReasoningEffort as (
    elements: Array<{ getAttribute: (name: string) => string | null; visible: boolean }>,
    isVisible: (element: { visible: boolean }) => boolean
  ) => string | undefined;
  const elements = [
    { getAttribute: (name: string) => name === "data-selected-reasoning-effort" ? "low" : "reasoning", visible: false },
    { getAttribute: (name: string) => name === "data-selected-reasoning-effort" ? "generic" : "other", visible: true },
    { getAttribute: (name: string) => name === "data-selected-reasoning-effort" ? " high " : "reasoning", visible: true },
    { getAttribute: (name: string) => name === "data-selected-reasoning-effort" ? "high" : "reasoning", visible: true }
  ];
  assert.equal(read(elements, (element) => element.visible), "high");
  assert.equal(read([
    ...elements,
    { getAttribute: (name: string) => name === "data-selected-reasoning-effort" ? "low" : "reasoning", visible: true }
  ], (element) => element.visible), undefined, "conflicting visible reasoning targets are unavailable");
});

test("renderer snapshots expose Fast mode only from agreeing visible reasoning triggers", () => {
  const readActiveFastMode = Reflect.get(microBridgeModule, "readActiveFastMode") as unknown;
  assert.equal(typeof readActiveFastMode, "function");
  const read = readActiveFastMode as (
    elements: Array<{ getAttribute: (name: string) => string | null; visible: boolean; fast: boolean }>,
    isVisible: (element: { visible: boolean }) => boolean,
    hasFastIndicator: (element: { fast: boolean }) => boolean
  ) => boolean | undefined;
  const trigger = (visible: boolean, fast: boolean, target = "reasoning") => ({
    getAttribute: (name: string) => name === "data-composer-navigation-target" ? target : null,
    visible,
    fast
  });
  const visible = (element: { visible: boolean }) => element.visible;
  const hasFastIndicator = (element: { fast: boolean }) => element.fast;

  assert.equal(read([trigger(true, true)], visible, hasFastIndicator), true, "Fast icon means enabled");
  assert.equal(read([trigger(true, false)], visible, hasFastIndicator), false, "no Fast icon means disabled");
  assert.equal(read([trigger(false, true)], visible, hasFastIndicator), undefined, "hidden triggers are ignored");
  assert.equal(read([trigger(true, true, "model")], visible, hasFastIndicator), undefined, "only reasoning triggers count");
  assert.equal(read([trigger(true, true), trigger(true, false)], visible, hasFastIndicator), undefined,
    "conflicting visible reasoning triggers are unavailable");
});

test("renderer snapshot expression reads only authoritative reasoning triggers", async () => {
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  const triggerSelector = '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]';
  const escapedTriggerSelector = triggerSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(source, new RegExp(`readActiveReasoningEffort\\(document\\.querySelectorAll\\(\\s*'${escapedTriggerSelector}'`));
  assert.match(source, new RegExp(`readActiveFastMode\\(document\\.querySelectorAll\\(\\s*'${escapedTriggerSelector}'`));
  assert.match(source, /svg\[class\*="ModelPickerTriggerInlineFastIcon"\]/);
});

test("serialized Fast state helpers resolve their production dependencies in the renderer scope", async () => {
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  for (const helper of [
    "isVisibleReasoningTrigger", "readActiveReasoningEffort", "hasFastModeIndicator", "readActiveFastMode"
  ]) assert.ok(source.includes(`const ${helper} = (\${${helper}.toString()});`), `${helper} is serialized`);

  const isVisibleReasoningTrigger = Reflect.get(microBridgeModule, "isVisibleReasoningTrigger") as Function;
  const readActiveReasoningEffort = Reflect.get(microBridgeModule, "readActiveReasoningEffort") as Function;
  const hasFastModeIndicator = Reflect.get(microBridgeModule, "hasFastModeIndicator") as Function;
  const readActiveFastMode = Reflect.get(microBridgeModule, "readActiveFastMode") as Function;
  const evaluate = new Function("document", "getComputedStyle", `
    const isVisibleReasoningTrigger = (${isVisibleReasoningTrigger.toString()});
    const readActiveReasoningEffort = (${readActiveReasoningEffort.toString()});
    const hasFastModeIndicator = (${hasFastModeIndicator.toString()});
    const readActiveFastMode = (${readActiveFastMode.toString()});
    return readActiveFastMode(document.querySelectorAll(
      '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]'
    ));
  `) as (
    document: { querySelectorAll: (selector: string) => Iterable<unknown> },
    getComputedStyle: (element: unknown) => { display: string; visibility: string }
  ) => boolean | undefined;
  const trigger = (fast: boolean, visible = true, verified = true) => ({
    isConnected: true,
    getClientRects: () => ({ length: visible ? 1 : 0 }),
    getAttribute: (name: string) => name === "data-composer-navigation-target" ? "reasoning" : null,
    querySelector: (selector: string) => {
      assert.equal(selector, 'svg[class*="ModelPickerTriggerInlineFastIcon"]');
      return fast ? {} : null;
    },
    verified
  });
  const run = (triggers: ReturnType<typeof trigger>[]): boolean | undefined => evaluate({
    querySelectorAll: (selector) => {
      assert.equal(selector, '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]');
      return triggers.filter((candidate) => candidate.verified);
    }
  }, () => ({ display: "block", visibility: "visible" }));

  assert.equal(run([trigger(true)]), true);
  assert.equal(run([trigger(false)]), false);
  assert.equal(run([trigger(true, false)]), undefined, "hidden trigger is omitted");
  assert.equal(run([trigger(true, true, false)]), undefined, "no verified trigger is omitted");
});

test("reasoning adjustment decisions block only a restricted next Ultra step", () => {
  const candidate = Reflect.get(microBridgeModule, "decideReasoningAdjustment") as unknown;
  assert.equal(typeof candidate, "function");
  const decide = candidate as (
    direction: "increase" | "decrease",
    policy: { includeUltra: boolean },
    currentEffort?: string,
    supportedEfforts?: unknown
  ) => "applied" | "blocked-ultra" | "unavailable";
  const fullOrder = ["low", "medium", "high", "xhigh", "max", "ultra"];

  assert.equal(decide("increase", { includeUltra: false }, "max", fullOrder), "blocked-ultra");
  assert.equal(decide("increase", { includeUltra: false }, "xhigh", fullOrder), "applied");
  assert.equal(decide("increase", { includeUltra: true }, "max", undefined), "applied");
  assert.equal(decide("decrease", { includeUltra: false }, "ultra", undefined), "applied");
  assert.equal(decide("increase", { includeUltra: false }, undefined, fullOrder), "unavailable");
  assert.equal(decide("increase", { includeUltra: false }, "max", undefined), "unavailable");
  assert.equal(decide("increase", { includeUltra: false }, "high", ["low", "high", "ultra"]), "blocked-ultra");
  assert.equal(decide("increase", { includeUltra: false }, "high", ["low", "medium", "high", "xhigh"]), "applied");
});

test("active reasoning metadata uses the one visible composer and its current selectedValue model", () => {
  const candidate = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as unknown;
  assert.equal(typeof candidate, "function");
  const read = candidate as (
    elements: Iterable<Record<string, unknown>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, unknown>) => boolean
  ) => { currentEffort: string; modelId: string; supportedEfforts: string[] } | undefined;
  const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const modelsQuery = {
    queryKey: ["models", "list", "local", "chatgpt", 100],
    state: { data: { data: [{
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort }))
    }] } }
  };
  const queryClient = {
    getQueryCache: () => ({ getAll: () => [modelsQuery] }),
    getQueryData: () => undefined
  };
  const reactRootFiber = {
    dependencies: { firstContext: { memoizedValue: queryClient, next: null } },
    child: null,
    sibling: null
  };
  const trigger = {
    visible: true,
    getAttribute: (name: string) => ({
      "data-codex-intelligence-trigger": "true",
      "data-composer-navigation-target": "reasoning",
      "data-selected-reasoning-effort": " max "
    })[name] ?? null,
    "__reactProps$live": {
      children: [
        {
          props: {
            className: "measurement",
            selectedValue: { props: { model: "gpt-5.3-codex-spark" } }
          }
        },
        { props: { "aria-hidden": "true", selectedValue: { props: { model: "stale-hidden-model" } } } },
        { props: { selectedValue: { nested: { props: { model: "gpt-5.6-sol" } } } } }
      ]
    }
  };

  assert.deepEqual(read([trigger], reactRootFiber, (element) => element.visible === true), {
    currentEffort: "max",
    modelId: "gpt-5.6-sol",
    supportedEfforts: efforts
  });
  assert.equal(read([
    trigger,
    { ...trigger, "__reactProps$live": { selectedValue: { props: { model: "gpt-5.6-sol" } } } }
  ], reactRootFiber, (element) => element.visible === true), undefined, "multiple visible semantic triggers are ambiguous");
  assert.deepEqual(read([
    { ...trigger, visible: false }, trigger
  ], reactRootFiber, (element) => element.visible === true)?.supportedEfforts, efforts, "hidden triggers are ignored");
});

test("active reasoning metadata fails closed on missing, malformed, duplicate, or ambiguous model data", () => {
  const read = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as (
    elements: Iterable<Record<string, unknown>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, unknown>) => boolean
  ) => { currentEffort: string; modelId: string; supportedEfforts: string[] } | undefined;
  assert.equal(typeof read, "function");
  const makeTrigger = (props: unknown = { selectedValue: { props: { model: "gpt-5.6-sol" } } }) => ({
    visible: true,
    getAttribute: (name: string) => ({
      "data-codex-intelligence-trigger": "true",
      "data-composer-navigation-target": "reasoning",
      "data-selected-reasoning-effort": "high"
    })[name] ?? null,
    "__reactProps$test": props
  });
  const makeRoot = (models: unknown[], extraQueries: unknown[] = []) => {
    const query = {
      queryKey: ["models", "list", "local", "chatgpt", 100],
      state: { data: { data: models } }
    };
    const queryClient = {
      getQueryCache: () => ({ getAll: () => [query, ...extraQueries] }),
      getQueryData: () => undefined
    };
    return { memoizedProps: { value: queryClient }, child: null, sibling: null };
  };
  const model = (efforts: unknown[], id = "gpt-5.6-sol") => ({
    model: id,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort }))
  });
  const visible = (element: Record<string, unknown>) => element.visible === true;

  const overDepthProps: Record<string, any> = {
    selectedValue: { props: { model: "gpt-5.6-sol" } }
  };
  let overDepthBranch = overDepthProps;
  for (let depth = 0; depth < 33; depth++) {
    overDepthBranch.nested = {};
    overDepthBranch = overDepthBranch.nested;
  }
  overDepthBranch.selectedValue = { props: { model: "conflicting-model" } };
  assert.equal(read([makeTrigger(overDepthProps)], makeRoot([model(["low", "high", "ultra"])]), visible), undefined,
    "exhausting selectedValue depth cannot accept a partial shallow model");

  assert.equal(read([makeTrigger({ selectedValue: { model: "gpt-5.6-sol" } })],
    makeRoot([model(["low", "high", "ultra"])]), visible), undefined, "the model ID must come from props.model");
  assert.equal(read([makeTrigger({ selectedValue: { label: "missing model" } })],
    makeRoot([model(["low", "high", "ultra"])]), visible), undefined, "selectedValue must contain a model ID");
  assert.equal(read([makeTrigger({
    selectedValue: {
      first: { props: { model: "gpt-5.6-sol" } },
      second: { props: { model: "other-model" } }
    }
  })], makeRoot([model(["low", "high", "ultra"])]), visible), undefined, "disagreeing selectedValue models are ambiguous");
  assert.equal(read([makeTrigger()], makeRoot([model(["low", "bad effort", "ultra"])]), visible), undefined,
    "malformed effort identifiers are unavailable");
  assert.equal(read([makeTrigger()], makeRoot([model(["low", "high", "high", "ultra"])]), visible), undefined,
    "duplicate effort identifiers are unavailable");
  assert.equal(read([makeTrigger()], makeRoot([{
    model: "gpt-5.6-sol",
    supportedReasoningEfforts: ["low", "high", "ultra"]
  }]), visible), undefined, "live effort metadata requires reasoningEffort records");
  assert.equal(read([makeTrigger()], makeRoot([model(["low", "high", "ultra"], "other-model")]), visible), undefined,
    "the model list must exactly match the active model");
  assert.equal(read([makeTrigger()], makeRoot([
    model(["low", "high", "ultra"]), model(["low", "medium", "high"], "gpt-5.6-sol")
  ]), visible), undefined, "duplicate active model records are ambiguous");
  const duplicateQuery = {
    queryKey: ["models", "list", "remote", "chatgpt", 100],
    state: { data: { data: [model(["low", "high", "ultra"])] } }
  };
  assert.equal(read([makeTrigger()], makeRoot([model(["low", "high", "ultra"])], [duplicateQuery]), visible), undefined,
    "multiple current models/list queries are ambiguous");

  const truncatedRoot = makeRoot([model(["low", "high", "ultra"])]) as Record<string, any>;
  let fiber = truncatedRoot;
  for (let index = 0; index < 30000; index++) {
    fiber.child = {};
    fiber = fiber.child;
  }
  assert.equal(read([makeTrigger()], truncatedRoot, visible), undefined,
    "exhausting the bounded fiber traversal cannot return partial query metadata");
});

test("rate-limit reset applicability requires an explicit positive safe integer", async () => {
  const predicate = Reflect.get(microBridgeModule, "hasApplicableResetCredit") as unknown;
  assert.equal(typeof predicate, "function");
  const isApplicable = predicate as (value: unknown) => boolean;
  for (const value of [undefined, null, 0, -1, 1.5, Number.NaN, Infinity, "1", false, [], {}]) {
    assert.equal(isApplicable(value), false, String(value));
  }
  assert.equal(isApplicable(1), true);

  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  let expression = "";
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = async <T>(source: string): Promise<T> => {
    expression = source;
    return true as T;
  };
  await bridge.consumeRateLimitReset();
  assert.match(expression, /hasApplicableResetCredit/);
  assert.match(expression, /if \(!hasApplicableResetCredit\(summary\?\.rate_limit_reset_credits\?\.applicable_available_count\)\)/);
  assert.doesNotMatch(expression, /Number\(summary\?\.rate_limit_reset_credits/);
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

test("usage normalization rejects coercible and out-of-domain numeric scalars", () => {
  const normalize = Reflect.get(microBridgeModule, "normalizeRendererUsage") as (
    data: unknown, dataUpdatedAt?: number, now?: number
  ) => MicroSnapshot["usage"];
  const malformedPercentages: unknown[] = [null, "", "   ", "25", false, true, [], {}, -1, 101];
  for (const usedPercent of malformedPercentages) {
    assert.equal(normalize({
      rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000 } }
    }, 10_000, 20_000), undefined, `used_percent=${String(usedPercent)} must not be coerced`);
  }

  const malformedCredits: unknown[] = [null, "", "   ", "2", false, true, [], {}, -1, 1.5, Infinity];
  for (const credit of malformedCredits) {
    const rate_limit = { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } };
    assert.equal(normalize({
      rate_limit,
      rate_limit_reset_credits: { available_count: credit, applicable_available_count: 1 }
    }, 10_000, 20_000), undefined, `available_count=${String(credit)} must not be coerced`);
    assert.equal(normalize({
      rate_limit,
      rate_limit_reset_credits: { available_count: 1, applicable_available_count: credit }
    }, 10_000, 20_000), undefined, `applicable_available_count=${String(credit)} must not be coerced`);
  }

  const valid = normalize({
    rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18_000 } },
    rate_limit_reset_credits: { available_count: 0, applicable_available_count: 2 }
  }, 10_000, 20_000);
  assert.equal(valid?.windows[0]?.usedPercent, 0);
  assert.equal(valid?.resetCreditsAvailable, 0);
  assert.equal(valid?.resetCreditsApplicable, 2);
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

test("unrestricted increases and every decrease invoke one dedicated command", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const reasoningCommands: string[] = [];
  const genericKeycaps: string[] = [];
  const dispatches: unknown[][] = [];
  const testBridge = bridge as unknown as {
    runReasoningCommand: (command: string) => Promise<void>;
    runKeycap: (keycapId: "MIND+" | "MIND-") => Promise<void>;
    dispatch: (...args: unknown[]) => Promise<void>;
  };
  testBridge.runReasoningCommand = async (command) => { reasoningCommands.push(command); };
  testBridge.runKeycap = async (keycapId) => { genericKeycaps.push(keycapId); };
  testBridge.dispatch = async (...args) => { dispatches.push(args); };

  assert.equal(await bridge.adjustReasoning("increase"), "applied");
  assert.equal(await bridge.adjustReasoning("decrease", { includeUltra: false }), "applied");
  assert.equal(await bridge.adjustReasoning("increase", { includeUltra: true }), "applied");

  assert.deepEqual(reasoningCommands, [
    "composer.increaseReasoningEffort",
    "composer.decreaseReasoningEffort",
    "composer.increaseReasoningEffort"
  ]);
  assert.deepEqual(genericKeycaps, []);
  assert.deepEqual(dispatches, []);
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  const adjustment = source.match(/async adjustReasoning\([\s\S]*?\n  }/)?.[0] ?? "";
  assert.doesNotMatch(adjustment, /ENC_CW|ENC_CC|this\.dispatch/);
});

test("restricted increases use one atomic renderer evaluation and lazily skip the command when blocked", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const expressions: string[] = [];
  const directCommands: string[] = [];
  const results = ["blocked-ultra", "applied"] as const;
  let resultIndex = 0;
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
    runReasoningCommand: (command: string) => Promise<void>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = async <T>(source: string): Promise<T> => {
    expressions.push(source);
    return results[resultIndex++] as T;
  };
  testBridge.runReasoningCommand = async (command) => { directCommands.push(command); };

  assert.equal(await bridge.adjustReasoning("increase", { includeUltra: false }), "blocked-ultra");
  assert.deepEqual(directCommands, [], "blocked guarded increases do not enter the separate command path");
  assert.equal(expressions.length, 1, "guard state and command path share one Runtime.evaluate");
  assert.equal(await bridge.adjustReasoning("increase", { includeUltra: false }), "applied");
  assert.deepEqual(directCommands, [], "lower guarded increases run inside the atomic renderer evaluation");
  assert.equal(expressions.length, 2);

  for (const expression of expressions) {
    assert.match(expression,
      /\[data-codex-intelligence-trigger="true"\]\[data-composer-navigation-target="reasoning"\]/);
    assert.match(expression, /data-selected-reasoning-effort/);
    assert.match(expression, /__reactProps\$/);
    assert.match(expression, /seen\.size\s*<\s*(?:30000|3e4)/);
    assert.match(expression, /queryKey\[0\]\s*===\s*["']models["']/);
    assert.match(expression, /queryKey\[1\]\s*===\s*["']list["']/);
    assert.equal((expression.match(/commandRunner\(command, 'codex_micro_hid'\)/g) ?? []).length, 1,
      "the applicable renderer branch issues exactly one reasoning command");
    const blockedReturn = expression.indexOf("if (decision === 'blocked-ultra') return 'blocked-ultra'");
    const runnerResolution = expression.indexOf("const commandRunner = await resolveCommandRunner");
    assert.ok(blockedReturn >= 0 && runnerResolution > blockedReturn,
      "the blocked result returns before resolving or importing a command runner");
    assert.doesNotMatch(expression,
      /enabled-reasoning-efforts|show-ultra-in-model-picker-slider|model_picker_persists_ultra_effort|dialog|confirm\(|dismiss/i);
  }
});

test("restricted increases fail closed without renderer metadata and issue no separate command", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const expressions: string[] = [];
  const directCommands: string[] = [];
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
    runReasoningCommand: (command: string) => Promise<void>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = async <T>(source: string): Promise<T> => {
    expressions.push(source);
    throw new Error("Codex reasoning metadata is unavailable.");
  };
  testBridge.runReasoningCommand = async (command) => { directCommands.push(command); };

  await assert.rejects(
    bridge.adjustReasoning("increase", { includeUltra: false }),
    /Codex reasoning metadata is unavailable\./
  );
  assert.equal(expressions.length, 1);
  assert.deepEqual(directCommands, []);
});

test("serialized guarded reasoning blocks max to Ultra before executing the runner", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({ currentEffort: "max" });
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;

  assert.equal(await bridge.adjustReasoning("increase", { includeUltra: false }), "blocked-ultra");
  assert.deepEqual(harness.runnerCalls, []);
});

test("serialized guarded reasoning rejects unavailable metadata without executing the runner", async () => {
  for (const options of [
    { currentEffort: undefined },
    { currentEffort: "max", visibleTriggerCount: 2 }
  ]) {
    const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
    const harness = createGuardedRendererHarness(options);
    const testBridge = bridge as unknown as {
      ensureConnected: () => Promise<void>;
      evaluate: <T>(source: string) => Promise<T>;
    };
    testBridge.ensureConnected = async () => {};
    testBridge.evaluate = harness.evaluate;

    await assert.rejects(
      bridge.adjustReasoning("increase", { includeUltra: false }),
      (error: Error) => {
        assert.equal(error.message, "Codex reasoning metadata is unavailable.");
        return true;
      }
    );
    assert.deepEqual(harness.runnerCalls, []);
  }
});

test("serialized guarded reasoning executes the lazy runner exactly once below Ultra", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({ currentEffort: "xhigh" });
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;

  assert.equal(await bridge.adjustReasoning("increase", { includeUltra: false }), "applied");
  assert.deepEqual(harness.runnerCalls, [["composer.increaseReasoningEffort", "codex_micro_hid"]]);
});

test("guarded reasoning expression serializes every helper dependency into renderer scope", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  let expression = "";
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = async <T>(source: string): Promise<T> => {
    expression = source;
    return "blocked-ultra" as T;
  };

  await bridge.adjustReasoning("increase", { includeUltra: false });

  for (const helper of [
    "isSafeReasoningIdentifier",
    "normalizeReasoningEffortOrder",
    "isVisibleReasoningTrigger",
    "readSelectedReasoningModelId",
    "findRendererQueryClients",
    "readReasoningModelEfforts",
    "readActiveReasoningMetadata",
    "decideReasoningAdjustment",
    "resolveCommandRunner"
  ]) assert.match(expression, new RegExp(`const ${helper} = \\(`), `${helper} is defined in renderer scope`);
});

test("protected generic keycaps cannot reach the low-level reasoning runner", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const expressions: string[] = [];
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = async <T>(source: string): Promise<T> => {
    expressions.push(source);
    return true as T;
  };

  await bridge.runKeycap("TERM");
  await bridge.adjustReasoning("increase");
  await bridge.adjustReasoning("decrease");

  assert.equal(expressions.length, 3);
  assert.doesNotMatch(expressions[0]!, /resolveCommandRunner/);
  assert.match(expressions[1]!, /composer\.increaseReasoningEffort/);
  assert.match(expressions[2]!, /composer\.decreaseReasoningEffort/);
  assert.match(expressions[1]!, /resolveCommandRunner/);
  assert.match(expressions[2]!, /resolveCommandRunner/);
});

test("command runner discovery resolves imported two-argument guarded calls and rejects contextual branches", async () => {
  const candidate = Reflect.get(microBridgeModule, "resolveCommandRunner") as unknown;
  assert.equal(typeof candidate, "function");
  const resolveCommandRunner = candidate as (
    bridgeSource: string,
    bridgeUrl: string,
    importModule: (url: string) => Promise<Record<string, unknown>>
  ) => Promise<((command: string, source: string) => unknown) | null>;
  const calls: Array<[string, string]> = [];
  const imports: string[] = [];
  const bridgeUrl = "https://codex.example/assets/codex-micro-bridge-live.js";
  const modules: Record<string, Record<string, unknown>> = {
    "https://codex.example/assets/guarded-runner-live.js": {
      guarded(command: string, source: string) {
        calls.push([command, source]);
        return true;
      }
    },
    "https://codex.example/assets/contextual-runner-live.js": {
      contextual() { throw new Error("three-argument contextual runner must not be selected"); }
    }
  };
  const bridgeSource = [
    'import{guarded as he}from"./guarded-runner-live.js";',
    'import{contextual as Zt}from"./contextual-runner-live.js";',
    "enabled&&he('composer.startVoiceMode','codex_micro_hid');",
    "Zt(r,p.command,`codex_micro_hid`);"
  ].join("");
  const importModule = async (url: string): Promise<Record<string, unknown>> => {
    imports.push(url);
    return modules[url] ?? {};
  };

  const runner = await resolveCommandRunner(bridgeSource, bridgeUrl, importModule);

  assert.equal(typeof runner, "function");
  assert.equal(runner?.("composer.increaseReasoningEffort", "codex_micro_hid"), true);
  assert.equal(runner?.("composer.decreaseReasoningEffort", "codex_micro_hid"), true);
  assert.deepEqual(calls, [
    ["composer.increaseReasoningEffort", "codex_micro_hid"],
    ["composer.decreaseReasoningEffort", "codex_micro_hid"]
  ]);
  assert.deepEqual(imports, ["https://codex.example/assets/guarded-runner-live.js"]);
  assert.equal(
    await resolveCommandRunner("import{contextual as Zt}from'./contextual-runner-live.js';Zt(r,p.command,`codex_micro_hid`);", bridgeUrl, importModule),
    null
  );
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
  assert.match(source, /resolveCommandRunner/);
  assert.match(source, /importModule/);
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
