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

class ReasoningQueryClientFixture {
  #entries: unknown;

  constructor(entries: unknown) {
    this.#entries = entries;
  }

  getQueriesData(): unknown {
    return this.#entries;
  }

  getQueryData(): undefined {
    return undefined;
  }
}

function createGuardedRendererHarness(options: {
  currentEffort?: string;
  visibleTriggerCount?: number;
  modelId?: string;
  queryKey?: unknown[];
  supportedEfforts?: string[];
  advanceEffortOnCommand?: boolean;
  confirmationDelayMs?: number;
  confirmationEffortOnCommand?: string;
  confirmationTriggerCount?: number;
  failConfirmationReadAfterCommand?: boolean;
}): {
  evaluate: <T>(expression: string) => Promise<T>;
  runnerCalls: Array<[string, string]>;
  currentEffort: () => string | undefined;
  restoreMetadataReads: () => void;
} {
  const runnerCalls: Array<[string, string]> = [];
  const globalKey = `__codexDeckGuardedRunnerCalls${++guardedRendererHarnessId}`;
  const runtime = globalThis as unknown as Record<string, unknown>;
  const supportedEfforts = options.supportedEfforts ?? ["low", "medium", "high", "xhigh", "max", "ultra"];
  let currentEffort = options.currentEffort;
  let metadataReadsFail = false;
  let commandIssued = false;
  const runnerState = {
    run(command: string, source: string) {
      runnerCalls.push([command, source]);
      commandIssued = true;
      if (options.failConfirmationReadAfterCommand) metadataReadsFail = true;
      if (options.confirmationEffortOnCommand != null) {
        queueMicrotask(() => { currentEffort = options.confirmationEffortOnCommand; });
      } else if (options.advanceEffortOnCommand) {
        const index = currentEffort == null ? -1 : supportedEfforts.indexOf(currentEffort);
        const delta = command === "composer.increaseReasoningEffort" ? 1 : -1;
        if (index >= 0 && index + delta >= 0 && index + delta < supportedEfforts.length) {
          const commit = () => { currentEffort = supportedEfforts[index + delta]; };
          if (options.confirmationDelayMs != null) setTimeout(commit, options.confirmationDelayMs);
          else queueMicrotask(commit);
        }
      }
      return true;
    }
  };
  runtime[globalKey] = runnerState;
  const runnerSource = [
    "export function guarded(command, source) {",
    `  return globalThis[${JSON.stringify(globalKey)}].run(command, source);`,
    "}"
  ].join("\n");
  const runnerUrl = `data:text/javascript,${encodeURIComponent(runnerSource)}`;
  const bridgeUrl = `https://codex.example/assets/codex-micro-bridge-guard-${guardedRendererHarnessId}.js`;
  const bridgeSource = [
    `import{guarded as he}from${JSON.stringify(runnerUrl)};`,
    "enabled&&he('composer.increaseReasoningEffort','codex_micro_hid');"
  ].join("");
  const modelId = options.modelId ?? "gpt-5.6-sol";
  const queryClient = new ReasoningQueryClientFixture([[
    options.queryKey ?? ["models", "list"],
    { data: [{
          displayName: modelId === "gpt-5.6-sol" ? "GPT-5.6-Sol" : modelId,
          model: modelId,
          supportedReasoningEfforts: supportedEfforts.map((reasoningEffort) => ({ reasoningEffort }))
    }] }
  ]]);
  const root = {
    "__reactContainer$test": { memoizedProps: { value: queryClient }, child: null, sibling: null }
  };
  const trigger = () => {
    const result: Record<string, any> = {
      isConnected: true,
      getClientRects: () => ({ length: 1 }),
      getAttribute: (name: string) => {
        if (metadataReadsFail && name === "data-selected-reasoning-effort") {
          throw new Error("metadata read failed");
        }
        return ({
          "data-codex-intelligence-trigger": "true",
          "data-composer-navigation-target": "reasoning",
          "data-selected-reasoning-effort": currentEffort ?? null
        })[name] ?? null;
      }
    };
    const label = {
      isConnected: true,
      getClientRects: () => ({ length: 1 }),
      getAttribute: () => null,
      parentElement: result,
      children: [],
      textContent: modelId === "gpt-5.6-sol" ? "5.6 Sol" : modelId
    };
    result.querySelectorAll = (selector: string) => selector === "*" ? [label] : [];
    return result;
  };
  const triggers = Array.from({
    length: Math.max(options.visibleTriggerCount ?? 1, options.confirmationTriggerCount ?? 1)
  }, trigger);
  const document = {
    getElementById: (id: string) => id === "root" ? root : null,
    querySelectorAll: (selector: string) => selector === "link[href], script[src]"
      ? [{ href: bridgeUrl, src: "" }]
      : selector === '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]'
        ? triggers.slice(0, commandIssued
          ? options.confirmationTriggerCount ?? options.visibleTriggerCount ?? 1
          : options.visibleTriggerCount ?? 1)
        : []
  };
  const performance = { getEntriesByType: () => [] };
  const fetch = async (url: string) => {
    assert.equal(url, bridgeUrl);
    return { text: async () => bridgeSource };
  };
  const getComputedStyle = () => ({ display: "block", visibility: "visible" });
  let activeEvaluations = 0;

  return {
    runnerCalls,
    currentEffort: () => currentEffort,
    restoreMetadataReads: () => { metadataReadsFail = false; },
    evaluate: async <T>(expression: string): Promise<T> => {
      activeEvaluations++;
      runtime[globalKey] ??= runnerState;
      try {
        const run = new Function(
          "document", "performance", "fetch", "getComputedStyle",
          `return (${expression});`
        ) as (document: unknown, performance: unknown, fetch: unknown, getComputedStyle: unknown) => Promise<T>;
        return await run(document, performance, fetch, getComputedStyle);
      } finally {
        if (--activeEvaluations === 0) delete runtime[globalKey];
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
  for (const reasoningEffort of ["high", "xhigh", "extra-high", "reasoning_v2", "level.2"]) {
    assert.equal(read([{
      getAttribute: (name: string) => name === "data-selected-reasoning-effort"
        ? reasoningEffort : "reasoning",
      visible: true
    }], (element) => element.visible), reasoningEffort);
  }
  for (const reasoningEffort of [
    "", " high ", "x high", "\n", "high\n", "\u0000", "!!!", "é", "推理", "x".repeat(65)
  ]) {
    assert.equal(read([{
      getAttribute: (name: string) => name === "data-selected-reasoning-effort"
        ? reasoningEffort : "reasoning",
      visible: true
    }], (element) => element.visible), undefined);
  }
  assert.equal(read([
    ...elements,
    { getAttribute: (name: string) => name === "data-selected-reasoning-effort" ? "low" : "reasoning", visible: true }
  ], (element) => element.visible), undefined, "conflicting visible reasoning targets are unavailable");
});

test("serialized renderer snapshots preserve strict reasoning identifier validation", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  let expression = "";
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
    sessionOwnership: { annotate: (value: MicroSnapshot) => Promise<MicroSnapshot> };
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = async <T>(source: string): Promise<T> => {
    expression = source;
    return snapshotFixture() as T;
  };
  testBridge.sessionOwnership = { annotate: async (value) => value };

  await bridge.refresh();

  const helperStart = expression.indexOf("  const isVisibleReasoningTrigger = ");
  const helperEnd = expression.indexOf("  const hasFastModeIndicator = ", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helperBlock = expression.slice(helperStart, helperEnd);
  assert.match(helperBlock, /const isSafeReasoningIdentifier =/);
  const read = new Function("getComputedStyle", `${helperBlock}\nreturn readActiveReasoningEffort;`)(
    () => ({ display: "block", visibility: "visible" })
  ) as (
    elements: Array<{ getAttribute: (name: string) => string | null; visible: boolean }>,
    isVisible: (element: { visible: boolean }) => boolean
  ) => string | undefined;
  const trigger = (reasoningEffort: string) => ({
    getAttribute: (name: string) => name === "data-selected-reasoning-effort"
      ? reasoningEffort : "reasoning",
    visible: true
  });
  for (const reasoningEffort of ["high", "xhigh", "extra-high", "reasoning_v2", "level.2"]) {
    assert.equal(read([trigger(reasoningEffort)], (element) => element.visible), reasoningEffort);
  }
  for (const reasoningEffort of [
    "", " high ", "x high", "\n", "high\n", "\u0000", "!!!", "é", "推理", "x".repeat(65)
  ]) {
    assert.equal(read([trigger(reasoningEffort)], (element) => element.visible), undefined);
  }
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
  assert.match(source, new RegExp(`readActiveReasoningMetadata\\(document\\.querySelectorAll\\(\\s*'${escapedTriggerSelector}'`));
  assert.match(source, /activeModelId:\s*reasoningMetadata\.modelId/);
  assert.match(source, /activeModelDisplayName:\s*reasoningMetadata\.modelDisplayName/);
  assert.match(source, /modelCatalog:\s*reasoningMetadata\.modelCatalog/);
  assert.match(source, /reasoningEffort:\s*reasoningMetadata\.currentEffort/);
  assert.match(source, /fallbackReasoningEffort\s*=\s*reasoningMetadata\s*\?\s*undefined\s*:\s*readActiveReasoningEffort/);
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

test("active reasoning metadata resolves the unique visible reasoning model label", () => {
  const candidate = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as unknown;
  assert.equal(typeof candidate, "function");
  const read = candidate as (
    elements: Iterable<Record<string, unknown>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, unknown>) => boolean
  ) => { currentEffort: string; modelId: string; modelDisplayName: string;
    supportedEfforts: string[]; modelCatalog: unknown[] } | undefined;
  const efforts = ["medium", "low", "high", "xhigh", "max", "ultra"];
  const modelsQuery = {
    queryKey: ["models", "list"],
    state: { data: { data: [
      {
        displayName: "GPT-5.3-Codex-Spark",
        model: "gpt-5.3-codex-spark",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort }))
      },
      {
        displayName: "GPT-5.6-Sol",
        model: "gpt-5.6-sol",
        supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort }))
      }
    ] } }
  };
  const queryClient = new ReasoningQueryClientFixture([[modelsQuery.queryKey, modelsQuery.state.data]]);
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
      "data-selected-reasoning-effort": " high "
    })[name] ?? null,
    "__reactProps$live": { selectedValue: { props: { model: "gpt-5.3-codex-spark" } } }
  };
  const measurement = {
    visible: true,
    parentElement: trigger,
    children: [{}],
    getAttribute: (name: string) => name === "class" ? "ModelPickerTriggerMeasurement_live" :
      name === "aria-hidden" ? "true" : null
  };
  const hiddenLabel = {
    visible: true,
    parentElement: measurement,
    children: [],
    textContent: "5.3 Codex Spark",
    getAttribute: () => null
  };
  const visibleLabel = {
    visible: true,
    parentElement: trigger,
    children: [],
    textContent: "5.6 Sol",
    getAttribute: () => null
  };
  Object.assign(trigger, {
    querySelectorAll: (selector: string) => {
      assert.equal(selector, "*");
      return [measurement, hiddenLabel, visibleLabel];
    }
  });

  assert.deepEqual(read([trigger], reactRootFiber, (element) => element.visible === true), {
    currentEffort: "high",
    modelId: "gpt-5.6-sol",
    modelDisplayName: "5.6 Sol",
    supportedEfforts: efforts,
    modelCatalog: [
      {
        modelId: "gpt-5.3-codex-spark", displayName: "5.3 Codex Spark",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
      },
      { modelId: "gpt-5.6-sol", displayName: "5.6 Sol", supportedReasoningEfforts: efforts }
    ]
  });
  assert.equal(read([
    trigger,
    { ...trigger, "__reactProps$live": { selectedValue: { props: { model: "gpt-5.6-sol" } } } }
  ], reactRootFiber, (element) => element.visible === true), undefined, "multiple visible semantic triggers are ambiguous");
  assert.deepEqual(read([
    { ...trigger, visible: false }, trigger
  ], reactRootFiber, (element) => element.visible === true)?.supportedEfforts, efforts, "hidden triggers are ignored");
});

test("reasoning metadata resolves the live display-contents model leaf and ignores its effort sibling", () => {
  const read = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as (
    elements: Iterable<Record<string, any>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, any>) => boolean,
    isExplicitlyHidden: (element: Record<string, any>) => boolean
  ) => { currentEffort: string; modelId: string; modelDisplayName: string;
    supportedEfforts: string[]; modelCatalog: unknown[] } | undefined;
  const queryClient = new ReasoningQueryClientFixture([[['models', 'list'], {
    data: [{
      displayName: "GPT-5.6-Terra",
      model: "gpt-5.6-terra",
      supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort }))
    }]
  }]]);
  const trigger: Record<string, any> = {
    visibleGeometry: true,
    getAttribute: (name: string) => ({
      "data-codex-intelligence-trigger": "true",
      "data-composer-navigation-target": "reasoning",
      "data-selected-reasoning-effort": "medium"
    })[name] ?? null
  };
  const element = (parentElement: unknown, options: Record<string, unknown>) => ({
    tagName: "SPAN",
    children: [],
    parentElement,
    visibleGeometry: true,
    display: "inline",
    visibility: "visible",
    getAttribute(name: string) {
      if (name === "class") return options.className ?? null;
      if (name === "aria-hidden") return options.ariaHidden ? "true" : null;
      if (name === "hidden") return options.hidden ? "" : null;
      return null;
    },
    ...options
  });
  const measurement = element(trigger, {
    tagName: "DIV",
    className: "ModelPickerTriggerMeasurement_probe",
    ariaHidden: true,
    children: [{}]
  });
  const hiddenModel = element(measurement, {
    className: "ModelPickerTriggerModelText_probe",
    textContent: "5.3 Codex Spark"
  });
  const dropdownLabel = element(trigger, {
    tagName: "DIV",
    className: "ComposerDropdownLabel_probe",
    children: [{}, {}],
    display: "contents",
    visibleGeometry: false
  });
  const visibleModel = element(dropdownLabel, {
    className: "ModelPickerTriggerModelText_probe",
    textContent: "5.6 Terra"
  });
  const effort = element(dropdownLabel, {
    className: "ModelPickerTriggerEffortLabel_probe",
    textContent: "Medium"
  });
  trigger.querySelectorAll = (selector: string) => selector === "*"
    ? [measurement, hiddenModel, dropdownLabel, visibleModel, effort]
    : [];
  const hasGeometry = (node: Record<string, any>) => node.visibleGeometry === true;
  const isExplicitlyHidden = (node: Record<string, any>) => node.display === "none" ||
    node.visibility === "hidden" || node.visibility === "collapse" ||
    node.getAttribute?.("aria-hidden") === "true" || node.getAttribute?.("hidden") !== null ||
    /ModelPickerTriggerMeasurement/i.test(node.getAttribute?.("class") ?? "");

  assert.deepEqual(read([trigger], {
    memoizedProps: { value: queryClient }, child: null, sibling: null
  }, hasGeometry, isExplicitlyHidden), {
    currentEffort: "medium",
    modelId: "gpt-5.6-terra",
    modelDisplayName: "5.6 Terra",
    supportedEfforts: ["low", "medium", "high"],
    modelCatalog: [{
      modelId: "gpt-5.6-terra", displayName: "5.6 Terra",
      supportedReasoningEfforts: ["low", "medium", "high"]
    }]
  });
});

test("reasoning metadata maps model and effort leaves without depending on their classes", () => {
  const read = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as (
    elements: Iterable<Record<string, any>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, any>) => boolean,
    isExplicitlyHidden: (element: Record<string, any>) => boolean
  ) => { modelId: string } | undefined;
  const queryClient = new ReasoningQueryClientFixture([[['models', 'list'], { data: [{
    displayName: "GPT-5.6-Terra",
    model: "gpt-5.6-terra",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }]
  }] }]]);
  const trigger: Record<string, any> = {
    visibleGeometry: true,
    getAttribute: (name: string) => ({
      "data-codex-intelligence-trigger": "true",
      "data-composer-navigation-target": "reasoning",
      "data-selected-reasoning-effort": "medium"
    })[name] ?? null
  };
  const leaf = (textContent: string) => ({
    visibleGeometry: true,
    children: [],
    parentElement: trigger,
    textContent,
    getAttribute: () => null
  });
  trigger.querySelectorAll = () => [leaf("5.6 Terra"), leaf("Medium")];

  assert.equal(read([trigger], { memoizedProps: { value: queryClient }, child: null, sibling: null },
    (node) => node.visibleGeometry === true, () => false)?.modelId, "gpt-5.6-terra");
});

test("explicitly hidden reasoning triggers cannot authorize metadata", () => {
  const read = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as (
    elements: Iterable<Record<string, any>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, any>) => boolean,
    isExplicitlyHidden: (element: Record<string, any>) => boolean
  ) => unknown;
  const query = reasoningTrustQuery();
  const queryClient = new ReasoningQueryClientFixture([[query.queryKey, query.state.data]]);
  const reactRootFiber = { memoizedProps: { value: queryClient }, child: null, sibling: null };
  const trigger = (state: Record<string, unknown>) => {
    const result: Record<string, any> = {
      visibleGeometry: true,
      display: "block",
      visibility: "visible",
      getAttribute: (name: string) => ({
        "data-codex-intelligence-trigger": "true",
        "data-composer-navigation-target": "reasoning",
        "data-selected-reasoning-effort": "high",
        "aria-hidden": state.ariaHidden ? "true" : null,
        hidden: state.hidden ? "" : null,
        class: state.measurement ? "ModelPickerTriggerMeasurement_probe" : null
      })[name] ?? null,
      ...state
    };
    const modelLeaf = {
      visibleGeometry: true,
      display: "inline",
      visibility: "visible",
      parentElement: result,
      children: [],
      textContent: "5.6 Sol",
      getAttribute: () => null
    };
    result.querySelectorAll = () => [modelLeaf];
    return result;
  };
  const hasGeometry = (node: Record<string, any>) => node.visibleGeometry === true;
  const isExplicitlyHidden = (node: Record<string, any>) => node.display === "none" ||
    node.visibility === "hidden" || node.visibility === "collapse" ||
    node.getAttribute?.("aria-hidden") === "true" || node.getAttribute?.("hidden") !== null ||
    /ModelPickerTriggerMeasurement/i.test(node.getAttribute?.("class") ?? "");

  const hiddenStates = [
    { ariaHidden: true },
    { hidden: true },
    { display: "none" },
    { visibility: "collapse" },
    { measurement: true }
  ];
  assert.deepEqual(hiddenStates.map((state) =>
    read([trigger(state)], reactRootFiber, hasGeometry, isExplicitlyHidden)
  ), hiddenStates.map(() => undefined));
});

test("reasoning discovery does not clone unrelated contexts or invoke nested accessors", () => {
  let nestedGetterReads = 0;
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, "hostile", {
    enumerable: true,
    get() {
      nestedGetterReads++;
      throw new Error("unrelated nested getter must not run");
    }
  });
  const unrelatedContext = { nested };
  const query = reasoningTrustQuery();
  const queryClient = new ReasoningQueryClientFixture([[query.queryKey, query.state.data]]);
  const read = reasoningTrustFixture({
    memoizedProps: { value: unrelatedContext },
    dependencies: { firstContext: { memoizedValue: queryClient, next: null } },
    child: null,
    sibling: null
  });

  assert.equal(read()?.modelId, "gpt-5.6-sol");
  assert.equal(nestedGetterReads, 0);

  class UnsafeQueryClient extends ReasoningQueryClientFixture {
    unsafe = { nested };
  }
  const unsafeClient = new UnsafeQueryClient([[query.queryKey, query.state.data]]);
  assert.equal(reasoningTrustFixture({
    memoizedProps: { value: unsafeClient }, child: null, sibling: null
  })(), undefined, "fingerprinted clients with unsafe enumerable state fail closed before cloning");
  assert.equal(nestedGetterReads, 0, "nested client accessors are never invoked");
});

function reasoningTrustFixture(rootFiber: unknown) {
  const read = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as (
    elements: Iterable<Record<string, any>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, any>) => boolean
  ) => { currentEffort: string; modelId: string; supportedEfforts: string[] } | undefined;
  const trigger: Record<string, any> = {
    visible: true,
    getAttribute: (name: string) => ({
      "data-codex-intelligence-trigger": "true",
      "data-composer-navigation-target": "reasoning",
      "data-selected-reasoning-effort": "high"
    })[name] ?? null
  };
  const label = {
    visible: true,
    parentElement: trigger,
    children: [],
    textContent: "5.6 Sol",
    getAttribute: () => null
  };
  trigger.querySelectorAll = (selector: string) => selector === "*" ? [label] : [];
  return () => read([trigger], rootFiber, (element) => element.visible === true);
}

function reasoningTrustQuery() {
  return {
    queryKey: ["models", "list"],
    state: { data: { data: [{
      displayName: "GPT-5.6-Sol",
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }]
    }] } }
  };
}

test("reasoning metadata rejects a proxy-backed query client", () => {
  const query = reasoningTrustQuery();
  const queryClient = new ReasoningQueryClientFixture([[query.queryKey, query.state.data]]);
  const read = reasoningTrustFixture({
    memoizedProps: { value: new Proxy(queryClient, {}) }, child: null, sibling: null
  });
  assert.equal(read(), undefined);
});

test("reasoning metadata rejects a proxy-backed query object", () => {
  let queryCacheReads = 0;
  const queryClient = new class extends ReasoningQueryClientFixture {
    constructor() { super([]); }
    getQueryCache() {
      queryCacheReads++;
      return { getAll: () => [new Proxy(reasoningTrustQuery(), {})] };
    }
  }();
  const read = reasoningTrustFixture({ memoizedProps: { value: queryClient }, child: null, sibling: null });
  assert.equal(read(), undefined);
  assert.equal(queryCacheReads, 0, "query objects are outside the authorization path");
});

test("reasoning metadata never invokes throwing fiber accessors", () => {
  let getterReads = 0;
  const rootFiber: Record<string, unknown> = { child: null, sibling: null };
  Object.defineProperty(rootFiber, "memoizedProps", {
    enumerable: true,
    get() {
      getterReads++;
      throw new Error("fiber getter must not run");
    }
  });
  const read = reasoningTrustFixture(rootFiber);
  assert.doesNotThrow(() => assert.equal(read(), undefined));
  assert.equal(getterReads, 0);
});

test("reasoning metadata wraps the full discovery path fail closed", () => {
  const read = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as (
    elements: Iterable<Record<string, any>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, any>) => boolean
  ) => unknown;
  const trigger = {
    visible: true,
    getAttribute() { throw new Error("hostile DOM read"); }
  };
  assert.doesNotThrow(() => assert.equal(read([trigger], {}, (element) => element.visible === true), undefined));
});

test("visible reasoning model labels and catalog records fail closed on ambiguity and unsafe data", () => {
  const read = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as (
    elements: Iterable<Record<string, any>>,
    reactRootFiber: unknown,
    isVisible: (element: Record<string, any>) => boolean
  ) => { currentEffort: string; modelId: string; supportedEfforts: string[] } | undefined;
  const visible = (element: Record<string, any>) => element.visible === true &&
    element.display !== "none" && element.visibility !== "hidden";
  const record = (
    displayName: unknown = "GPT-5.6-Sol",
    model: unknown = "gpt-5.6-sol",
    efforts: unknown = ["low", "high", "ultra"].map((reasoningEffort) => ({ reasoningEffort }))
  ) => ({ displayName, model, supportedReasoningEfforts: efforts });
  const root = (records: unknown[], extraEntries: unknown[] = []) => {
    const queryClient = new ReasoningQueryClientFixture([[
      ["models", "list"],
      { data: records }
    ], ...extraEntries]);
    return { memoizedProps: { value: queryClient }, child: null, sibling: null };
  };
  const trigger = (
    labels: Array<{
      text: unknown;
      ariaHidden?: boolean;
      measurement?: boolean;
      visible?: boolean;
      display?: string;
      visibility?: string;
      depth?: number;
    }>,
    reactProps: unknown = undefined
  ) => {
    const result: Record<string, any> = {
      visible: true,
      getAttribute: (name: string) => ({
        "data-codex-intelligence-trigger": "true",
        "data-composer-navigation-target": "reasoning",
        "data-selected-reasoning-effort": "high"
      })[name] ?? null,
      ...(reactProps === undefined ? {} : { "__reactProps$ignored": reactProps })
    };
    const descendants: Record<string, any>[] = [];
    for (const label of labels) {
      let parent = result;
      const depth = label.depth ?? 0;
      for (let index = 0; index < depth; index++) {
        const wrapper: Record<string, any> = {
          visible: true,
          parentElement: parent,
          children: [{}],
          getAttribute: () => null
        };
        descendants.push(wrapper);
        parent = wrapper;
      }
      if (label.ariaHidden || label.measurement) {
        const wrapper: Record<string, any> = {
          visible: true,
          parentElement: parent,
          children: [{}],
          getAttribute: (name: string) => label.ariaHidden && name === "aria-hidden" ? "true" :
            label.measurement && name === "class" ? "ModelPickerTriggerMeasurement_probe" : null
        };
        descendants.push(wrapper);
        parent = wrapper;
      }
      descendants.push({
        visible: label.visible ?? true,
        display: label.display,
        visibility: label.visibility,
        parentElement: parent,
        children: [],
        textContent: label.text,
        getAttribute: () => null
      });
    }
    result.querySelectorAll = (selector: string) => selector === "*" ? descendants : [];
    return result;
  };
  const goodRoot = () => root([record()]);

  assert.equal(read([trigger([])], goodRoot(), visible), undefined, "zero visible labels are unavailable");
  assert.deepEqual(read([trigger([{ text: "5.6 Sol" }, { text: "5.6 Pro" }])], goodRoot(), visible), {
    currentEffort: "high",
    modelId: "gpt-5.6-sol",
    modelDisplayName: "5.6 Sol",
    supportedEfforts: ["low", "high", "ultra"],
    modelCatalog: [{
      modelId: "gpt-5.6-sol", displayName: "5.6 Sol",
      supportedReasoningEfforts: ["low", "high", "ultra"]
    }]
  }, "unmatched visible text does not make one catalog match ambiguous");
  assert.equal(read([trigger([{ text: "5.6 Sol" }, { text: "5.6 Pro" }])], root([
    record(), record("GPT-5.6-Pro", "gpt-5.6-pro")
  ]), visible), undefined, "multiple distinct catalog-aware label matches are unavailable");
  assert.equal(read([trigger([{ text: "   " }])], goodRoot(), visible), undefined, "blank labels are ignored");
  assert.equal(read([trigger([{ text: "5.6 Sol", display: "none" }])], goodRoot(), visible), undefined,
    "display-none labels are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol", visibility: "hidden" }])], goodRoot(), visible), undefined,
    "visibility-hidden labels are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol", ariaHidden: true }])], goodRoot(), visible), undefined,
    "aria-hidden ancestors are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol", measurement: true }])], goodRoot(), visible), undefined,
    "measurement ancestors are unavailable");
  assert.equal(read([trigger([{ text: "x".repeat(129) }])], goodRoot(), visible), undefined,
    "oversized labels are unavailable");
  assert.equal(read([trigger([], { selectedValue: { props: { model: "gpt-5.6-sol" } } })], goodRoot(), visible),
    undefined, "React-only model values cannot authorize");
  assert.equal(read([trigger([{ text: "5.6 Sol", depth: 33 }])], goodRoot(), visible), undefined,
    "DOM ancestor depth exhaustion is unavailable");
  assert.equal(read([trigger(Array.from({ length: 257 }, () => ({ text: "" })))], goodRoot(), visible), undefined,
    "DOM node exhaustion is unavailable");

  assert.deepEqual(read([trigger([{ text: " 5.6-sol " }])], goodRoot(), visible), {
    currentEffort: "high",
    modelId: "gpt-5.6-sol",
    modelDisplayName: "5.6 Sol",
    supportedEfforts: ["low", "high", "ultra"],
    modelCatalog: [{
      modelId: "gpt-5.6-sol", displayName: "5.6 Sol",
      supportedReasoningEfforts: ["low", "high", "ultra"]
    }]
  }, "normalization permits case and space-hyphen equivalence");
  assert.equal(read([trigger([{ text: "GPT-5.6-Sol" }])], goodRoot(), visible), undefined,
    "the optional GPT brand token applies only to catalog display names");
  assert.equal(read([trigger([{ text: "5.6 Sol Plus" }])], goodRoot(), visible), undefined,
    "substring matches are not accepted");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([record("GPT-5.7-Sol")]), visible), undefined,
    "zero normalized catalog matches are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([
    record("GPT-5.6-Sol"), record("5.6 Sol", "gpt-5.6-sol-copy")
  ]), visible), undefined, "multiple normalized catalog matches are unavailable");
  const duplicateEntry = [["models", "list"], { data: [record()] }];
  assert.deepEqual(read([trigger([{ text: "5.6 Sol" }])], root([record()], [duplicateEntry]), visible), {
    currentEffort: "high",
    modelId: "gpt-5.6-sol",
    modelDisplayName: "5.6 Sol",
    supportedEfforts: ["low", "high", "ultra"],
    modelCatalog: [{
      modelId: "gpt-5.6-sol", displayName: "5.6 Sol",
      supportedReasoningEfforts: ["low", "high", "ultra"]
    }]
  }, "identical validated records across query entries count as one catalog match");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([record(undefined, undefined, ["low", "high"])]), visible),
    undefined, "raw string effort arrays are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([{ model: "gpt-5.6-sol",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }] }]), visible), undefined,
    "missing display names are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([record("GPT-5.6-Sol! ")]), visible), undefined,
    "malformed display names are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([record(`GPT-${"x".repeat(129)}`)]), visible), undefined,
    "oversized display names are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([record("GPT-5.6-Sol", "bad model")]), visible),
    undefined, "malformed model IDs are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([
    record(), { model: "other-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }
  ]), visible), undefined, "malformed nonmatching records invalidate the catalog");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([record("GPT-5.6-Sol", "gpt-5.6-sol",
    Array.from({ length: 65 }, (_, index) => ({ reasoningEffort: `effort-${index}` })))]), visible), undefined,
    "oversized effort arrays are unavailable");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root(Array.from({ length: 1001 }, () => record())), visible),
    undefined, "oversized model arrays are unavailable");

  let accessorReads = 0;
  const accessorRecord: Record<string, unknown> = {
    model: "gpt-5.6-sol",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }]
  };
  Object.defineProperty(accessorRecord, "displayName", {
    enumerable: true,
    get() { accessorReads++; return "GPT-5.6-Sol"; }
  });
  const accessorQueryKey: unknown[] = ["models", "list", "local", "chatgpt", 100];
  Object.defineProperty(accessorQueryKey, "0", {
    enumerable: true,
    get() { accessorReads++; return "models"; }
  });
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([accessorRecord]), visible), undefined);
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([record()], [[accessorQueryKey,
    { data: [record()] }]]), visible), undefined);
  const accessorRecords: unknown[] = [record()];
  Object.defineProperty(accessorRecords, "0", {
    enumerable: true,
    get() { accessorReads++; return record(); }
  });
  const accessorEfforts: unknown[] = [{ reasoningEffort: "low" }, { reasoningEffort: "high" }];
  Object.defineProperty(accessorEfforts, "1", {
    enumerable: true,
    get() { accessorReads++; return { reasoningEffort: "high" }; }
  });
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root(accessorRecords), visible), undefined);
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([
    record("GPT-5.6-Sol", "gpt-5.6-sol", accessorEfforts)
  ]), visible), undefined);
  assert.equal(accessorReads, 0, "catalog accessors are never invoked");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([
    new Proxy(record(), {})
  ]), visible), undefined, "proxy-backed catalog records cannot authorize");
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([
    record("GPT-5.6-Sol", "gpt-5.6-sol", new Proxy([{ reasoningEffort: "high" }], {}))
  ]), visible), undefined, "proxy-backed effort arrays cannot authorize");

  const plainQuery = reasoningTrustQuery();
  const plainClient = new ReasoningQueryClientFixture([[plainQuery.queryKey, plainQuery.state.data]]);
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], {
    memoizedProps: { value: new Proxy(plainClient, {}) }, child: null, sibling: null
  }, visible), undefined, "proxy-backed query clients cannot authorize");
  const proxyQueryOnlyClient = new class extends ReasoningQueryClientFixture {
    constructor() { super([]); }
    getQueryCache() { return { getAll: () => [new Proxy(plainQuery, {})] }; }
  }();
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], {
    memoizedProps: { value: proxyQueryOnlyClient }, child: null, sibling: null
  }, visible), undefined, "proxy-backed query objects cannot authorize");

  let fiberGetterReads = 0;
  const accessorFiber: Record<string, unknown> = { child: null, sibling: null };
  Object.defineProperty(accessorFiber, "memoizedProps", {
    enumerable: true,
    get() {
      fiberGetterReads++;
      throw new Error("fiber getter must not run");
    }
  });
  assert.doesNotThrow(() => {
    assert.equal(read([trigger([{ text: "5.6 Sol" }])], accessorFiber, visible), undefined);
  }, "the full discovery path fails closed");
  assert.equal(fiberGetterReads, 0, "fiber accessors are never invoked");

  const pendingEntry = [["models", "list", "pending", "chatgpt", 100], undefined];
  assert.equal(read([trigger([{ text: "5.6 Sol" }])],
    root([record()], Array.from({ length: 30000 }, () => pendingEntry)), visible), undefined,
    "query traversal exhaustion is unavailable");

  const deepRecord: Record<string, unknown> = record();
  let branch = deepRecord;
  for (let depth = 0; depth < 33; depth++) {
    branch.extra = {};
    branch = branch.extra as Record<string, unknown>;
  }
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], root([deepRecord]), visible), undefined,
    "catalog property-depth exhaustion is unavailable");
  const exhaustedRoot = goodRoot() as Record<string, any>;
  let fiber = exhaustedRoot;
  for (let index = 0; index < 30000; index++) {
    fiber.child = {};
    fiber = fiber.child;
  }
  assert.equal(read([trigger([{ text: "5.6 Sol" }])], exhaustedRoot, visible), undefined,
    "fiber traversal exhaustion is unavailable");
});

test("reasoning catalog authorizes only supported exact query-key shapes", () => {
  const read = Reflect.get(microBridgeModule, "readReasoningModelCatalogMatch") as (
    queryClients: Iterable<unknown>, visibleLabels: unknown
  ) => { modelId: string; supportedEfforts: string[] } | undefined;
  const record = (displayName = "GPT-5.6-Sol", model = "gpt-5.6-sol") => ({
    displayName,
    model,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }]
  });

  assert.deepEqual(read([
    new ReasoningQueryClientFixture([[["models", "list"], { data: [record()] }]])
  ], ["5.6 Sol"]), {
    modelId: "gpt-5.6-sol",
    supportedEfforts: ["low", "high"]
  }, "legacy exact two-segment keys remain supported");

  const liveEntries = [
    [["models", "list", "local", "no-auth", 100], {
      data: [record("GPT-5.6-Terra", "gpt-5.6-terra")]
    }],
    [["models", "list", "local", "chatgpt", 100], { data: [record()] }]
  ];
  const liveClient = new ReasoningQueryClientFixture(liveEntries);
  assert.deepEqual(read([liveClient], ["5.6 Sol"]), {
    modelId: "gpt-5.6-sol",
    supportedEfforts: ["low", "high"]
  }, "the current authenticated five-segment catalog key authorizes Sol");
  assert.deepEqual(read([liveClient], ["5.6 Terra"]), {
    modelId: "gpt-5.6-terra",
    supportedEfforts: ["low", "high"]
  }, "the current no-auth five-segment catalog key authorizes Terra");

  let accessorReads = 0;
  const accessorKey: unknown[] = ["models", "list", "local", "chatgpt", 100];
  Object.defineProperty(accessorKey, "2", {
    enumerable: true,
    get() { accessorReads++; return "local"; }
  });
  const symbolKey: unknown[] = ["models", "list", "local", "chatgpt", 100];
  Object.defineProperty(symbolKey, Symbol("unsafe"), { value: true });
  const extraEnumerableKey: unknown[] = ["models", "list", "local", "chatgpt", 100];
  Object.defineProperty(extraEnumerableKey, "extra", { value: true, enumerable: true });
  const extraNonEnumerableKey: unknown[] = ["models", "list", "local", "chatgpt", 100];
  Object.defineProperty(extraNonEnumerableKey, "extra", { value: true });
  const extraAccessorKey: unknown[] = ["models", "list", "local", "chatgpt", 100];
  Object.defineProperty(extraAccessorKey, "extra", {
    enumerable: false,
    get() { accessorReads++; return true; }
  });
  const trappedKey = new Proxy<unknown[]>(["models", "list", "local", "chatgpt", 100], {
    ownKeys() { throw new Error("query-key ownKeys trap must fail closed"); }
  });
  const invalidKeys: unknown[] = [
    ["models", "list", "extra"],
    ["models", "list", "local", "chatgpt"],
    ["models", "list", "local", "chatgpt", 100, "extra"],
    ["models", "list", "", "chatgpt", 100],
    ["models", "list", " local ", "chatgpt", 100],
    ["models", "list", "local", "no auth", 100],
    ["models", "list", "x".repeat(65), "chatgpt", 100],
    ["models", "list", "local", "chatgpt", -1],
    ["models", "list", "local", "chatgpt", 1.5],
    ["models", "list", "local", "chatgpt", "100"],
    accessorKey,
    symbolKey,
    extraEnumerableKey,
    extraNonEnumerableKey,
    extraAccessorKey,
    trappedKey
  ];
  for (const [index, queryKey] of invalidKeys.entries()) {
    assert.equal(read([
      new ReasoningQueryClientFixture([[queryKey, { data: [record()] }]])
    ], ["5.6 Sol"]), undefined, `unsupported catalog key fixture ${index} cannot authorize`);
  }
  assert.equal(accessorReads, 0, "query-key accessors are never invoked");
});

test("reasoning catalog deduplicates only identical fully validated matches", () => {
  const read = Reflect.get(microBridgeModule, "readReasoningModelCatalogMatch") as (
    queryClients: Iterable<unknown>, visibleLabels: unknown
  ) => { modelId: string; supportedEfforts: string[] } | undefined;
  const record = (
    displayName = "GPT-5.6-Sol",
    model = "gpt-5.6-sol",
    efforts = ["low", "high"]
  ) => ({
    displayName,
    model,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort }))
  });
  const entry = (value: ReturnType<typeof record>) => [["models", "list"], { data: [value] }];

  assert.deepEqual(read([
    new ReasoningQueryClientFixture([entry(record()), entry(record("5.6 Sol"))]),
    new ReasoningQueryClientFixture([entry(record("GPT 5.6 Sol"))])
  ], ["5.6 Sol"]), {
    modelId: "gpt-5.6-sol",
    supportedEfforts: ["low", "high"]
  }, "same id, normalized display name, and ordered efforts count as one match");

  for (const conflictingRecord of [
    record("GPT-5.6-Sol", "gpt-5.6-sol-copy"),
    record("GPT-5.6-Sol", "gpt-5.6-sol", ["high", "low"])
  ]) {
    assert.equal(read([
      new ReasoningQueryClientFixture([entry(record()), entry(conflictingRecord)])
    ], ["5.6 Sol"]), undefined, "conflicting ids or effort order remain ambiguous");
  }
  assert.equal(read([
    new ReasoningQueryClientFixture([
      entry(record()), entry(record("GPT-5.6-Terra", "gpt-5.6-sol"))
    ])
  ], ["5.6 Sol", "5.6 Terra"]), undefined,
  "conflicting normalized display names remain ambiguous");
});

test("model catalog exposes the complete bounded authoritative catalog and active model", () => {
  const readCatalog = Reflect.get(microBridgeModule, "readReasoningModelCatalog") as (
    queryClients: Iterable<unknown>
  ) => Array<{
    modelId: string;
    displayName: string;
    supportedReasoningEfforts: string[];
  }> | undefined;
  const matchActive = Reflect.get(microBridgeModule, "matchActiveReasoningModel") as (
    visibleLabels: unknown,
    catalog: unknown
  ) => { modelId: string; displayName: string; supportedReasoningEfforts: string[] } | undefined;
  assert.equal(typeof readCatalog, "function");
  assert.equal(typeof matchActive, "function");

  const records = [
    {
      displayName: "GPT-5.6-Sol",
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"]
        .map((reasoningEffort) => ({ reasoningEffort }))
    },
    {
      displayName: "GPT-5.6-Terra",
      model: "gpt-5.6-terra",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"]
        .map((reasoningEffort) => ({ reasoningEffort }))
    }
  ];
  const catalog = readCatalog([
    new ReasoningQueryClientFixture([[['models', 'list', 'local', 'chatgpt', 100], { data: records }]])
  ]);
  assert.deepEqual(catalog, [
    {
      modelId: "gpt-5.6-sol",
      displayName: "5.6 Sol",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"]
    },
    {
      modelId: "gpt-5.6-terra",
      displayName: "5.6 Terra",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"]
    }
  ]);
  assert.deepEqual(matchActive(["5.6 Sol"], catalog), catalog?.[0]);

  const unseparatedBrandCatalog = readCatalog([
    new ReasoningQueryClientFixture([[['models', 'list'], { data: [{
      ...records[0], displayName: "GPT5.6 Sol"
    }] }]])
  ]);
  assert.equal(unseparatedBrandCatalog?.[0]?.displayName, "GPT5.6 Sol");
  assert.equal(matchActive(["5.6 Sol"], unseparatedBrandCatalog), undefined,
    "a bare GPT prefix cannot acquire the separated-brand authorization semantics");

  const readMetadata = Reflect.get(microBridgeModule, "readActiveReasoningMetadata") as (
    elements: Iterable<unknown>, reactRootFiber: unknown,
    isVisible: (element: any) => boolean,
    isExplicitlyHidden: (element: any) => boolean
  ) => unknown;
  const visible = (element: { visible?: boolean }) => element.visible !== false;
  const trigger: Record<string, any> = {
    visible: true,
    getAttribute: (name: string) => ({
      "data-codex-intelligence-trigger": "true",
      "data-composer-navigation-target": "reasoning",
      "data-selected-reasoning-effort": "high"
    } as Record<string, string>)[name] ?? null
  };
  const leaf = {
    visible: true, children: [], textContent: "5.6 Sol", parentElement: trigger,
    getAttribute: () => null
  };
  trigger.querySelectorAll = (selector: string) => selector === "*" ? [leaf] : [];
  const queryClient = new ReasoningQueryClientFixture([[['models', 'list'], { data: records }]]);
  assert.deepEqual(readMetadata(
    [trigger], { memoizedProps: { value: queryClient }, dependencies: null, child: null, sibling: null },
    visible, () => false
  ), {
    currentEffort: "high",
    modelId: "gpt-5.6-sol",
    modelDisplayName: "5.6 Sol",
    supportedEfforts: ["low", "medium", "high", "xhigh", "ultra"],
    modelCatalog: catalog
  });
  trigger.getAttribute = (name: string) => ({
    "data-codex-intelligence-trigger": "true",
    "data-composer-navigation-target": "reasoning",
    "data-selected-reasoning-effort": "stale-transition"
  } as Record<string, string>)[name] ?? null;
  assert.equal(readMetadata(
    [trigger], { memoizedProps: { value: queryClient }, dependencies: null, child: null, sibling: null },
    visible, () => false
  ), undefined, "a stale visible effort outside the matched model's catalog fails closed");
});

test("model catalog rejects authority beyond public bounds or with conflicting complete records", () => {
  const readCatalog = Reflect.get(microBridgeModule, "readReasoningModelCatalog") as (
    queryClients: Iterable<unknown>
  ) => unknown;
  const record = (index: number, efforts = 1) => ({
    displayName: `GPT-Model-${index}`,
    model: `model-${index}`,
    supportedReasoningEfforts: Array.from({ length: efforts }, (_, effort) => ({
      reasoningEffort: `effort-${effort}`
    }))
  });
  const client = (records: unknown[]) => new ReasoningQueryClientFixture([
    [["models", "list"], { data: records }]
  ]);
  const maximumCatalog = readCatalog([client(Array.from({ length: 32 }, (_, index) =>
    record(index, index === 0 ? 16 : 1)))]) as unknown[];
  assert.equal(maximumCatalog.length, 32);
  assert.equal((maximumCatalog[0] as { supportedReasoningEfforts: unknown[] })
    .supportedReasoningEfforts.length, 16);
  assert.equal(readCatalog([client(Array.from({ length: 33 }, (_, index) => record(index)))]), undefined);
  assert.equal(readCatalog([client([record(0, 17)])]), undefined);
  assert.equal(readCatalog([client([record(0), { ...record(0), displayName: "GPT-Other" }])]), undefined);
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

test("timed-out reasoning evaluations cannot poison the mutex after reconnect", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const testBridge = bridge as unknown as {
    socket?: { readyState: number; send: (raw: string) => void; close: () => void };
    handleMessage: (raw: string) => void;
  };
  const namespaces: string[] = [];
  let firstRequestId: number | undefined;
  const sockets: Array<{ readyState: number; send: (raw: string) => void; close: () => void }> = [];
  const makeSocket = () => {
    const socket = {
      readyState: 1,
      send(raw: string) {
        const request = JSON.parse(raw) as { id: number; params: { expression: string } };
        const encodedNamespace = request.params.expression.match(/const guardNamespace = ("[^"]+")/)?.[1];
        assert.ok(encodedNamespace, "reasoning evaluation carries a renderer guard namespace");
        const namespace = JSON.parse(encodedNamespace) as string;
        namespaces.push(namespace);
        if (namespaces.length === 1) {
          firstRequestId = request.id;
          return;
        }
        if (namespace === namespaces[0]) return;
        testBridge.handleMessage(JSON.stringify({
          id: request.id,
          result: { result: { value: { outcome: "blocked-ultra", reasoningEffort: "max" } } }
        }));
      },
      close() { socket.readyState = 3; }
    };
    sockets.push(socket);
    return socket;
  };
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { callback: (...args: unknown[]) => void; args: unknown[]; delay: number }>();
  let nextTimerId = 0;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, args, delay });
    return id as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: NodeJS.Timeout | number | undefined) => {
    timers.delete(Number(timer));
  }) as typeof clearTimeout;
  const waitForRequest = async (count: number) => {
    for (let attempt = 0; attempt < 8 && namespaces.length < count; attempt++) await Promise.resolve();
    assert.equal(namespaces.length, count, `fake CDP received Runtime.evaluate request ${count}`);
  };

  try {
    testBridge.socket = makeSocket();
    const first = bridge.adjustReasoning("increase", { includeUltra: false });
    await waitForRequest(1);
    assert.equal(timers.size, 1);
    const timeout = [...timers.entries()][0]!;
    assert.equal(timeout[1].delay, 5000, "the real bridge evaluation timeout is under manual control");
    timers.delete(timeout[0]);
    timeout[1].callback(...timeout[1].args);
    await assert.rejects(first, /Codex-Runtime-Antwort hat zu lange gedauert\./);
    assert.equal(sockets[0]?.readyState, 3, "the timed-out adjustment disconnects its CDP socket");

    testBridge.socket = makeSocket();
    const second = bridge.adjustReasoning("increase", { includeUltra: false });
    await waitForRequest(2);
    assert.equal(timers.size, 0, "the reconnected renderer is not blocked behind the old guard tail");
    assert.deepEqual(await second, { outcome: "blocked-ultra", reasoningEffort: "max" });
    assert.notEqual(namespaces[1], namespaces[0], "reconnect uses a fresh renderer guard namespace");

    assert.ok(firstRequestId);
    testBridge.handleMessage(JSON.stringify({
      id: firstRequestId,
      result: { result: { value: { outcome: "blocked-ultra", reasoningEffort: "max" } } }
    }));
    const third = bridge.adjustReasoning("increase", { includeUltra: false });
    await waitForRequest(3);
    assert.deepEqual(await third, { outcome: "blocked-ultra", reasoningEffort: "max" });
    assert.equal(namespaces[2], namespaces[1], "late old completion stays isolated from the new namespace");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
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
  const reasoningCommands: string[] = [];
  for (const testCase of [
    { direction: "increase" as const, policy: undefined },
    { direction: "decrease" as const, policy: { includeUltra: false } },
    { direction: "increase" as const, policy: { includeUltra: true } }
  ]) {
    const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
    const harness = createGuardedRendererHarness({ currentEffort: "medium", advanceEffortOnCommand: true });
    const testBridge = bridge as unknown as {
      ensureConnected: () => Promise<void>;
      evaluate: <T>(source: string) => Promise<T>;
    };
    testBridge.ensureConnected = async () => {};
    testBridge.evaluate = harness.evaluate;
    await bridge.adjustReasoning(testCase.direction, testCase.policy);
    reasoningCommands.push(...harness.runnerCalls.map(([command]) => command));
  }

  assert.deepEqual(reasoningCommands, [
    "composer.increaseReasoningEffort",
    "composer.decreaseReasoningEffort",
    "composer.increaseReasoningEffort"
  ]);
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  const adjustment = source.match(/async adjustReasoning\([\s\S]*?\n  }/)?.[0] ?? "";
  assert.doesNotMatch(adjustment, /ENC_CW|ENC_CC|this\.dispatch/);
});

test("restricted increases use one atomic renderer evaluation and lazily skip the command when blocked", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const expressions: string[] = [];
  const directCommands: string[] = [];
  const results = [
    { outcome: "blocked-ultra", reasoningEffort: "max" },
    { outcome: "applied", reasoningEffort: "xhigh" }
  ] as const;
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

  assert.deepEqual(await bridge.adjustReasoning("increase", { includeUltra: false }), results[0]);
  assert.deepEqual(directCommands, [], "blocked guarded increases do not enter the separate command path");
  assert.equal(expressions.length, 1, "guard state and command path share one Runtime.evaluate");
  assert.deepEqual(await bridge.adjustReasoning("increase", { includeUltra: false }), results[1]);
  assert.deepEqual(directCommands, [], "lower guarded increases run inside the atomic renderer evaluation");
  assert.equal(expressions.length, 2);

  for (const expression of expressions) {
    assert.match(expression,
      /\[data-codex-intelligence-trigger="true"\]\[data-composer-navigation-target="reasoning"\]/);
    assert.match(expression, /data-selected-reasoning-effort/);
    assert.match(expression, /querySelectorAll\?\.\(["']\*["']\)/);
    assert.match(expression, /displayName/);
    assert.doesNotMatch(expression, /selectedValue/);
    assert.match(expression, /seen\.size\s*<\s*(?:30000|3e4)/);
    assert.match(expression, /getQueriesData/);
    assert.match(expression, /structuredClone\(value\)/);
    assert.doesNotMatch(expression, /getQueryCache\(\)\.getAll\(\)/);
    assert.match(expression, /queryKey\[0\][^;]*["']models["']/);
    assert.match(expression, /queryKey\[1\][^;]*["']list["']/);
    assert.equal((expression.match(/commandRunner\(command, 'codex_micro_hid'\)/g) ?? []).length, 1,
      "the applicable renderer branch issues exactly one reasoning command");
    const blockedReturn = expression.indexOf("if (plan.kind === 'blocked-ultra')");
    const runnerResolution = expression.indexOf("const commandRunner = await resolveCommandRunner");
    assert.ok(blockedReturn >= 0 && runnerResolution > blockedReturn,
      "the blocked result returns before resolving or importing a command runner");
    const finalDecision = expression.indexOf("plan = planFromMetadata(metadata)", runnerResolution);
    const commandInvocation = expression.indexOf("commandRunner(command, 'codex_micro_hid')");
    assert.ok(runnerResolution < finalDecision && finalDecision < commandInvocation,
      "the final live decision follows runner resolution and immediately precedes invocation");
    assert.doesNotMatch(expression.slice(finalDecision, commandInvocation), /\bawait\b/,
      "no await may separate the final live decision from command invocation");
    const mutexAppend = expression.indexOf("guardState.tail = new Promise");
    const mutexAwait = expression.indexOf("await predecessor");
    assert.ok(mutexAppend >= 0 && mutexAppend < mutexAwait,
      "the renderer-global mutex is appended synchronously before its first await");
    assert.match(expression, /guardNamespace/);
    assert.match(expression, /guardState\.uncertain/);
    assert.match(expression, /finally\s*\{\s*releaseGuard\(\)/);
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
    return "metadata-unavailable" as T;
  };
  testBridge.runReasoningCommand = async (command) => { directCommands.push(command); };

  await assert.rejects(
    bridge.adjustReasoning("increase", { includeUltra: false }),
    /Codex reasoning metadata is unavailable\./
  );
  assert.equal(expressions.length, 1);
  assert.deepEqual(directCommands, []);
});

test("serialized guarded reasoning returns the authoritative max when it blocks Ultra", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({ currentEffort: "max" });
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;

  assert.deepEqual(await bridge.adjustReasoning("increase", { includeUltra: false }), {
    outcome: "blocked-ultra", reasoningEffort: "max"
  });
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

test("serialized metadata refusal preserves the established renderer transport", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({ currentEffort: undefined });
  let disconnects = 0;
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
    disconnect: () => void;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;
  testBridge.disconnect = () => { disconnects++; };

  await assert.rejects(
    bridge.adjustReasoning("increase", { includeUltra: false }),
    (error: Error) => {
      assert.equal(error.message, "Codex reasoning metadata is unavailable.");
      return true;
    }
  );
  assert.equal(disconnects, 0);
  assert.deepEqual(harness.runnerCalls, []);
});

test("serialized guarded reasoning returns the effort only after the visible trigger confirms it", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({
    currentEffort: "high",
    advanceEffortOnCommand: true
  });
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;

  assert.deepEqual(await bridge.adjustReasoning("increase", { includeUltra: false }), {
    outcome: "applied", reasoningEffort: "xhigh"
  });
  assert.deepEqual(harness.runnerCalls, [["composer.increaseReasoningEffort", "codex_micro_hid"]]);
});

test("serialized reasoning awaits a bounded macrotask DOM confirmation", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({
    currentEffort: "high",
    advanceEffortOnCommand: true,
    confirmationDelayMs: 0
  });
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;

  assert.deepEqual(await bridge.adjustReasoning("increase", { includeUltra: false }), {
    outcome: "applied", reasoningEffort: "xhigh"
  });
  assert.deepEqual(harness.runnerCalls, [["composer.increaseReasoningEffort", "codex_micro_hid"]]);
});

test("serialized unrestricted and decrease commands return confirmed reasoning efforts", async () => {
  for (const testCase of [
    { direction: "increase" as const, currentEffort: "high", expectedEffort: "xhigh" },
    { direction: "decrease" as const, currentEffort: "high", expectedEffort: "medium" }
  ]) {
    const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
    const harness = createGuardedRendererHarness({
      currentEffort: testCase.currentEffort,
      advanceEffortOnCommand: true
    });
    const testBridge = bridge as unknown as {
      ensureConnected: () => Promise<void>;
      evaluate: <T>(source: string) => Promise<T>;
    };
    testBridge.ensureConnected = async () => {};
    testBridge.evaluate = harness.evaluate;

    assert.deepEqual(await bridge.adjustReasoning(testCase.direction), {
      outcome: "applied", reasoningEffort: testCase.expectedEffort
    });
    assert.equal(harness.runnerCalls.length, 1);
  }
});

test("serialized interior commands fail without a unique safe visible-trigger confirmation", async () => {
  for (const options of [
    {},
    { confirmationEffortOnCommand: "not safe" },
    { advanceEffortOnCommand: true, confirmationTriggerCount: 2 }
  ]) {
    const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
    const harness = createGuardedRendererHarness({ currentEffort: "high", ...options });
    const testBridge = bridge as unknown as {
      ensureConnected: () => Promise<void>;
      evaluate: <T>(source: string) => Promise<T>;
    };
    testBridge.ensureConnected = async () => {};
    testBridge.evaluate = harness.evaluate;

    await assert.rejects(
      bridge.adjustReasoning("increase"),
      /Codex reasoning metadata is unavailable\./
    );
    assert.equal(harness.runnerCalls.length, 1);
  }
});

test("serialized proven boundary no-ops return the unchanged authoritative effort without a command", async () => {
  for (const testCase of [
    { direction: "decrease" as const, currentEffort: "low" },
    { direction: "increase" as const, currentEffort: "ultra" }
  ]) {
    const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
    const harness = createGuardedRendererHarness({ currentEffort: testCase.currentEffort });
    const testBridge = bridge as unknown as {
      ensureConnected: () => Promise<void>;
      evaluate: <T>(source: string) => Promise<T>;
    };
    testBridge.ensureConnected = async () => {};
    testBridge.evaluate = harness.evaluate;

    assert.deepEqual(await bridge.adjustReasoning(testCase.direction), {
      outcome: "applied", reasoningEffort: testCase.currentEffort
    });
    assert.deepEqual(harness.runnerCalls, []);
  }
});

test("serialized guarded reasoning validates a current five-part key before a boundary no-op", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({
    currentEffort: "low",
    queryKey: ["models", "list", "local", "chatgpt", 100]
  });
  let expression = "";
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = async <T>(source: string): Promise<T> => {
    expression = source;
    return await harness.evaluate<T>(source);
  };

  assert.deepEqual(await bridge.adjustReasoning("decrease", { includeUltra: false }), {
    outcome: "applied", reasoningEffort: "low"
  });
  assert.deepEqual(harness.runnerCalls, []);
  assert.match(expression, /const readExactBoundedOwnDataArray = \(/,
    "the evaluated renderer expression includes exact query-key validation");
});

test("concurrent serialized guarded increases recheck live effort immediately before invoking the runner", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({
    currentEffort: "xhigh",
    supportedEfforts: ["xhigh", "max", "ultra"],
    advanceEffortOnCommand: true
  });
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;

  const first = bridge.adjustReasoning("increase", { includeUltra: false });
  const second = bridge.adjustReasoning("increase", { includeUltra: false });
  const results = await Promise.all([first, second]);

  assert.deepEqual(results, [
    { outcome: "applied", reasoningEffort: "max" },
    { outcome: "blocked-ultra", reasoningEffort: "max" }
  ]);
  assert.deepEqual(harness.runnerCalls, [["composer.increaseReasoningEffort", "codex_micro_hid"]]);
  assert.equal(harness.currentEffort(), "max");
});

test("an unconfirmed guarded transition fails and reserves its prior state against later increases", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({
    currentEffort: "xhigh",
    supportedEfforts: ["xhigh", "max", "ultra"]
  });
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;

  await assert.rejects(
    bridge.adjustReasoning("increase", { includeUltra: false }),
    /Codex reasoning metadata is unavailable\./
  );
  await assert.rejects(
    bridge.adjustReasoning("increase", { includeUltra: false }),
    /Codex reasoning metadata is unavailable\./
  );
  assert.deepEqual(harness.runnerCalls, [["composer.increaseReasoningEffort", "codex_micro_hid"]]);
  assert.equal(harness.currentEffort(), "xhigh");
});

test("a failed confirmation read reserves the prior state before releasing the guard", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const harness = createGuardedRendererHarness({
    currentEffort: "xhigh",
    supportedEfforts: ["xhigh", "max", "ultra"],
    failConfirmationReadAfterCommand: true
  });
  const testBridge = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: <T>(source: string) => Promise<T>;
  };
  testBridge.ensureConnected = async () => {};
  testBridge.evaluate = harness.evaluate;

  await assert.rejects(
    bridge.adjustReasoning("increase", { includeUltra: false }),
    /Codex reasoning metadata is unavailable\./
  );
  assert.equal(harness.runnerCalls.length, 1);

  harness.restoreMetadataReads();
  await assert.rejects(
    bridge.adjustReasoning("increase", { includeUltra: false }),
    /Codex reasoning metadata is unavailable\./
  );
  assert.equal(harness.runnerCalls.length, 1);
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
    return { outcome: "blocked-ultra", reasoningEffort: "max" } as T;
  };

  await bridge.adjustReasoning("increase", { includeUltra: false });

  for (const helper of [
    "isSafeReasoningIdentifier",
    "readOwnDataProperty",
    "readDataPropertyInPrototypeChain",
    "isCloneableReasoningQueryClient",
    "readBoundedOwnDataArray",
    "readExactBoundedOwnDataArray",
    "isStructuredCloneSafePlainData",
    "normalizeReasoningEffortOrder",
    "normalizeReasoningModelLabel",
    "isVisibleReasoningTrigger",
    "isExplicitlyHiddenReasoningElement",
    "readVisibleReasoningModelLabels",
    "findRendererQueryClients",
    "readReasoningModelCatalogMatch",
    "readActiveReasoningMetadata",
    "decideReasoningAdjustment",
    "readConfirmedReasoningEffort",
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
    return (source.includes("composer.increaseReasoningEffort") || source.includes("composer.decreaseReasoningEffort")
      ? { outcome: "applied", reasoningEffort: "high" }
      : true) as T;
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
