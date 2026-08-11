import assert from "node:assert/strict";
import test from "node:test";
import streamDeck, { type DialAction, type KeyAction } from "@elgato/streamdeck";
import { DeckController } from "../src/controller.js";
import { expandDialPreset, type DialCommandQueue } from "../src/dial-domain.js";
import type {
  CodexDialSettings, DialRuntimeState, ModelPresetEntry, ModelPresetsDialSettings
} from "../src/dial-types.js";
import type {
  CodexHost, HostHealth, MicroSnapshot, ModelPresetExecution, ModelPresetRequest,
  ReasoningAdjustmentPolicy, ReasoningAdjustmentExecution, ReasoningAdjustmentResult, RoutedAgentSlot
} from "../src/types.js";

type FakeDial = DialAction<CodexDialSettings> & {
  feedbackCalls: unknown[];
  triggerCalls: unknown[];
  alerts: number;
};

type DialRegistrationProbe = {
  settings: CodexDialSettings;
  state: DialRuntimeState;
  queue: DialCommandQueue;
};

type ControllerProbe = {
  dials: Map<string, DialRegistrationProbe>;
  routedSlots: RoutedAgentSlot[];
  localHost?: CodexHost;
  localSnapshot?: { host: CodexHost; observedAt: number; snapshot: MicroSnapshot };
  localHealth: HostHealth;
  targetHostId?: string;
  targetPlatform: CodexHost["platform"];
  localSnapshotGeneration: number;
  relayClient?: {
    currentHost(): CodexHost | undefined;
    currentHealth(): HostHealth;
    currentSnapshot(): { host: CodexHost; observedAt: number; snapshot: MicroSnapshot } | undefined;
    supportsCurrentReadyCapability?(capability: string): boolean;
    send(command: unknown): Promise<void | ReasoningAdjustmentResult | ReasoningAdjustmentExecution>;
  };
  microBridge: {
    sendAgent(slot: number, act: 0 | 1, threadKey?: string): Promise<void>;
    sendAction?(slot: string, act: 0 | 1): Promise<void>;
    sendEncoder?(act: 0 | 1): Promise<void>;
    sendJoystick?(direction: string, distance: 0 | 1): Promise<void>;
    adjustReasoning?(
      direction: string,
      policy?: ReasoningAdjustmentPolicy
    ): Promise<ReasoningAdjustmentExecution>;
    applyModelPreset?(request: ModelPresetRequest): Promise<ModelPresetExecution>;
    runKeycap?(keycapId: string): Promise<void>;
    consumeRateLimitReset?(): Promise<void>;
    refresh?(): Promise<MicroSnapshot>;
    close?(): void;
  };
  keycapImages: Map<string, Promise<string | null>>;
  pressedAgents: Map<number, unknown>;
  dialDescriptionErrors: Set<string>;
  dialRenderErrors: Set<string>;
  dialSuccessErrors: Set<string>;
  refresh(): Promise<void>;
  adjustLocalReasoningFromRelay(
    direction: "decrease" | "increase",
    policy?: ReasoningAdjustmentPolicy
  ): Promise<ReasoningAdjustmentExecution>;
  sendDialToHost(
    route: { kind: "host"; hostId?: string; platform: CodexHost["platform"] },
    command: unknown,
    local: () => Promise<unknown>,
    requireReady?: boolean
  ): Promise<ReasoningAdjustmentResult | ReasoningAdjustmentExecution | undefined>;
  refreshInFlight?: Promise<void>;
  refreshLocalUsage(): Promise<MicroSnapshot>;
  renderAll(): Promise<void>;
  renderMicroAction(registration: { action: KeyAction; slot: "ACT06" }): Promise<void>;
  renderFixedAction(registration: {
    action: KeyAction;
    source: { kind: "local"; keycapId: string };
  }): Promise<void>;
  catalogRevision: number;
};

const HOST: CodexHost = {
  hostId: "host-a",
  hostName: "Mac",
  platform: "darwin"
};

const REMOTE_HOST: CodexHost = {
  hostId: "host-b",
  hostName: "Windows",
  platform: "win32"
};

const SNAPSHOT: MicroSnapshot = {
  slots: [],
  layout: {
    version: 1,
    slots: {
      ACT06: { keycapId: "APPR" }, ACT07: { keycapId: "REJ" },
      ACT08: { keycapId: "SPLIT" }, ACT09: { keycapId: "MIC" },
      ACT10_ACT11: { keycapId: "CODEX" }, ACT12: { keycapId: "SETUP" }
    },
    analogStick: { up: {}, right: {}, down: {}, left: {} }
  },
  agentSource: "recent",
  lightingAutoOff: "off",
  theme: "dark",
  usage: {
    windows: [{
      id: "five-hour", kind: "five-hour", usedPercent: 20, remainingPercent: 80,
      windowDurationMins: 300, resetsAt: 50_000
    }],
    observedAt: 1_000,
    resetCreditsAvailable: 1,
    resetCreditsApplicable: 1
  }
};

function fakeDial(
  id: string,
  options: {
    rejectDescriptions?: boolean;
    rejectSuccessFeedback?: boolean;
    rejectUltraFeedback?: boolean;
    descriptionError?: string;
  } = {}
): FakeDial {
  const dial = {
    id,
    feedbackCalls: [] as unknown[],
    triggerCalls: [] as unknown[],
    alerts: 0,
    async setFeedback(payload: unknown) {
      this.feedbackCalls.push(payload);
      if (options.rejectSuccessFeedback && JSON.stringify(payload).includes("RESET COMPLETE")) {
        throw new Error("success feedback unavailable");
      }
      if (options.rejectUltraFeedback && JSON.stringify(payload).includes("ULTRA OFF")) {
        throw new Error("Ultra feedback unavailable");
      }
    },
    async setTriggerDescription(payload: unknown) {
      this.triggerCalls.push(payload);
      if (options.descriptionError) throw new Error(options.descriptionError);
      if (options.rejectDescriptions) throw new Error("description unavailable");
    },
    async showAlert() { this.alerts += 1; }
  };
  return dial as unknown as FakeDial;
}

type FakeKey = KeyAction & { images: string[]; titles: string[] };

function fakeKey(id: string): FakeKey {
  const images: string[] = [];
  const titles: string[] = [];
  return {
    id,
    images,
    titles,
    async setImage(image: string) { images.push(image); },
    async setTitle(title: string) { titles.push(title); }
  } as unknown as FakeKey;
}

function snapshotWithFast(fastModeEnabled: boolean | undefined, act06 = "FAST"): MicroSnapshot {
  const snapshot: MicroSnapshot = {
    ...SNAPSHOT,
    layout: {
      ...SNAPSHOT.layout,
      slots: {
        ...SNAPSHOT.layout.slots,
        ACT06: { keycapId: act06 }
      }
    }
  };
  if (fastModeEnabled !== undefined) snapshot.fastModeEnabled = fastModeEnabled;
  return snapshot;
}

const MODEL_CATALOG = [
  {
    modelId: "gpt-5.6-sol", displayName: "5.6 Sol",
    supportedReasoningEfforts: ["medium", "high"]
  },
  {
    modelId: "gpt-5.6-terra", displayName: "5.6 Terra",
    supportedReasoningEfforts: ["medium"]
  }
];

function modelSnapshot(modelId = "gpt-5.6-sol", reasoningEffort = "high"): MicroSnapshot {
  const activeModelDisplayName = modelId === "gpt-5.6-terra" ? "5.6 Terra" : "5.6 Sol";
  return {
    ...structuredClone(SNAPSHOT),
    activeModelId: modelId,
    activeModelDisplayName,
    reasoningEffort,
    modelCatalog: structuredClone(MODEL_CATALOG)
  };
}

function modelPresetSettings(entries: ModelPresetEntry[] = [
  { modelId: "gpt-5.6-sol", reasoningEffort: "high" },
  { modelId: "gpt-5.6-sol", reasoningEffort: "medium" },
  { modelId: "gpt-5.6-terra", reasoningEffort: "medium" }
]): ModelPresetsDialSettings {
  return { ...expandDialPreset("model-presets"), modelPresets: entries } as ModelPresetsDialSettings;
}

function decodeImage(image: string): string {
  return decodeURIComponent(image.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function probe(controller: DeckController): ControllerProbe {
  return controller as unknown as ControllerProbe;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function idle(controller: DeckController, actionId: string): Promise<void> {
  await probe(controller).dials.get(actionId)!.queue.idle();
  await settle();
}

function routedAgent(id: number, threadKey: string, host = HOST): RoutedAgentSlot {
  return {
    id,
    sourceSlot: id,
    threadKey,
    title: `Task ${threadKey}`,
    status: "idle",
    selected: false,
    observedAt: 1_000,
    host
  };
}

test("registration normalizes settings, caches feedback, and survives description failures", async () => {
  const controller = new DeckController();
  const action = fakeDial("normalized", { rejectDescriptions: true });

  controller.registerDial(action, { shell: "rm" });
  await settle();
  assert.deepEqual(probe(controller).dials.get(action.id)!.settings, expandDialPreset("reasoning"));
  assert.equal(action.feedbackCalls.length, 1, "description failure must not block feedback");

  controller.updateDialSettings(action, { shell: "rm" });
  await settle();
  assert.deepEqual(probe(controller).dials.get(action.id)!.settings, expandDialPreset("reasoning"));
  assert.equal(action.feedbackCalls.length, 1, "unchanged feedback is not rewritten");
});

test("only effective FAST keycaps render live state and state changes replace cached images", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(true) };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  const microFast = fakeKey("micro-fast");
  const microOther = fakeKey("micro-other");
  const officialFast = fakeKey("official-fast");
  const officialOther = fakeKey("official-other");

  controller.registerMicroAction("ACT06", microFast);
  controller.registerMicroAction("ACT07", microOther);
  controller.registerFixedAction("FAST", officialFast, { kind: "local", keycapId: "FAST" });
  controller.registerFixedAction("APPR", officialOther, { kind: "local", keycapId: "APPR" });
  await state.renderAll();

  assert.match(decodeImage(microFast.images.at(-1)!), /data-toggle-state="on"/);
  assert.match(decodeImage(officialFast.images.at(-1)!), /data-toggle-state="on"/);
  assert.match(decodeImage(microOther.images.at(-1)!), /data-toggle-state="unknown"/);
  assert.match(decodeImage(officialOther.images.at(-1)!), /data-toggle-state="unknown"/);

  const priorMicroImage = microFast.images.at(-1)!;
  const priorOfficialImage = officialFast.images.at(-1)!;
  state.localSnapshot = { host: HOST, observedAt: 2_000, snapshot: snapshotWithFast(false) };
  await state.renderAll();

  assert.match(decodeImage(microFast.images.at(-1)!), /data-toggle-state="off"/);
  assert.match(decodeImage(officialFast.images.at(-1)!), /data-toggle-state="off"/);
  assert.notEqual(microFast.images.at(-1), priorMicroImage, "Micro FAST setImage changes with authoritative state");
  assert.notEqual(officialFast.images.at(-1), priorOfficialImage, "official FAST setImage changes with authoritative state");

  state.localSnapshot = { host: HOST, observedAt: 3_000, snapshot: snapshotWithFast(true, "APPR") };
  await state.renderAll();
  assert.match(decodeImage(microFast.images.at(-1)!), /data-toggle-state="unknown"/);
  assert.match(decodeImage(officialFast.images.at(-1)!), /data-toggle-state="on"/);
});

test("a delayed Micro FAST render cannot overwrite newer authoritative feedback", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeKey("ordered-micro-fast");
  const delayedOn = deferred<string | null>();
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(true) };
  state.keycapImages.set("dark:FAST:on", delayedOn.promise);
  state.keycapImages.set("dark:FAST:off", Promise.resolve("fast-off"));

  const olderRender = state.renderMicroAction({ action, slot: "ACT06" });
  state.localSnapshot = { host: HOST, observedAt: 2_000, snapshot: snapshotWithFast(false) };
  await state.renderMicroAction({ action, slot: "ACT06" });
  assert.deepEqual(action.images, ["fast-off"]);

  delayedOn.resolve("fast-on");
  await olderRender;
  assert.deepEqual(action.images, ["fast-off"], "the obsolete ON render is discarded");
});

test("a delayed fixed FAST render cannot overwrite newer authoritative feedback", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeKey("ordered-fixed-fast");
  const delayedOn = deferred<string | null>();
  const registration = { action, source: { kind: "local" as const, keycapId: "FAST" } };
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(true) };
  state.keycapImages.set("dark:FAST:on", delayedOn.promise);
  state.keycapImages.set("dark:FAST:off", Promise.resolve("fast-off"));

  const olderRender = state.renderFixedAction(registration);
  state.localSnapshot = { host: HOST, observedAt: 2_000, snapshot: snapshotWithFast(false) };
  await state.renderFixedAction(registration);
  assert.deepEqual(action.images, ["fast-off"]);

  delayedOn.resolve("fast-on");
  await olderRender;
  assert.deepEqual(action.images, ["fast-off"], "the obsolete fixed ON render is discarded");
});

test("successful local FAST activation refreshes immediately without refreshing releases or other actions", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const commands: string[] = [];
  let refreshes = 0;
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(false) };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async sendAction(slot, act) { commands.push(`action:${slot}:${act}`); },
    async runKeycap(keycapId) { commands.push(`keycap:${keycapId}`); }
  };
  state.refresh = async () => { refreshes += 1; };

  await controller.sendMicroAction("ACT06", 1);
  await controller.sendMicroAction("ACT06", 0);
  await controller.sendMicroAction("ACT07", 1);
  await controller.runKeycap("FAST");
  await controller.runKeycap("APPR");

  assert.deepEqual(commands, [
    "action:ACT06:1", "action:ACT06:0", "action:ACT07:1", "keycap:FAST", "keycap:APPR"
  ]);
  assert.equal(refreshes, 2, "only the local Micro FAST down and official FAST activation refresh");
  assert.equal(state.localSnapshot.snapshot.fastModeEnabled, false, "commands never optimistically flip state");
});

test("remote, failed, and failed-refresh FAST commands never synthesize local state", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const remoteCommands: unknown[] = [];
  let refreshes = 0;
  state.localHost = HOST;
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(false) };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async sendAction() { throw new Error("local FAST failed"); },
    async runKeycap() { throw new Error("local FAST failed"); }
  };
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => undefined,
    async send(command) { remoteCommands.push(command); }
  };
  state.refresh = async () => { refreshes += 1; };

  await controller.sendMicroAction("ACT06", 1);
  await controller.runKeycap("FAST");
  assert.equal(refreshes, 0, "remote relay commands own their snapshot barrier");

  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  await assert.rejects(controller.sendMicroAction("ACT06", 1), /local FAST failed/);
  await assert.rejects(controller.runKeycap("FAST"), /local FAST failed/);
  assert.equal(refreshes, 0, "failed commands do not refresh");
  assert.equal(state.localSnapshot.snapshot.fastModeEnabled, false);

  state.microBridge = { async sendAgent() {}, async runKeycap() {} };
  state.refresh = async () => { throw new Error("authoritative refresh failed"); };
  await assert.rejects(controller.runKeycap("FAST"), /authoritative refresh failed/);
  assert.equal(state.localSnapshot.snapshot.fastModeEnabled, false, "failed refresh preserves last authoritative value");
  assert.equal(remoteCommands.length, 2);
});

test("local dial touch FAST uses the command path and refreshes its authoritative state", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("touch-fast-refresh");
  const keycaps: string[] = [];
  let refreshes = 0;
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(false) };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async runKeycap(keycapId) { keycaps.push(keycapId); }
  };
  state.refresh = async () => { refreshes += 1; };

  controller.registerDial(action, { ...expandDialPreset("custom"), touchTap: "keycap.FAST" });
  await controller.touchDial(action);

  assert.deepEqual(keycaps, ["FAST"]);
  assert.equal(refreshes, 1);
  assert.equal(state.localSnapshot.snapshot.fastModeEnabled, false);
});

test("local FAST activation queues a post-command snapshot behind an older refresh", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const keycaps: string[] = [];
  let postCommandRefreshes = 0;
  let releaseOlderRefresh!: () => void;
  const olderRefresh = new Promise<void>((resolve) => { releaseOlderRefresh = resolve; });
  const trackedOlderRefresh = olderRefresh.finally(() => { state.refreshInFlight = undefined; });
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(false) };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async runKeycap(keycapId) { keycaps.push(keycapId); }
  };
  state.refreshInFlight = trackedOlderRefresh;
  state.refresh = async () => {
    if (state.refreshInFlight) return state.refreshInFlight;
    postCommandRefreshes += 1;
  };

  const activation = controller.runKeycap("FAST");
  await settle();
  assert.deepEqual(keycaps, ["FAST"]);
  assert.equal(postCommandRefreshes, 0, "the activation first lets the older snapshot finish");

  releaseOlderRefresh();
  await activation;
  assert.equal(postCommandRefreshes, 1, "a new authoritative read starts after the command");
});

test("local FAST activation refreshes after an older refresh rejects", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  let postCommandRefreshes = 0;
  let rejectOlderRefresh!: (error: Error) => void;
  const olderRefresh = new Promise<void>((_resolve, reject) => { rejectOlderRefresh = reject; })
    .finally(() => { state.refreshInFlight = undefined; });
  void olderRefresh.catch(() => {});
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(false) };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = { async sendAgent() {}, async runKeycap() {} };
  state.refreshInFlight = olderRefresh;
  state.refresh = async () => {
    if (state.refreshInFlight) return state.refreshInFlight;
    postCommandRefreshes += 1;
  };

  const activation = controller.runKeycap("FAST");
  await settle();
  assert.equal(postCommandRefreshes, 0);
  rejectOlderRefresh(new Error("older render failed"));
  await assert.doesNotReject(activation);
  assert.equal(postCommandRefreshes, 1, "the rejected older read cannot suppress the post-command read");
});

test("concurrent FAST activations do not refresh after shutdown while awaiting an older refresh", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const olderRefresh = deferred<void>();
  const trackedOlderRefresh = olderRefresh.promise.finally(() => { state.refreshInFlight = undefined; });
  let commands = 0;
  let refreshes = 0;
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: snapshotWithFast(false) };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async runKeycap() { commands += 1; },
    async refresh() {
      refreshes += 1;
      return snapshotWithFast(true);
    },
    close() {}
  };
  state.refreshInFlight = trackedOlderRefresh;

  const activations = [controller.runKeycap("FAST"), controller.runKeycap("FAST")];
  await settle();
  assert.equal(commands, 2);
  assert.equal(refreshes, 0);

  controller.stop();
  olderRefresh.resolve();
  await Promise.all(activations);
  assert.equal(refreshes, 0, "shutdown prevents every queued post-command refresh");
});

test("selector rotation previews only and selector state stays isolated per action", async () => {
  const controller = new DeckController();
  const first = fakeDial("usage-first");
  const second = fakeDial("usage-second");
  let refreshes = 0;
  (controller as unknown as { refreshUsage(): Promise<void> }).refreshUsage = async () => { refreshes += 1; };

  controller.registerDial(first, expandDialPreset("usage"));
  controller.registerDial(second, expandDialPreset("usage"));
  controller.rotateDial(first, 1);
  await idle(controller, first.id);

  assert.equal(refreshes, 0, "selector rotation must not execute an action");
  assert.equal(probe(controller).dials.get(first.id)!.state.usageMode, "five-hour");
  assert.equal(probe(controller).dials.get(second.id)!.state.usageMode, "auto");

  await controller.beginDialPress(first);
  assert.equal(probe(controller).dials.get(first.id)!.state.usageOverview, true);
  assert.equal(probe(controller).dials.get(second.id)!.state.usageOverview, false);
});

test("agent selector release uses the identity resolved on dial down", async () => {
  const controller = new DeckController();
  const action = fakeDial("agent-selector");
  const calls: Array<[number, 0 | 1, string | undefined]> = [];
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.routedSlots = [routedAgent(0, "thread-a"), routedAgent(1, "thread-b")];
  state.microBridge = {
    async sendAgent(slot, act, threadKey) { calls.push([slot, act, threadKey]); }
  };

  controller.registerDial(action, expandDialPreset("agents"));
  await controller.beginDialPress(action);
  controller.rotateDial(action, 1);
  await idle(controller, action.id);
  await controller.finishDialPress(action);

  assert.deepEqual(calls, [
    [0, 1, "thread-a"],
    [0, 0, "thread-a"]
  ]);
});

test("agent selector accepts merged-list reorder while retaining its captured owner", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("agent-reorder");
  const calls: Array<[number, 0 | 1, string | undefined]> = [];
  let releaseBacklog!: () => void;
  const backlog = new Promise<void>((resolve) => { releaseBacklog = resolve; });
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.routedSlots = [routedAgent(0, "thread-a"), routedAgent(1, "thread-b")];
  state.microBridge = {
    async sendAgent(slot, act, threadKey) { calls.push([slot, act, threadKey]); }
  };
  controller.registerDial(action, expandDialPreset("agents"));
  probe(controller).dials.get(action.id)!.queue.enqueue(() => backlog);
  const down = controller.beginDialPress(action);
  const second = routedAgent(0, "thread-b");
  const first = routedAgent(1, "thread-a");
  first.sourceSlot = 0;
  state.routedSlots = [second, first];
  releaseBacklog();
  await down;
  await controller.finishDialPress(action);

  assert.deepEqual(calls, [[0, 1, "thread-a"], [0, 0, "thread-a"]]);
  assert.equal(action.alerts, 0);
});

test("paired detents continue after a dispatch failure and alert only the failing command", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-errors");
  const attempts: string[] = [];
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() {
      attempts.push(`attempt-${attempts.length + 1}`);
      if (attempts.length === 1) throw new Error("first detent failed");
      return { outcome: "applied" };
    }
  };

  controller.registerDial(action, expandDialPreset("reasoning"));
  controller.rotateDial(action, 2);
  await idle(controller, action.id);

  assert.deepEqual(attempts, ["attempt-1", "attempt-2"]);
  assert.equal(action.alerts, 1);
});

test("reasoning dial maps each direction to one dedicated adjustment without encoder clicks", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-direction");
  const adjustments: string[] = [];
  const encoderClicks: number[] = [];
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning(direction) { adjustments.push(direction); return { outcome: "applied" }; },
    async sendEncoder(act) { encoderClicks.push(act); }
  };

  controller.registerDial(action, expandDialPreset("reasoning"));
  controller.rotateDial(action, 1);
  controller.rotateDial(action, -1);
  await idle(controller, action.id);

  assert.deepEqual(adjustments, ["increase", "decrease"]);
  assert.deepEqual(encoderClicks, []);
});

test("local reasoning detents capture and pass each dial's explicit Ultra policy", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-local-policy");
  const policies: Array<[string, ReasoningAdjustmentPolicy | undefined]> = [];
  const backlog = deferred<void>();
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning(direction, policy) {
      policies.push([direction, policy]);
      return { outcome: "applied" };
    }
  };

  controller.registerDial(action, { ...expandDialPreset("reasoning"), includeUltraReasoning: false });
  probe(controller).dials.get(action.id)!.queue.enqueue(() => backlog.promise);
  controller.rotateDial(action, 1);
  controller.updateDialSettings(action, {
    ...expandDialPreset("reasoning"), includeUltraReasoning: true
  });
  backlog.resolve();
  await idle(controller, action.id);
  controller.rotateDial(action, -1);
  await idle(controller, action.id);

  assert.deepEqual(policies, [
    ["increase", { includeUltra: false }],
    ["decrease", { includeUltra: true }]
  ]);
});

test("local dial outcome extraction ignores malformed structured executions", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };

  const outcome = await state.sendDialToHost(
    { kind: "host", hostId: HOST.hostId, platform: HOST.platform },
    { kind: "reasoning", direction: "increase", includeUltra: true },
    async () => ({ outcome: "unexpected" }),
    false
  );

  assert.equal(outcome, undefined);
});

test("local confirmed reasoning renders immediately and supersedes an older refresh", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-local-immediate");
  const state = probe(controller);
  const staleRefresh = deferred<MicroSnapshot>();
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async refresh() { return staleRefresh.promise; },
    async adjustReasoning() {
      return { outcome: "applied", reasoningEffort: "xhigh" };
    }
  };
  controller.registerDial(action, expandDialPreset("reasoning"));
  await settle();
  const originalSnapshot = state.localSnapshot;
  const originalObservedAt = originalSnapshot.observedAt;
  const older = state.refresh();

  controller.rotateDial(action, 1);
  await idle(controller, action.id);
  const immediateValue = (action.feedbackCalls.at(-1) as { value: string }).value;
  const confirmedSnapshot = state.localSnapshot;
  const confirmedGeneration = state.localSnapshotGeneration;

  staleRefresh.resolve({ ...structuredClone(SNAPSHOT), reasoningEffort: "medium" });
  await older;
  await settle();

  assert.equal(immediateValue, "XHIGH", "feedback must not wait for the 1.2 second poll");
  assert.equal(confirmedGeneration, 1);
  assert.notEqual(confirmedSnapshot, originalSnapshot);
  assert.notEqual(confirmedSnapshot.snapshot, originalSnapshot.snapshot);
  assert.equal(confirmedSnapshot.observedAt, originalObservedAt);
  assert.equal(state.localSnapshot, confirmedSnapshot);
  assert.equal(state.localSnapshot.snapshot.reasoningEffort, "xhigh");
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "XHIGH");
  controller.unregisterDial(action);
});

test("local confirmed reasoning survives same-host identity object replacement", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-local-host-object-replacement");
  const state = probe(controller);
  const capturedHost = { ...HOST };
  state.localHost = capturedHost;
  state.targetHostId = capturedHost.hostId;
  state.targetPlatform = capturedHost.platform;
  state.localSnapshot = {
    host: capturedHost, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() {
      const refreshedHost = { ...HOST };
      state.localHost = refreshedHost;
      state.localSnapshot = {
        host: refreshedHost, observedAt: 2_000,
        snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
      };
      return { outcome: "applied", reasoningEffort: "xhigh" };
    }
  };
  controller.registerDial(action, expandDialPreset("reasoning"));
  await settle();

  controller.rotateDial(action, 1);
  await idle(controller, action.id);

  assert.notEqual(state.localHost, capturedHost);
  assert.equal(state.localHost?.hostId, capturedHost.hostId);
  assert.equal(state.localSnapshotGeneration, 1);
  assert.equal(state.localSnapshot?.snapshot.reasoningEffort, "xhigh");
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "XHIGH");
  controller.unregisterDial(action);
});

test("local confirmed reasoning never patches a genuinely replaced host", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-local-different-host");
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() {
      const replacementHost = {
        ...HOST,
        hostId: "host-replacement"
      };
      state.localHost = replacementHost;
      state.localSnapshot = {
        host: replacementHost, observedAt: 2_000,
        snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "medium" }
      };
      return { outcome: "applied", reasoningEffort: "xhigh" };
    }
  };
  controller.registerDial(action, expandDialPreset("reasoning"));
  await settle();

  controller.rotateDial(action, 1);
  await idle(controller, action.id);

  assert.equal(state.localSnapshotGeneration, 1, "the pre-operation fence survives a host replacement");
  assert.equal(state.localSnapshot?.host.hostId, "host-replacement");
  assert.equal(state.localSnapshot?.snapshot.reasoningEffort, "medium");
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "MEDIUM");
  controller.unregisterDial(action);
});

test("local reasoning feedback accepts only exact own bounded execution data", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-local-invalid-feedback");
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  let getterReads = 0;
  const accessor = { outcome: "applied" };
  Object.defineProperty(accessor, "reasoningEffort", {
    enumerable: true,
    get() { getterReads += 1; return "xhigh"; }
  });
  const invalid = [
    { outcome: "applied", reasoningEffort: "" },
    { outcome: "applied", reasoningEffort: " high " },
    { outcome: "applied", reasoningEffort: "x high" },
    { outcome: "applied", reasoningEffort: "\n" },
    { outcome: "applied", reasoningEffort: "high\n" },
    { outcome: "applied", reasoningEffort: "\u0000" },
    { outcome: "applied", reasoningEffort: "!!!" },
    { outcome: "applied", reasoningEffort: "é" },
    { outcome: "applied", reasoningEffort: "推理" },
    { outcome: "applied", reasoningEffort: "x".repeat(65) },
    { outcome: "applied", reasoningEffort: 1 },
    { outcome: "applied", reasoningEffort: "xhigh", extra: true },
    { outcome: "applied", reasoningEffort: "xhigh", [Symbol("extra")]: true },
    accessor
  ];

  controller.registerDial(action, expandDialPreset("reasoning"));
  await settle();

  for (const execution of invalid) {
    const result = await state.sendDialToHost(
      { kind: "host", hostId: HOST.hostId, platform: HOST.platform },
      {
        kind: "reasoning", direction: "increase", includeUltra: true,
        includeReasoningFeedback: true
      },
      async () => execution as ReasoningAdjustmentExecution,
      false
    );
    assert.equal(result, undefined);
    assert.equal(state.localSnapshot.snapshot.reasoningEffort, "high");
    await state.renderAll();
    assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "HIGH");
  }
  assert.equal(getterReads, 0);
  controller.unregisterDial(action);
});

test("remote reasoning detents carry each dial's explicit Ultra policy", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-remote-policy");
  const commands: unknown[] = [];
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => undefined,
    supportsCurrentReadyCapability: () => true,
    async send(command) { commands.push(command); return "applied"; }
  };

  controller.registerDial(action, { ...expandDialPreset("reasoning"), includeUltraReasoning: false });
  controller.rotateDial(action, 1);
  await idle(controller, action.id);
  controller.updateDialSettings(action, {
    ...expandDialPreset("reasoning"), includeUltraReasoning: true
  });
  controller.rotateDial(action, -1);
  await idle(controller, action.id);

  assert.deepEqual(commands, [
    {
      kind: "reasoning", direction: "increase", includeUltra: false,
      includeReasoningFeedback: true
    },
    {
      kind: "reasoning", direction: "decrease", includeUltra: true,
      includeReasoningFeedback: true
    }
  ]);
});

test("remote confirmed reasoning rerenders the same live registration immediately", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-remote-immediate");
  const state = probe(controller);
  let remoteSnapshot = {
    host: REMOTE_HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  const commands: unknown[] = [];
  state.localHost = HOST;
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => remoteSnapshot,
    supportsCurrentReadyCapability: () => true,
    async send(command) {
      commands.push(command);
      remoteSnapshot = {
        ...remoteSnapshot,
        snapshot: { ...remoteSnapshot.snapshot, reasoningEffort: "xhigh" }
      };
      return { outcome: "applied", reasoningEffort: "xhigh" };
    }
  };
  controller.registerDial(action, expandDialPreset("reasoning"));
  await settle();

  controller.rotateDial(action, 1);
  await idle(controller, action.id);

  assert.deepEqual(commands, [{
    kind: "reasoning", direction: "increase", includeUltra: false,
    includeReasoningFeedback: true
  }]);
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "XHIGH");
  controller.unregisterDial(action);
});

test("remote reasoning result never renders a replaced or disposed registration", async () => {
  for (const lifecycle of ["replaced", "disposed"] as const) {
    const controller = new DeckController();
    const oldAction = fakeDial(`reasoning-remote-stale-${lifecycle}`);
    const replacement = fakeDial(oldAction.id);
    const state = probe(controller);
    const response = deferred<void>();
    let remoteSnapshot = {
      host: REMOTE_HOST, observedAt: 1_000,
      snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
    };
    state.localHost = HOST;
    state.targetHostId = REMOTE_HOST.hostId;
    state.targetPlatform = REMOTE_HOST.platform;
    state.relayClient = {
      currentHost: () => REMOTE_HOST,
      currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
      currentSnapshot: () => remoteSnapshot,
      supportsCurrentReadyCapability: () => true,
      async send() {
        await response.promise;
        remoteSnapshot = {
          ...remoteSnapshot,
          snapshot: { ...remoteSnapshot.snapshot, reasoningEffort: "xhigh" }
        };
        return { outcome: "applied", reasoningEffort: "xhigh" };
      }
    };
    controller.registerDial(oldAction, expandDialPreset("reasoning"));
    await settle();
    const oldRegistration = probe(controller).dials.get(oldAction.id)!;
    controller.rotateDial(oldAction, 1);
    await settle();
    if (lifecycle === "replaced") {
      controller.registerDial(replacement, expandDialPreset("reasoning"));
      await settle();
    } else controller.unregisterDial(oldAction);
    const oldCalls = oldAction.feedbackCalls.length;
    const replacementCalls = replacement.feedbackCalls.length;
    response.resolve();
    await oldRegistration.queue.idle();
    await settle();

    assert.equal(oldAction.feedbackCalls.length, oldCalls, lifecycle);
    assert.equal(replacement.feedbackCalls.length, replacementCalls, lifecycle);
    if (lifecycle === "replaced") controller.unregisterDial(replacement);
  }
});

test("rapid remote reasoning detents render confirmed efforts in command order", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-remote-ordered");
  const state = probe(controller);
  const efforts = ["medium", "high", "xhigh"];
  let remoteSnapshot = {
    host: REMOTE_HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "low" }
  };
  state.localHost = HOST;
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => remoteSnapshot,
    supportsCurrentReadyCapability: () => true,
    async send() {
      const reasoningEffort = efforts.shift()!;
      remoteSnapshot = {
        ...remoteSnapshot,
        snapshot: { ...remoteSnapshot.snapshot, reasoningEffort }
      };
      return { outcome: "applied", reasoningEffort };
    }
  };
  controller.registerDial(action, expandDialPreset("reasoning"));
  await settle();
  controller.rotateDial(action, 3);
  await idle(controller, action.id);

  assert.deepEqual(
    action.feedbackCalls.map((call) => (call as { value: string }).value),
    ["LOW", "MEDIUM", "HIGH", "XHIGH"]
  );
  controller.unregisterDial(action);
});

test("remote missing, malformed, and failed feedback never invent a reasoning transition", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-remote-invalid-feedback");
  const state = probe(controller);
  const results: Array<ReasoningAdjustmentResult | ReasoningAdjustmentExecution | Error> = [
    "applied",
    { outcome: "applied", reasoningEffort: "" },
    new Error("remote adjustment failed")
  ];
  const remoteSnapshot = {
    host: REMOTE_HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHost = HOST;
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => remoteSnapshot,
    supportsCurrentReadyCapability: () => true,
    async send() {
      const result = results.shift()!;
      if (result instanceof Error) throw result;
      return result;
    }
  };
  controller.registerDial(action, expandDialPreset("reasoning"));
  await settle();
  controller.rotateDial(action, 3);
  await idle(controller, action.id);

  assert.deepEqual(
    action.feedbackCalls.map((call) => (call as { value: string }).value),
    ["HIGH"]
  );
  assert.equal(action.alerts, 1);
  assert.equal(remoteSnapshot.snapshot.reasoningEffort, "high");
  controller.unregisterDial(action);
});

test("restricted remote reasoning refuses a legacy peer before controller send", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-legacy-policy");
  const commands: unknown[] = [];
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => undefined,
    supportsCurrentReadyCapability: () => false,
    async send(command) { commands.push(command); return "applied"; }
  };
  controller.registerDial(action, {
    ...expandDialPreset("reasoning"), includeUltraReasoning: false
  });

  controller.rotateDial(action, 1);
  await idle(controller, action.id);

  assert.deepEqual(commands, []);
  assert.equal(action.alerts, 1);
  controller.unregisterDial(action);
});

test("public reasoning actions remain unrestricted locally and remotely", async () => {
  const controller = new DeckController();
  const localPolicies: Array<[string, ReasoningAdjustmentPolicy | undefined]> = [];
  const remoteCommands: unknown[] = [];
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning(direction, policy) {
      localPolicies.push([direction, policy]);
      return { outcome: "applied" };
    }
  };
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => undefined,
    async send(command) { remoteCommands.push(command); return "applied"; }
  };

  await controller.adjustReasoning("increase");
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  await controller.adjustReasoning("decrease");

  assert.deepEqual(localPolicies, [["increase", { includeUltra: true }]]);
  assert.deepEqual(remoteCommands, [
    { kind: "reasoning", direction: "decrease", includeUltra: true }
  ]);
});

test("blocked local and remote reasoning show identical registration-safe Ultra feedback without alerts", async () => {
  const expected = {
    title: "REASONING",
    value: "ULTRA OFF",
    detail: "ENABLE IN DIAL SETTINGS",
    indicator: 100,
    accent: { value: 100, bar_fill_c: "#FF9A3D" }
  };
  for (const route of ["local", "remote"] as const) {
    const controller = new DeckController();
    const action = fakeDial(`reasoning-blocked-${route}`);
    const state = probe(controller);
    state.localHost = HOST;
    state.targetHostId = route === "local" ? HOST.hostId : REMOTE_HOST.hostId;
    state.targetPlatform = route === "local" ? HOST.platform : REMOTE_HOST.platform;
    state.localSnapshot = {
      host: HOST, observedAt: 1_000,
      snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
    };
    state.localHealth = { state: "ready", changedAt: 1_000 };
    let remoteSnapshot = {
      host: REMOTE_HOST, observedAt: 1_000,
      snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
    };
    state.microBridge = {
      async sendAgent() {},
      async adjustReasoning() {
        return { outcome: "blocked-ultra", reasoningEffort: "max" };
      }
    };
    state.relayClient = {
      currentHost: () => REMOTE_HOST,
      currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
      currentSnapshot: () => remoteSnapshot,
      supportsCurrentReadyCapability: () => true,
      async send() {
        remoteSnapshot = {
          ...remoteSnapshot,
          snapshot: { ...remoteSnapshot.snapshot, reasoningEffort: "max" }
        };
        return { outcome: "blocked-ultra", reasoningEffort: "max" };
      }
    };
    controller.registerDial(action, {
      ...expandDialPreset("reasoning"), includeUltraReasoning: false
    });
    await settle();

    controller.rotateDial(action, 1);
    await idle(controller, action.id);

    assert.deepEqual(action.feedbackCalls.at(-1), expected, route);
    assert.equal(
      route === "local"
        ? state.localSnapshot?.snapshot.reasoningEffort
        : state.relayClient!.currentSnapshot()?.snapshot.reasoningEffort,
      "max",
      `${route} authoritative feedback is retained behind the notice`
    );
    assert.equal(action.alerts, 0, route);
    controller.unregisterDial(action);
  }
});

test("Ultra notice serializes behind an in-flight authoritative render for its full duration", async (t) => {
  const controller = new DeckController();
  const state = probe(controller);
  const highStarted = deferred<void>();
  const releaseHigh = deferred<void>();
  const blockedReturned = deferred<void>();
  const completedWrites: string[] = [];
  const feedbackCalls: unknown[] = [];
  let blockHigh = true;
  const action = {
    id: "reasoning-blocked-render-race",
    feedbackCalls,
    triggerCalls: [],
    alerts: 0,
    async setFeedback(payload: unknown) {
      const value = String((payload as { value?: unknown }).value);
      feedbackCalls.push(payload);
      if (value === "HIGH" && blockHigh) {
        blockHigh = false;
        highStarted.resolve();
        await releaseHigh.promise;
      }
      completedWrites.push(value);
    },
    async setTriggerDescription() {},
    async showAlert(this: { alerts: number }) { this.alerts += 1; }
  } as unknown as FakeDial;
  t.after(() => controller.unregisterDial(action));
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() {
      blockedReturned.resolve();
      return { outcome: "blocked-ultra" };
    }
  };

  controller.registerDial(action, {
    ...expandDialPreset("reasoning"), includeUltraReasoning: false
  });
  await highStarted.promise;
  controller.rotateDial(action, 1);
  await blockedReturned.promise;
  await settle();
  releaseHigh.resolve();
  await idle(controller, action.id);

  assert.deepEqual(completedWrites, ["HIGH", "ULTRA OFF"]);
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.equal(completedWrites.at(-1), "ULTRA OFF");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await settle();
  assert.equal(completedWrites.at(-1), "HIGH");
  assert.equal(action.alerts, 0);
});

test("blocked reasoning restores the latest authoritative feedback after 1.2 seconds", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-blocked-restore");
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "medium" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() { return { outcome: "blocked-ultra" }; }
  };
  controller.registerDial(action, {
    ...expandDialPreset("reasoning"), includeUltraReasoning: false
  });
  await settle();

  controller.rotateDial(action, 1);
  await idle(controller, action.id);
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "ULTRA OFF");
  state.localSnapshot = {
    host: HOST, observedAt: 2_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "xhigh" }
  };
  await state.renderAll();
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "ULTRA OFF");

  await new Promise((resolve) => setTimeout(resolve, 1_250));
  await settle();
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "XHIGH");
  controller.unregisterDial(action);
});

test("Ultra notices are canceled safely by settings changes, disposal, and registration replacement", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() { return { outcome: "blocked-ultra" }; }
  };
  const blockedSettings = {
    ...expandDialPreset("reasoning"), includeUltraReasoning: false
  };

  const changed = fakeDial("notice-settings-change");
  controller.registerDial(changed, blockedSettings);
  await settle();
  controller.rotateDial(changed, 1);
  await idle(controller, changed.id);
  assert.equal((changed.feedbackCalls.at(-1) as { value: string }).value, "ULTRA OFF");
  controller.updateDialSettings(changed, {
    ...blockedSettings, includeUltraReasoning: true
  });
  await settle();
  assert.equal((changed.feedbackCalls.at(-1) as { value: string }).value, "HIGH");

  const disposed = fakeDial("notice-disposed");
  controller.registerDial(disposed, blockedSettings);
  await settle();
  controller.rotateDial(disposed, 1);
  await idle(controller, disposed.id);
  assert.equal((disposed.feedbackCalls.at(-1) as { value: string }).value, "ULTRA OFF");
  const disposedCalls = disposed.feedbackCalls.length;
  controller.unregisterDial(disposed);

  const oldAction = fakeDial("notice-replaced");
  const newAction = fakeDial("notice-replaced");
  controller.registerDial(oldAction, blockedSettings);
  await settle();
  controller.rotateDial(oldAction, 1);
  await idle(controller, oldAction.id);
  assert.equal((oldAction.feedbackCalls.at(-1) as { value: string }).value, "ULTRA OFF");
  const oldCalls = oldAction.feedbackCalls.length;
  controller.registerDial(newAction, blockedSettings);
  await settle();
  const newCalls = newAction.feedbackCalls.length;

  await new Promise((resolve) => setTimeout(resolve, 1_250));
  await settle();
  assert.equal(disposed.feedbackCalls.length, disposedCalls);
  assert.equal(oldAction.feedbackCalls.length, oldCalls);
  assert.equal(newAction.feedbackCalls.length, newCalls);
  controller.unregisterDial(changed);
  controller.unregisterDial(newAction);
});

test("a stale in-flight Ultra notice cannot overwrite replacement registration feedback", async () => {
  for (const failsAfterWrite of [false, true]) {
    const controller = new DeckController();
    const state = probe(controller);
    const writes: string[] = [];
    const noticeStarted = deferred<void>();
    const releaseNotice = deferred<void>();
    const makeAction = (owner: "old" | "new"): FakeDial => ({
      id: `notice-race-${failsAfterWrite}`,
      feedbackCalls: [],
      triggerCalls: [],
      alerts: 0,
      async setFeedback(payload: unknown) {
        const value = String((payload as { value?: unknown }).value);
        if (owner === "old" && value === "ULTRA OFF") {
          noticeStarted.resolve();
          await releaseNotice.promise;
          writes.push(`${owner}:${value}`);
          if (failsAfterWrite) throw new Error("stale notice write failed");
          return;
        }
        writes.push(`${owner}:${value}`);
      },
      async setTriggerDescription() {},
      async showAlert(this: { alerts: number }) { this.alerts += 1; }
    } as unknown as FakeDial);
    const oldAction = makeAction("old");
    const newAction = makeAction("new");
    state.localHost = HOST;
    state.targetHostId = HOST.hostId;
    state.targetPlatform = HOST.platform;
    state.localSnapshot = {
      host: HOST, observedAt: 1_000,
      snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
    };
    state.localHealth = { state: "ready", changedAt: 1_000 };
    state.microBridge = {
      async sendAgent() {},
      async adjustReasoning() { return { outcome: "blocked-ultra" }; }
    };
    const settings = { ...expandDialPreset("reasoning"), includeUltraReasoning: false };

    controller.registerDial(oldAction, settings);
    await settle();
    const oldRegistration = probe(controller).dials.get(oldAction.id)!;
    controller.rotateDial(oldAction, 1);
    await noticeStarted.promise;
    controller.registerDial(newAction, settings);
    await settle();
    releaseNotice.resolve();
    await oldRegistration.queue.idle();
    await settle();

    assert.deepEqual(writes, [
      "old:HIGH", "new:HIGH", "old:ULTRA OFF", "new:HIGH"
    ], failsAfterWrite ? "failed stale write" : "successful stale write");
    assert.equal(oldAction.alerts, 0);
    assert.equal(newAction.alerts, 0);
    controller.unregisterDial(newAction);
  }
});

test("disposing during an in-flight failed Ultra notice does not restore or reject", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const writes: string[] = [];
  const noticeStarted = deferred<void>();
  const releaseNotice = deferred<void>();
  const action = {
    id: "notice-disposal-race",
    feedbackCalls: [],
    triggerCalls: [],
    alerts: 0,
    async setFeedback(payload: unknown) {
      const value = String((payload as { value?: unknown }).value);
      if (value === "ULTRA OFF") {
        noticeStarted.resolve();
        await releaseNotice.promise;
      }
      writes.push(value);
      if (value === "ULTRA OFF") throw new Error("disposed notice write failed");
    },
    async setTriggerDescription() {},
    async showAlert(this: { alerts: number }) { this.alerts += 1; }
  } as unknown as FakeDial;
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() { return { outcome: "blocked-ultra" }; }
  };
  controller.registerDial(action, {
    ...expandDialPreset("reasoning"), includeUltraReasoning: false
  });
  await settle();
  const registration = probe(controller).dials.get(action.id)!;
  controller.rotateDial(action, 1);
  await noticeStarted.promise;
  controller.unregisterDial(action);
  releaseNotice.resolve();

  await assert.doesNotReject(registration.queue.idle());
  await settle();
  assert.deepEqual(writes, ["HIGH", "ULTRA OFF"]);
  assert.equal(action.alerts, 0);
});

test("failed Ultra notice feedback clears suppression and falls back to authoritative rendering", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-blocked-feedback-failure", { rejectUltraFeedback: true });
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: { ...structuredClone(SNAPSHOT), reasoningEffort: "high" }
  };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() { return { outcome: "blocked-ultra" }; }
  };
  controller.registerDial(action, {
    ...expandDialPreset("reasoning"), includeUltraReasoning: false
  });
  await settle();

  controller.rotateDial(action, 1);
  await idle(controller, action.id);

  assert.match(JSON.stringify(action.feedbackCalls), /ULTRA OFF/);
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "HIGH");
  assert.equal(action.alerts, 0);
  controller.unregisterDial(action);
});

test("rotation rejects malformed or oversized events and atomically bounds one-shot backlog", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("bounded-rotation");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sends: string[] = [];
  let first = true;
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async runKeycap(keycapId) {
      sends.push(keycapId);
      if (first) {
        first = false;
        await gate;
      }
    }
  };
  state.refresh = async () => {};
  controller.registerDial(action, {
    ...expandDialPreset("custom"),
    rotation: {
      kind: "paired", counterClockwise: "keycap.FAST", clockwise: "keycap.FAST"
    }
  });

  controller.rotateDial(action, 65);
  controller.rotateDial(action, Number.NaN);
  await settle();
  assert.deepEqual(sends, []);
  assert.equal(action.alerts, 2, "each rejected physical event alerts once");

  controller.rotateDial(action, 64);
  controller.rotateDial(action, 64);
  controller.rotateDial(action, 1);
  await settle();
  assert.equal(sends.length, 1, "the accepted backlog starts in order");
  assert.equal(action.alerts, 3, "the overflowing event alerts once without partial admission");
  assert.equal(probe(controller).dials.get(action.id)!.queue.pendingCount, 128);
  release();
  await idle(controller, action.id);
  assert.equal(sends.length, 128);
  assert.equal(probe(controller).dials.get(action.id)!.queue.pendingCount, 0);
});

test("rate-limit reset remains press-only and uses Encoder feedback for completed holds", async () => {
  const controller = new DeckController();
  const action = fakeDial("protected-hold");
  const settings = {
    ...expandDialPreset("custom"),
    press: "usage.rate-limit-reset",
    touchTap: "none"
  };
  let begins = 0;
  const finishes = [false, true];
  controller.beginRateLimitReset = () => { begins += 1; };
  controller.finishRateLimitReset = async () => finishes.shift() ?? false;

  controller.registerDial(action, settings);
  assert.equal(probe(controller).dials.get(action.id)!.settings.touchTap, "none");
  await controller.touchDial(action);
  assert.equal(begins, 0, "touch cannot start the protected hold");

  await controller.beginDialPress(action);
  await controller.finishDialPress(action);
  assert.doesNotMatch(JSON.stringify(action.feedbackCalls), /RESET COMPLETE/);
  await controller.beginDialPress(action);
  await controller.finishDialPress(action);
  assert.match(JSON.stringify(action.feedbackCalls), /RESET COMPLETE/);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.notEqual(
    JSON.stringify(action.feedbackCalls.at(-1)),
    JSON.stringify(action.feedbackCalls.find((call) => JSON.stringify(call).includes("RESET COMPLETE"))),
    "normal feedback is restored after the temporary success indication"
  );
});

test("agent dispatch validates expected identity before down and releases the saved host assignment", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const sent: Array<[number, 0 | 1, string | undefined]> = [];
  state.localHost = HOST;
  state.routedSlots = [routedAgent(0, "thread-a")];
  state.microBridge = {
    async sendAgent(slot, act, threadKey) { sent.push([slot, act, threadKey]); }
  };

  await assert.rejects(controller.sendAgent(0, 1, "wrong-thread"), /no longer matches/i);
  assert.deepEqual(sent, []);

  await controller.sendAgent(0, 1, "thread-a");
  state.routedSlots = [routedAgent(0, "thread-b", {
    hostId: "host-b", hostName: "Windows", platform: "win32"
  })];
  await controller.sendAgent(0, 0, "thread-a");
  assert.deepEqual(sent, [
    [0, 1, "thread-a"],
    [0, 0, "thread-a"]
  ]);

  state.routedSlots = [routedAgent(0, "thread-c")];
  state.microBridge = {
    async sendAgent() { throw new Error("bridge down failed"); }
  };
  await assert.rejects(controller.sendAgent(0, 1, "thread-c"), /bridge down failed/);
  assert.equal(state.pressedAgents.size, 0, "failed agent down leaves no pressed keypad route");
  await controller.sendAgent(0, 0, "thread-c");
  assert.equal(state.pressedAgents.size, 0, "failed agent gesture is consumed without a stale route");
});

test("keypad agent up waits for a slow down and releases the captured assignment exactly once", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  let releaseDown!: () => void;
  const downGate = new Promise<void>((resolve) => { releaseDown = resolve; });
  const events: Array<[number, 0 | 1, string | undefined]> = [];
  state.localHost = HOST;
  state.routedSlots = [routedAgent(0, "slow-thread")];
  state.microBridge = {
    async sendAgent(slot, act, threadKey) {
      events.push([slot, act, threadKey]);
      if (act === 1) await downGate;
    }
  };

  const down = controller.sendAgent(0, 1, "slow-thread");
  const up = controller.sendAgent(0, 0, "slow-thread");
  releaseDown();
  await Promise.all([down, up]);

  assert.deepEqual(events, [[0, 1, "slow-thread"], [0, 0, "slow-thread"]]);
  assert.equal(state.pressedAgents.size, 0);
});

test("keypad agent up suppresses release when its deferred down fails", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  let failDown!: (error: Error) => void;
  const downGate = new Promise<void>((_resolve, reject) => { failDown = reject; });
  const events: Array<[number, 0 | 1]> = [];
  state.localHost = HOST;
  state.routedSlots = [routedAgent(0, "failed-thread")];
  state.microBridge = {
    async sendAgent(slot, act) {
      events.push([slot, act]);
      if (act === 1) await downGate;
    }
  };

  const down = controller.sendAgent(0, 1, "failed-thread");
  const up = controller.sendAgent(0, 0, "failed-thread");
  failDown(new Error("relay down failed"));
  await assert.rejects(down, /relay down failed/);
  await up;

  assert.deepEqual(events, [[0, 1]]);
  assert.equal(state.pressedAgents.size, 0);
});

test("action selector rotation does not execute until press", async () => {
  const controller = new DeckController();
  const action = fakeDial("action-selector");
  const settings = {
    ...expandDialPreset("actions"),
    rotation: {
      kind: "selector" as const,
      source: "actions" as const,
      wrap: true,
      items: ["keycap.FAST", "keycap.APPR"]
    }
  };
  const keycaps: string[] = [];
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async runKeycap(keycapId) { keycaps.push(keycapId); }
  };

  controller.registerDial(action, settings);
  controller.rotateDial(action, 1);
  await idle(controller, action.id);
  assert.deepEqual(keycaps, []);
  await controller.beginDialPress(action);
  assert.deepEqual(keycaps, ["APPR"]);
});

test("empty agent and action selectors render no items and pressing still alerts", async () => {
  for (const [id, settings] of [
    ["empty-agents", expandDialPreset("agents")],
    ["empty-actions", {
      ...expandDialPreset("actions"),
      rotation: { kind: "selector" as const, source: "actions" as const, wrap: true, items: [] }
    }]
  ] as const) {
    const controller = new DeckController();
    const state = probe(controller);
    const action = fakeDial(id);
    state.localHost = HOST;
    state.targetHostId = HOST.hostId;
    state.targetPlatform = HOST.platform;
    state.localHealth = { state: "ready", changedAt: 1_000 };
    state.routedSlots = [];
    controller.registerDial(action, settings);
    await settle();

    assert.equal(
      (action.feedbackCalls.at(-1) as { value?: string }).value,
      "NO ITEMS"
    );
    await controller.beginDialPress(action);
    await controller.finishDialPress(action);
    assert.equal(action.alerts, 1);
  }
});

test("dial host commands require ready health for starts but execute when ready", async () => {
  const bindings = [
    "reasoning.increase", "keycap.FAST", "micro.ACT06", "joystick.up"
  ] as const;
  for (const health of ["degraded", "offline", "connecting"] as const) {
    for (const binding of bindings) {
      const controller = new DeckController();
      const state = probe(controller);
      const action = fakeDial(`${health}-${binding}`);
      const sends: string[] = [];
      state.localHost = HOST;
      state.targetHostId = HOST.hostId;
      state.targetPlatform = HOST.platform;
      state.localHealth = { state: health, changedAt: 1_000 };
      state.microBridge = {
        async sendAgent() {},
        async adjustReasoning(direction) { sends.push(`reasoning:${direction}`); return { outcome: "applied" }; },
        async runKeycap(keycapId) { sends.push(`keycap:${keycapId}`); },
        async sendAction(slot, act) { sends.push(`action:${slot}:${act}`); },
        async sendJoystick(direction, distance) { sends.push(`joystick:${direction}:${distance}`); }
      };
      controller.registerDial(action, { ...expandDialPreset("custom"), press: binding });

      await controller.beginDialPress(action);
      await controller.finishDialPress(action);

      assert.deepEqual(sends, [], `${health} ${binding}`);
      assert.equal(action.alerts, 1, `${health} ${binding}`);
    }
  }

  for (const binding of bindings) {
    const controller = new DeckController();
    const state = probe(controller);
    const action = fakeDial(`ready-${binding}`);
    const sends: string[] = [];
    state.localHost = HOST;
    state.targetHostId = HOST.hostId;
    state.targetPlatform = HOST.platform;
    state.localHealth = { state: "ready", changedAt: 1_000 };
    state.microBridge = {
      async sendAgent() {},
      async adjustReasoning(direction) { sends.push(`reasoning:${direction}`); return { outcome: "applied" }; },
      async runKeycap(keycapId) { sends.push(`keycap:${keycapId}`); },
      async sendAction(slot, act) { sends.push(`action:${slot}:${act}`); },
      async sendJoystick(direction, distance) { sends.push(`joystick:${direction}:${distance}`); }
    };
    controller.registerDial(action, { ...expandDialPreset("custom"), press: binding });

    await controller.beginDialPress(action);
    await controller.finishDialPress(action);

    assert.equal(sends.length, binding.startsWith("micro.") || binding.startsWith("joystick.") ? 2 : 1);
    assert.equal(action.alerts, 0, binding);
  }
});

test("dial agent starts require their owner health and active releases survive degradation", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const blocked = fakeDial("agent-health-blocked");
  const released = fakeDial("release-after-degradation");
  const agentEvents: Array<[number, 0 | 1]> = [];
  const actionEvents: Array<[string, 0 | 1]> = [];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.routedSlots = [routedAgent(0, "health-thread")];
  state.localHealth = { state: "degraded", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent(slot, act) { agentEvents.push([slot, act]); },
    async sendAction(slot, act) { actionEvents.push([slot, act]); }
  };
  controller.registerDial(blocked, expandDialPreset("agents"));
  await controller.beginDialPress(blocked);
  await controller.finishDialPress(blocked);
  assert.deepEqual(agentEvents, []);
  assert.equal(blocked.alerts, 1);

  state.localHealth = { state: "ready", changedAt: 2_000 };
  controller.registerDial(released, { ...expandDialPreset("custom"), press: "micro.ACT06" });
  await controller.beginDialPress(released);
  state.localHealth = { state: "offline", changedAt: 3_000 };
  await controller.finishDialPress(released);
  assert.deepEqual(actionEvents, [["ACT06", 1], ["ACT06", 0]]);
  assert.equal(released.alerts, 0);
});

test("remote dial starts require remote readiness and multi-host agent feedback shows a badge", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const blocked = fakeDial("remote-health-blocked");
  const badged = fakeDial("multi-host-badge");
  const commands: unknown[] = [];
  let remoteHealth: HostHealth = { state: "degraded", changedAt: 1_000 };
  state.localHost = HOST;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  state.routedSlots = [routedAgent(0, "local-thread", HOST)];
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => remoteHealth,
    currentSnapshot: () => undefined,
    async send(command) { commands.push(command); }
  };
  controller.registerDial(blocked, { ...expandDialPreset("custom"), press: "keycap.FAST" });
  await controller.beginDialPress(blocked);
  await controller.finishDialPress(blocked);
  assert.deepEqual(commands, []);
  assert.equal(blocked.alerts, 1);

  remoteHealth = { state: "ready", changedAt: 2_000 };
  const ready = fakeDial("remote-health-ready");
  controller.registerDial(ready, { ...expandDialPreset("custom"), press: "keycap.FAST" });
  await controller.beginDialPress(ready);
  assert.equal(commands.length, 1);
  assert.equal(ready.alerts, 0);

  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  const configuredOnly = fakeDial("configured-relay-single-host");
  controller.registerDial(configuredOnly, expandDialPreset("agents"));
  await settle();
  assert.equal((configuredOnly.feedbackCalls.at(-1) as { title?: string }).title, "AGENT 1");

  state.routedSlots = [
    routedAgent(0, "local-thread", HOST),
    routedAgent(1, "remote-thread", REMOTE_HOST)
  ];
  controller.registerDial(badged, expandDialPreset("agents"));
  await settle();
  assert.equal((badged.feedbackCalls.at(-1) as { title?: string }).title, "AGENT 1 • M");
  controller.rotateDial(badged, 1);
  await idle(controller, badged.id);
  assert.equal((badged.feedbackCalls.at(-1) as { title?: string }).title, "AGENT 2 • W");
});

test("agent feedback health follows the highlighted owner instead of the function target", async () => {
  const remoteHealth: HostHealth = { state: "offline", changedAt: 1_000 };
  const relay = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => remoteHealth,
    currentSnapshot: () => undefined,
    async send() {}
  };

  const localTarget = new DeckController();
  const localState = probe(localTarget);
  const remoteAgent = fakeDial("remote-owner-offline");
  localState.localHost = HOST;
  localState.localHealth = { state: "ready", changedAt: 1_000 };
  localState.targetHostId = HOST.hostId;
  localState.targetPlatform = HOST.platform;
  localState.routedSlots = [routedAgent(0, "remote-owner", REMOTE_HOST)];
  localState.relayClient = relay;
  localTarget.registerDial(remoteAgent, expandDialPreset("agents"));
  await settle();
  assert.equal((remoteAgent.feedbackCalls.at(-1) as { value?: string }).value, "OFFLINE");

  const remoteTarget = new DeckController();
  const remoteState = probe(remoteTarget);
  const localAgent = fakeDial("local-owner-ready");
  remoteState.localHost = HOST;
  remoteState.localHealth = { state: "ready", changedAt: 1_000 };
  remoteState.targetHostId = REMOTE_HOST.hostId;
  remoteState.targetPlatform = REMOTE_HOST.platform;
  remoteState.routedSlots = [routedAgent(0, "local-owner", HOST)];
  remoteState.relayClient = relay;
  remoteTarget.registerDial(localAgent, expandDialPreset("agents"));
  await settle();
  assert.equal((localAgent.feedbackCalls.at(-1) as { value?: string }).value, "TASK LOCAL-OWNER");
});

test("local dial usage refresh requires ready health", async () => {
  for (const health of ["degraded", "offline", "connecting", "ready"] as const) {
    const controller = new DeckController();
    const state = probe(controller);
    const action = fakeDial(`usage-refresh-${health}`);
    let refreshes = 0;
    state.localHost = HOST;
    state.targetHostId = HOST.hostId;
    state.targetPlatform = HOST.platform;
    state.localHealth = { state: health, changedAt: 1_000 };
    state.refreshLocalUsage = async () => {
      refreshes += 1;
      return SNAPSHOT;
    };
    controller.registerDial(action, {
      ...expandDialPreset("custom"), press: "usage.refresh"
    });

    await controller.beginDialPress(action);
    await controller.finishDialPress(action);

    assert.equal(refreshes, health === "ready" ? 1 : 0, health);
    assert.equal(action.alerts, health === "ready" ? 0 : 1, health);
  }
});

test("dial rate-limit reset requires ready usage-host health", async () => {
  for (const health of ["degraded", "ready"] as const) {
    const controller = new DeckController();
    const state = probe(controller);
    const action = fakeDial(`reset-${health}`);
    let resets = 0;
    state.localHost = HOST;
    state.targetHostId = HOST.hostId;
    state.targetPlatform = HOST.platform;
    state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: SNAPSHOT };
    state.localHealth = { state: health, changedAt: 1_000 };
    state.microBridge = {
      async sendAgent() {},
      async consumeRateLimitReset() { resets += 1; }
    };
    state.refresh = async () => {};
    controller.registerDial(action, {
      ...expandDialPreset("custom"), press: "usage.rate-limit-reset"
    });
    const realNow = Date.now;
    try {
      Date.now = () => 50_000;
      await controller.beginDialPress(action);
      Date.now = () => 51_200;
      await controller.finishDialPress(action);
    } finally {
      Date.now = realNow;
    }
    assert.equal(resets, health === "ready" ? 1 : 0);
    assert.equal(action.alerts, health === "ready" ? 0 : 1);
    controller.unregisterDial(action);
  }
});

test("keypad and dial reset paths fail closed unless applicability is a positive safe integer", async () => {
  const invalidApplicable: unknown[] = [undefined, null, 0, -1, 1.5, Number.NaN, Infinity, "1", false, [], {}];
  for (const route of ["keypad", "dial"] as const) {
    for (const applicable of invalidApplicable) {
      const controller = new DeckController();
      const state = probe(controller);
      const action = fakeDial(`${route}-${String(applicable)}`);
      let resets = 0;
      state.localHost = HOST;
      state.localSnapshot = {
        host: HOST, observedAt: 1_000,
        snapshot: {
          ...structuredClone(SNAPSHOT),
          usage: { ...structuredClone(SNAPSHOT.usage!), resetCreditsApplicable: applicable as number }
        }
      };
      state.localHealth = { state: "ready", changedAt: 1_000 };
      state.microBridge = {
        async sendAgent() {},
        async consumeRateLimitReset() { resets += 1; }
      };
      state.refresh = async () => {};
      controller.beginRateLimitReset(action, 10_000, route === "dial" ? HOST.hostId : undefined);
      await assert.rejects(
        controller.finishRateLimitReset(action, 11_200, route === "dial" ? HOST.hostId : undefined),
        /No rate-limit reset credit is currently applicable\./
      );
      assert.equal(resets, 0, `${route}:${String(applicable)}`);
    }
  }

  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("valid-applicability");
  let resets = 0;
  state.localHost = HOST;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: structuredClone(SNAPSHOT) };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async consumeRateLimitReset() { resets += 1; }
  };
  state.refresh = async () => {};
  controller.beginRateLimitReset(action, 20_000);
  assert.equal(await controller.finishRateLimitReset(action, 21_200), true);
  assert.equal(resets, 1);
});

test("beginning a reset hold logs an initial render failure without an unhandled rejection or alert", async () => {
  const controller = new DeckController();
  const action = fakeDial("reset-render-failure");
  const state = controller as unknown as {
    rateLimitResetActions: Map<string, unknown>;
    renderRateLimitReset(action: unknown): Promise<void>;
  };
  state.rateLimitResetActions.set(action.id, action);
  state.renderRateLimitReset = async () => { throw new Error("initial hold render failed"); };

  const errors: string[] = [];
  const unhandled: unknown[] = [];
  const logger = streamDeck.logger as unknown as { error(message: string): void };
  const originalError = logger.error;
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  logger.error = (message) => { errors.push(message); };
  process.on("unhandledRejection", onUnhandled);
  try {
    controller.beginRateLimitReset(action, 10_000);
    await settle();
  } finally {
    process.off("unhandledRejection", onUnhandled);
    logger.error = originalError;
  }

  assert.deepEqual(unhandled, []);
  assert.equal(errors.filter((message) => message.includes("initial hold render failed")).length, 1);
  assert.equal(action.alerts, 0);
});

test("animation scheduling logs renderer failures and continues subsequent frames", async () => {
  const controller = new DeckController();
  const state = controller as unknown as {
    stopped: boolean;
    scheduleAnimation(): void;
    renderAnimatedAgents(): Promise<void>;
    renderResetHolds(): Promise<void>;
  };
  let agentFrames = 0;
  let resetFrames = 0;
  state.renderAnimatedAgents = async () => {
    agentFrames += 1;
    if (agentFrames === 1) throw new Error("agent frame failed");
  };
  state.renderResetHolds = async () => {
    resetFrames += 1;
    if (resetFrames === 2) throw new Error("reset frame failed");
  };

  const scheduled: Array<() => unknown> = [];
  const errors: string[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const logger = streamDeck.logger as unknown as { error(message: string): void };
  const originalError = logger.error;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    scheduled.push(() => callback());
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout;
  logger.error = (message) => { errors.push(message); };
  state.stopped = false;
  try {
    state.scheduleAnimation();
    await assert.doesNotReject(async () => (scheduled.shift()!)());
    await assert.doesNotReject(async () => (scheduled.shift()!)());
    state.stopped = true;
    await assert.doesNotReject(async () => (scheduled.shift()!)());
  } finally {
    state.stopped = true;
    globalThis.setTimeout = originalSetTimeout;
    logger.error = originalError;
  }

  assert.equal(agentFrames, 3);
  assert.equal(resetFrames, 3);
  assert.equal(errors.filter((message) => message.includes("agent frame failed")).length, 1);
  assert.equal(errors.filter((message) => message.includes("reset frame failed")).length, 1);
  assert.equal(scheduled.length, 0);
});

test("two dials pressing the same momentary binding keep independent captured hosts", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const localEvents: Array<[string, 0 | 1]> = [];
  const remoteEvents: Array<[string, 0 | 1]> = [];
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async sendAction(slot, act) { localEvents.push([slot, act]); }
  };
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => undefined,
    async send(command) {
      const value = command as { kind: string; slot: string; act: 0 | 1 };
      if (value.kind === "action") remoteEvents.push([value.slot, value.act]);
    }
  };
  const settings = { ...expandDialPreset("custom"), press: "micro.ACT06" };
  const localDial = fakeDial("same-local");
  const remoteDial = fakeDial("same-remote");
  controller.registerDial(localDial, settings);
  controller.registerDial(remoteDial, settings);

  await controller.beginDialPress(localDial);
  state.targetPlatform = REMOTE_HOST.platform;
  state.targetHostId = REMOTE_HOST.hostId;
  await controller.beginDialPress(remoteDial);
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  await controller.finishDialPress(localDial);
  assert.deepEqual(localEvents, [["ACT06", 1], ["ACT06", 0]]);
  assert.deepEqual(remoteEvents, [["ACT06", 1]]);
  await controller.finishDialPress(remoteDial);

  assert.deepEqual(localEvents, [["ACT06", 1], ["ACT06", 0]]);
  assert.deepEqual(remoteEvents, [["ACT06", 1], ["ACT06", 0]]);
});

test("a dial and keypad pressing the same binding do not overwrite each other's routes", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const localEvents: Array<[string, 0 | 1]> = [];
  const remoteEvents: Array<[string, 0 | 1]> = [];
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.microBridge = {
    async sendAgent() {},
    async sendAction(slot, act) { localEvents.push([slot, act]); }
  };
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => undefined,
    async send(command) {
      const value = command as { kind: string; slot: string; act: 0 | 1 };
      if (value.kind === "action") remoteEvents.push([value.slot, value.act]);
    }
  };
  const action = fakeDial("dial-keypad-overlap");
  controller.registerDial(action, { ...expandDialPreset("custom"), press: "micro.ACT06" });

  await controller.sendMicroAction("ACT06", 1);
  state.targetPlatform = REMOTE_HOST.platform;
  state.targetHostId = REMOTE_HOST.hostId;
  await controller.beginDialPress(action);
  await controller.sendMicroAction("ACT06", 0);
  assert.deepEqual(localEvents, [["ACT06", 1], ["ACT06", 0]]);
  assert.deepEqual(remoteEvents, [["ACT06", 1]]);
  await controller.finishDialPress(action);
  assert.deepEqual(remoteEvents, [["ACT06", 1], ["ACT06", 0]]);
});

test("agent down rejects an owner change with the same thread key and leaves no pressed state", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("agent-owner-change");
  let releaseBacklog!: () => void;
  const backlog = new Promise<void>((resolve) => { releaseBacklog = resolve; });
  state.localHost = HOST;
  state.routedSlots = [routedAgent(0, "same-thread", HOST)];
  const localEvents: unknown[] = [];
  const remoteEvents: unknown[] = [];
  state.microBridge = {
    async sendAgent(...args) { localEvents.push(args); }
  };
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => undefined,
    async send(command) { remoteEvents.push(command); }
  };
  controller.registerDial(action, expandDialPreset("agents"));
  probe(controller).dials.get(action.id)!.queue.enqueue(() => backlog);
  const down = controller.beginDialPress(action);
  state.routedSlots = [routedAgent(0, "same-thread", REMOTE_HOST)];
  releaseBacklog();
  await down;
  await controller.finishDialPress(action);

  assert.deepEqual(localEvents, []);
  assert.deepEqual(remoteEvents, []);
  assert.equal(state.pressedAgents.size, 0);
  assert.equal(action.alerts, 1);
});

test("agent down rejects a source-slot identity change on the captured owner", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("agent-source-change");
  let releaseBacklog!: () => void;
  const backlog = new Promise<void>((resolve) => { releaseBacklog = resolve; });
  state.localHost = HOST;
  state.routedSlots = [routedAgent(0, "same-thread", HOST)];
  const events: unknown[] = [];
  state.microBridge = {
    async sendAgent(...args) { events.push(args); }
  };
  controller.registerDial(action, expandDialPreset("agents"));
  probe(controller).dials.get(action.id)!.queue.enqueue(() => backlog);
  const down = controller.beginDialPress(action);
  const changed = routedAgent(0, "same-thread", HOST);
  changed.sourceSlot = 4;
  state.routedSlots = [changed];
  releaseBacklog();
  await down;
  await controller.finishDialPress(action);

  assert.deepEqual(events, []);
  assert.equal(action.alerts, 1);
});

test("failed momentary down suppresses unmatched up and a duplicate alert", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("failed-down");
  const events: Array<[string, 0 | 1]> = [];
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async sendAction(slot, act) {
      events.push([slot, act]);
      if (act === 1) throw new Error("down failed");
    }
  };
  controller.registerDial(action, { ...expandDialPreset("custom"), press: "micro.ACT06" });

  await controller.beginDialPress(action);
  await controller.finishDialPress(action);

  assert.deepEqual(events, [["ACT06", 1]]);
  assert.equal(action.alerts, 1);
});

test("reset hold gate uses physical event timestamps instead of queue execution time", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("physical-hold");
  const settings = { ...expandDialPreset("custom"), press: "usage.rate-limit-reset" };
  let releaseBacklog!: () => void;
  const backlog = new Promise<void>((resolve) => { releaseBacklog = resolve; });
  state.localHost = HOST;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: SNAPSHOT };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  let resets = 0;
  state.microBridge = {
    async sendAgent() {},
    async consumeRateLimitReset() { resets += 1; }
  };
  state.refresh = async () => {};
  controller.registerDial(action, settings);
  probe(controller).dials.get(action.id)!.queue.enqueue(() => backlog);

  const realNow = Date.now;
  try {
    Date.now = () => 10_000;
    const down = controller.beginDialPress(action);
    Date.now = () => 10_100;
    const up = controller.finishDialPress(action);
    Date.now = () => 20_000;
    releaseBacklog();
    await Promise.all([down, up]);
  } finally {
    Date.now = realNow;
  }
  assert.equal(resets, 0, "a 100ms physical hold cannot mature while queued");

  const resetApi = controller as unknown as {
    beginRateLimitReset(action: { id: string }, startedAt: number, sourceHostId?: string): void;
    finishRateLimitReset(action: { id: string }, endedAt: number, sourceHostId?: string): Promise<boolean>;
  };
  resetApi.beginRateLimitReset(action, 30_000, HOST.hostId);
  assert.equal(await resetApi.finishRateLimitReset(action, 31_200, HOST.hostId), true);
  assert.equal(resets, 1, "a physical 1.2s hold remains eligible");
});

test("unregister cancels pending work, releases active gestures, and isolates re-registration", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const events: Array<[string, 0 | 1]> = [];
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async sendAction(slot, act) { events.push([slot, act]); }
  };
  const settings = { ...expandDialPreset("custom"), press: "micro.ACT06" };
  const active = fakeDial("active-dispose");
  controller.registerDial(active, settings);
  await controller.beginDialPress(active);
  controller.unregisterDial(active);
  await settle();
  assert.deepEqual(events, [["ACT06", 1], ["ACT06", 0]]);

  let releaseBacklog!: () => void;
  const backlog = new Promise<void>((resolve) => { releaseBacklog = resolve; });
  const oldAction = fakeDial("reused-id");
  const newAction = fakeDial("reused-id");
  controller.registerDial(oldAction, settings);
  probe(controller).dials.get(oldAction.id)!.queue.enqueue(() => backlog);
  const oldDown = controller.beginDialPress(oldAction);
  controller.unregisterDial(oldAction);
  controller.registerDial(newAction, settings);
  releaseBacklog();
  await oldDown;
  await settle();

  assert.deepEqual(events, [["ACT06", 1], ["ACT06", 0]], "old queued work is canceled");
  assert.equal(probe(controller).dials.get(newAction.id)!.settings.press, "micro.ACT06");
  controller.unregisterDial({ id: newAction.id } as unknown as DialAction<CodexDialSettings>);
  assert.equal(
    probe(controller).dials.has(newAction.id),
    false,
    "WillDisappear may supply a fresh ActionContext object for the current id"
  );
});

test("successful reset stays successful when Encoder acknowledgement feedback fails", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("reset-feedback-failure", { rejectSuccessFeedback: true });
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: SNAPSHOT };
  state.localHealth = { state: "ready", changedAt: 1_000 };
  let resets = 0;
  state.microBridge = {
    async sendAgent() {},
    async consumeRateLimitReset() { resets += 1; }
  };
  state.refresh = async () => {};
  controller.registerDial(action, {
    ...expandDialPreset("custom"),
    press: "usage.rate-limit-reset"
  });
  await settle();

  const realNow = Date.now;
  try {
    Date.now = () => 40_000;
    await controller.beginDialPress(action);
    Date.now = () => 41_200;
    await controller.finishDialPress(action);
  } finally {
    Date.now = realNow;
  }
  await settle();

  assert.equal(resets, 1);
  assert.equal(action.alerts, 0, "display acknowledgement failure is not a command failure");
  assert.equal(
    action.feedbackCalls.filter((call) => JSON.stringify(call).includes("RESET COMPLETE")).length,
    1
  );
  assert.doesNotMatch(JSON.stringify(action.feedbackCalls.at(-1)), /RESET COMPLETE/);
});

test("dial feedback error dedupe storage stays bounded", async () => {
  const controller = new DeckController();
  for (let index = 0; index < 105; index += 1) {
    controller.registerDial(
      fakeDial(`description-error-${index}`, { descriptionError: `description-${index}` }),
      expandDialPreset("reasoning")
    );
  }
  await settle();
  const state = probe(controller);
  assert.equal(state.dialDescriptionErrors.size, 100);
  assert.equal(state.dialRenderErrors.size <= 100, true);
  assert.equal(state.dialSuccessErrors.size <= 100, true);
});

test("rotation detents use the host captured before their queue backlog", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("captured-detent");
  let releaseBacklog!: () => void;
  const backlog = new Promise<void>((resolve) => { releaseBacklog = resolve; });
  const localEvents: Array<[string, 0 | 1]> = [];
  const remoteEvents: unknown[] = [];
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.microBridge = {
    async sendAgent() {},
    async sendAction(slot, act) { localEvents.push([slot, act]); }
  };
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 1_000 }),
    currentSnapshot: () => undefined,
    async send(command) { remoteEvents.push(command); }
  };
  const settings = {
    ...expandDialPreset("custom"),
    rotation: { kind: "paired" as const, counterClockwise: "micro.ACT06", clockwise: "micro.ACT06" }
  };
  controller.registerDial(action, settings);
  probe(controller).dials.get(action.id)!.queue.enqueue(() => backlog);
  controller.rotateDial(action, 1);
  state.targetPlatform = REMOTE_HOST.platform;
  state.targetHostId = REMOTE_HOST.hostId;
  releaseBacklog();
  await idle(controller, action.id);

  assert.deepEqual(localEvents, [["ACT06", 1], ["ACT06", 0]]);
  assert.deepEqual(remoteEvents, []);
});

test("property inspector catalog requests require exact plain data and return target authority", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const sent: unknown[] = [];
  const action = fakeDial("catalog-pi") as FakeDial & { sendToPropertyInspector(payload: unknown): Promise<void> };
  action.sendToPropertyInspector = async (payload) => { sent.push(structuredClone(payload)); };
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshotGeneration = 9;
  state.localSnapshot = {
    host: HOST,
    observedAt: 1_000,
    snapshot: {
      ...structuredClone(SNAPSHOT),
      activeModelId: "gpt-5.6-sol",
      activeModelDisplayName: "5.6 Sol",
      reasoningEffort: "high",
      modelCatalog: [{
        modelId: "gpt-5.6-sol", displayName: "5.6 Sol",
        supportedReasoningEfforts: ["medium", "high", "ultra"]
      }]
    }
  };

  controller.registerDialPropertyInspector(action);
  await settle();
  assert.equal(sent.length, 1, "appear pushes current authority");
  assert.deepEqual(sent[0], {
    kind: "model-catalog",
    requestGeneration: 0,
    catalogRevision: 1,
    available: true,
    hostId: HOST.hostId,
    platform: HOST.platform,
    snapshotGeneration: 9,
    activeModelId: "gpt-5.6-sol",
    activeModelDisplayName: "5.6 Sol",
    reasoningEffort: "high",
    modelCatalog: [{
      modelId: "gpt-5.6-sol", displayName: "5.6 Sol",
      supportedReasoningEfforts: ["medium", "high", "ultra"]
    }]
  });

  controller.handleDialPropertyInspectorMessage(action, { kind: "request-model-catalog", requestGeneration: 7 });
  await settle();
  assert.equal((sent.at(-1) as { requestGeneration: number }).requestGeneration, 7);
  assert.equal((sent.at(-1) as { catalogRevision: number }).catalogRevision, 2);

  for (const invalid of [
    { kind: "request-model-catalog", requestGeneration: 7, extra: true },
    { kind: "request-model-catalog", requestGeneration: -1 },
    Object.assign(Object.create({ kind: "request-model-catalog" }), { requestGeneration: 1 }),
    Object.defineProperty({}, "kind", { get() { throw new Error("getter"); } })
  ]) controller.handleDialPropertyInspectorMessage(action, invalid);
  await settle();
  assert.equal(sent.length, 2, "invalid requests are ignored without accessors");
});

test("property inspector catalog pushes are deduped, monotonic, fenced, and failure-safe", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const firstSent: unknown[] = [];
  const secondSent: unknown[] = [];
  const first = fakeDial("catalog-life") as FakeDial & { sendToPropertyInspector(payload: unknown): Promise<void> };
  first.sendToPropertyInspector = async (payload) => { firstSent.push(structuredClone(payload)); };
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshotGeneration = 1;
  state.localSnapshot = {
    host: HOST, observedAt: 1_000,
    snapshot: {
      ...structuredClone(SNAPSHOT), activeModelId: "gpt-5.6-sol", activeModelDisplayName: "5.6 Sol",
      reasoningEffort: "high", modelCatalog: [{
        modelId: "gpt-5.6-sol", displayName: "5.6 Sol", supportedReasoningEfforts: ["high"]
      }]
    }
  };
  controller.registerDialPropertyInspector(first);
  await settle();
  await state.renderAll();
  assert.equal(firstSent.length, 1, "unchanged authority is deduped");

  state.localSnapshotGeneration = 2;
  state.localSnapshot.snapshot.reasoningEffort = "medium";
  state.localSnapshot.snapshot.modelCatalog![0]!.supportedReasoningEfforts = ["medium", "high"];
  await state.renderAll();
  assert.equal(firstSent.length, 2);
  assert.equal((firstSent[1] as { catalogRevision: number }).catalogRevision, 2);

  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 2_000 }),
    currentSnapshot: () => ({
      host: REMOTE_HOST, observedAt: 22,
      snapshot: {
        ...structuredClone(SNAPSHOT), activeModelId: "gpt-5.6-terra", activeModelDisplayName: "5.6 Terra",
        reasoningEffort: "medium", modelCatalog: [{
          modelId: "gpt-5.6-terra", displayName: "5.6 Terra", supportedReasoningEfforts: ["medium"]
        }]
      }
    }),
    async send() {}
  };
  state.targetPlatform = REMOTE_HOST.platform;
  state.targetHostId = REMOTE_HOST.hostId;
  await state.renderAll();
  assert.equal((firstSent[2] as { hostId: string }).hostId, REMOTE_HOST.hostId, "host switch pushes without reopen");
  assert.equal((firstSent[2] as { catalogRevision: number }).catalogRevision, 3);

  controller.unregisterDialPropertyInspector(first);
  const second = fakeDial("catalog-life") as FakeDial & { sendToPropertyInspector(payload: unknown): Promise<void> };
  second.sendToPropertyInspector = async (payload) => { secondSent.push(structuredClone(payload)); };
  controller.registerDialPropertyInspector(second);
  await settle();
  assert.equal((secondSent[0] as { catalogRevision: number }).catalogRevision, 4);

  controller.handleDialPropertyInspectorMessage(first, { kind: "request-model-catalog", requestGeneration: 9 });
  await settle();
  assert.equal(firstSent.length, 3, "stale action cannot receive replies");
  assert.equal(secondSent.length, 1);

  second.sendToPropertyInspector = async () => { throw new Error("closed inspector"); };
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "degraded", reason: "local-bridge-unavailable", changedAt: 2_000 };
  await assert.doesNotReject(state.renderAll());
  controller.unregisterDialPropertyInspector(second);
});

test("late catalog send from a disappeared inspector carries an older fenced revision", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const late = deferred<void>();
  const delivered: Array<{ owner: string; payload: unknown }> = [];
  const oldAction = fakeDial("catalog-late") as FakeDial & { sendToPropertyInspector(payload: unknown): Promise<void> };
  oldAction.sendToPropertyInspector = async (payload) => {
    await late.promise;
    delivered.push({ owner: "old", payload: structuredClone(payload) });
  };
  const replacement = fakeDial("catalog-late") as FakeDial & { sendToPropertyInspector(payload: unknown): Promise<void> };
  replacement.sendToPropertyInspector = async (payload) => {
    delivered.push({ owner: "new", payload: structuredClone(payload) });
  };
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "degraded", reason: "local-bridge-unavailable", changedAt: 1_000 };

  controller.registerDialPropertyInspector(oldAction);
  controller.unregisterDialPropertyInspector(oldAction);
  controller.registerDialPropertyInspector(replacement);
  await settle();
  late.resolve();
  await settle();

  assert.deepEqual(delivered.map(({ owner }) => owner), ["new", "old"]);
  assert.deepEqual(delivered.map(({ payload }) => (payload as { catalogRevision: number }).catalogRevision), [2, 1]);
  controller.unregisterDialPropertyInspector(replacement);
});

test("stale same-id inspector disappear cannot unregister its replacement", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const oldSent: unknown[] = [];
  const replacementSent: unknown[] = [];
  const oldAction = fakeDial("catalog-replaced") as FakeDial & { sendToPropertyInspector(payload: unknown): Promise<void> };
  oldAction.sendToPropertyInspector = async (payload) => { oldSent.push(payload); };
  const replacement = fakeDial("catalog-replaced") as FakeDial & { sendToPropertyInspector(payload: unknown): Promise<void> };
  replacement.sendToPropertyInspector = async (payload) => { replacementSent.push(payload); };
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
  state.localHealth = { state: "degraded", reason: "local-bridge-unavailable", changedAt: 1_000 };

  controller.registerDialPropertyInspector(oldAction);
  controller.registerDialPropertyInspector(replacement);
  await settle();
  controller.unregisterDialPropertyInspector(oldAction);
  controller.handleDialPropertyInspectorMessage(replacement, {
    kind: "request-model-catalog", requestGeneration: 8
  });
  await settle();

  assert.equal(oldSent.length, 1);
  assert.equal(replacementSent.length, 2, "replacement remains registered after stale disappear");
  assert.equal((replacementSent.at(-1) as { requestGeneration: number }).requestGeneration, 8);
  controller.unregisterDialPropertyInspector(replacement);
});

test("rapid model preset detents resolve one direction at a time from each confirmed pair", async () => {
  const controller = new DeckController();
  const action = fakeDial("model-preset-rapid");
  const state = probe(controller);
  const requests: ModelPresetRequest[] = [];
  const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async applyModelPreset(request) {
      const index = requests.length;
      requests.push(structuredClone(request));
      await releases[index]!.promise;
      return { modelId: request.modelId, reasoningEffort: request.reasoningEffort };
    }
  };
  controller.registerDial(action, modelPresetSettings());
  await settle();

  controller.rotateDial(action, 3);
  await settle();
  assert.deepEqual(requests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-sol", "medium"]
  ]);
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "SWITCHING…");

  releases[0]!.resolve();
  await settle();
  assert.deepEqual(requests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-sol", "medium"], ["gpt-5.6-terra", "medium"]
  ]);
  releases[1]!.resolve();
  await settle();
  assert.deepEqual(requests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-sol", "medium"], ["gpt-5.6-terra", "medium"], ["gpt-5.6-sol", "high"]
  ]);
  releases[2]!.resolve();
  await idle(controller, action.id);

  assert.equal(state.localSnapshotGeneration, 3);
  assert.equal(state.localSnapshot.snapshot.activeModelId, "gpt-5.6-sol");
  assert.equal(state.localSnapshot.snapshot.reasoningEffort, "high");
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "5.6 SOL");
  controller.unregisterDial(action);
});

test("model preset directions use authoritative edges and skip invalid saved pairs", async () => {
  const controller = new DeckController();
  const action = fakeDial("model-preset-edges");
  const state = probe(controller);
  const requests: ModelPresetRequest[] = [];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot("gpt-5.6-sol", "low") };
  state.microBridge = {
    async sendAgent() {},
    async applyModelPreset(request) {
      requests.push(structuredClone(request));
      return { modelId: request.modelId, reasoningEffort: request.reasoningEffort };
    }
  };
  controller.registerDial(action, modelPresetSettings([
    { modelId: "removed-model", reasoningEffort: "high" },
    { modelId: "gpt-5.6-sol", reasoningEffort: "medium" },
    { modelId: "gpt-5.6-terra", reasoningEffort: "medium" }
  ]));
  await settle();

  controller.rotateDial(action, 1);
  await idle(controller, action.id);
  state.localSnapshot = { ...state.localSnapshot, snapshot: modelSnapshot("gpt-5.6-sol", "low") };
  controller.rotateDial(action, -1);
  await idle(controller, action.id);

  assert.deepEqual(requests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-sol", "medium"], ["gpt-5.6-terra", "medium"]
  ]);
  controller.unregisterDial(action);
});

test("model preset queue rejects overflow and rechecks registration and target before execution", async () => {
  const controller = new DeckController();
  const action = fakeDial("model-preset-lifecycle");
  const replacement = fakeDial(action.id);
  const state = probe(controller);
  const first = deferred<ModelPresetExecution>();
  const requests: ModelPresetRequest[] = [];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async applyModelPreset(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) return first.promise;
      return { modelId: request.modelId, reasoningEffort: request.reasoningEffort };
    }
  };
  controller.registerDial(action, modelPresetSettings());
  await settle();

  controller.rotateDial(action, 64);
  controller.rotateDial(action, 64);
  controller.rotateDial(action, 1);
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(action.alerts, 1, "the 129th pending detent is rejected as one event");

  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  const oldRegistration = state.dials.get(action.id)!;
  controller.registerDial(replacement, modelPresetSettings());
  const oldFeedbackCount = action.feedbackCalls.length;
  first.resolve({ modelId: "gpt-5.6-sol", reasoningEffort: "medium" });
  await settle();
  await oldRegistration.queue.idle();
  assert.equal(requests.length, 1, "queued old-registration directions never execute locally");
  assert.equal(action.feedbackCalls.length, oldFeedbackCount);
  controller.unregisterDial(replacement);
});

test("queued model preset directions resolve against a target host changed before execution", async () => {
  const controller = new DeckController();
  const action = fakeDial("model-preset-target-change");
  const state = probe(controller);
  const first = deferred<ModelPresetExecution>();
  const requests: ModelPresetRequest[] = [];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async applyModelPreset(request) {
      requests.push(structuredClone(request));
      return first.promise;
    }
  };
  controller.registerDial(action, modelPresetSettings());
  await settle();

  controller.rotateDial(action, 2);
  await settle();
  state.targetHostId = REMOTE_HOST.hostId;
  state.targetPlatform = REMOTE_HOST.platform;
  state.relayClient = {
    currentHost: () => REMOTE_HOST,
    currentHealth: () => ({ state: "ready", changedAt: 2_000 }),
    currentSnapshot: () => ({ host: REMOTE_HOST, observedAt: 2_000, snapshot: modelSnapshot() }),
    async send() { throw new Error("Task 6 relay path must not be used yet"); }
  };
  first.resolve({ modelId: "gpt-5.6-sol", reasoningEffort: "medium" });
  await idle(controller, action.id);

  assert.equal(requests.length, 1, "the queued second direction does not reuse the captured local host");
  assert.equal(action.alerts, 1, "the current remote target is refused until relay support lands");
  controller.unregisterDial(action);
});

test("disposing a model preset dial prevents held completion and queued detents from writing feedback", async () => {
  const controller = new DeckController();
  const action = fakeDial("model-preset-disposed");
  const state = probe(controller);
  const first = deferred<ModelPresetExecution>();
  let requests = 0;
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async applyModelPreset() { requests += 1; return first.promise; }
  };
  controller.registerDial(action, modelPresetSettings());
  await settle();
  const registration = state.dials.get(action.id)!;
  controller.rotateDial(action, 2);
  await settle();
  controller.unregisterDial(action);
  const feedbackCount = action.feedbackCalls.length;
  first.resolve({ modelId: "gpt-5.6-sol", reasoningEffort: "medium" });
  await registration.queue.idle();

  assert.equal(requests, 1);
  assert.equal(action.feedbackCalls.length, feedbackCount);
});

test("local model preset success fences a held poll, patches the exact pair immutably, and redraws", async () => {
  const controller = new DeckController();
  const action = fakeDial("model-preset-local-patch");
  const state = probe(controller);
  const stalePoll = deferred<MicroSnapshot>();
  const applied = deferred<ModelPresetExecution>();
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  const originalHostSnapshot = state.localSnapshot;
  const originalSnapshot = state.localSnapshot.snapshot;
  state.microBridge = {
    async sendAgent() {},
    async refresh() { return stalePoll.promise; },
    async applyModelPreset() { return applied.promise; }
  };
  controller.registerDial(action, modelPresetSettings());
  await settle();
  const poll = state.refresh();
  await settle();

  controller.rotateDial(action, 1);
  await settle();
  assert.equal((action.feedbackCalls.at(-1) as { value: string }).value, "SWITCHING…");
  applied.resolve({ modelId: "gpt-5.6-sol", reasoningEffort: "medium" });
  await idle(controller, action.id);

  assert.notEqual(state.localSnapshot, originalHostSnapshot);
  assert.notEqual(state.localSnapshot.snapshot, originalSnapshot);
  assert.equal(state.localSnapshot.snapshot.activeModelId, "gpt-5.6-sol");
  assert.equal(state.localSnapshot.snapshot.activeModelDisplayName, "5.6 Sol");
  assert.equal(state.localSnapshot.snapshot.reasoningEffort, "medium");
  assert.equal((action.feedbackCalls.at(-1) as { detail: string }).detail, "MEDIUM");

  stalePoll.resolve(modelSnapshot("gpt-5.6-terra", "medium"));
  await poll;
  assert.equal(state.localSnapshot.snapshot.activeModelId, "gpt-5.6-sol", "older poll is fenced");
  assert.equal(state.localSnapshot.snapshot.reasoningEffort, "medium");
  controller.unregisterDial(action);
});

test("refused or malformed model preset results reconcile actual state without rollback", async () => {
  let getterReads = 0;
  const accessorResult = Object.defineProperty(
    { modelId: "gpt-5.6-terra" }, "reasoningEffort",
    { enumerable: true, get() { getterReads += 1; return "medium"; } }
  );
  for (const [index, result] of [
    new Error("selection refused"),
    { modelId: "gpt-5.6-terra" },
    { modelId: "gpt-5.6-terra", reasoningEffort: "medium", extra: true },
    { modelId: "gpt-5.6-terra", reasoningEffort: "medium", [Symbol("extra")]: true },
    accessorResult
  ].entries()) {
    const controller = new DeckController();
    const action = fakeDial(`model-preset-failure-${index}`);
    const state = probe(controller);
    const requests: ModelPresetRequest[] = [];
    let refreshes = 0;
    state.localHost = HOST;
    state.targetHostId = HOST.hostId;
    state.targetPlatform = HOST.platform;
    state.localHealth = { state: "ready", changedAt: 1_000 };
    state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
    state.microBridge = {
      async sendAgent() {},
      async applyModelPreset(request) {
        requests.push(structuredClone(request));
        if (result instanceof Error) throw result;
        return result as ModelPresetExecution;
      }
    };
    state.refresh = async () => {
      refreshes += 1;
      state.localSnapshot = {
        host: HOST, observedAt: 2_000, snapshot: modelSnapshot("gpt-5.6-terra", "high")
      };
      state.localHealth = { state: "ready", changedAt: 2_000 };
    };
    controller.registerDial(action, modelPresetSettings());
    await settle();

    controller.rotateDial(action, 1);
    await idle(controller, action.id);

    assert.equal(requests.length, 1, "no rollback callback is attempted");
    assert.equal(refreshes, 1, "failure forces one authoritative reconciliation");
    assert.equal((action.feedbackCalls.at(-1) as { detail: string }).detail, "HIGH · UNLISTED");
    assert.equal(action.alerts, 1);
    controller.unregisterDial(action);
  }
  assert.equal(getterReads, 0, "result validation never invokes accessors");
});

test("different model preset knobs resolve in controller-wide arrival order", async () => {
  const controller = new DeckController();
  const firstDial = fakeDial("model-preset-global-first");
  const secondDial = fakeDial("model-preset-global-second");
  const state = probe(controller);
  const firstResult = deferred<ModelPresetExecution>();
  const requests: ModelPresetRequest[] = [];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async applyModelPreset(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) return firstResult.promise;
      return { modelId: request.modelId, reasoningEffort: request.reasoningEffort };
    }
  };
  controller.registerDial(firstDial, modelPresetSettings());
  controller.registerDial(secondDial, modelPresetSettings());
  await settle();

  controller.rotateDial(firstDial, 1);
  controller.rotateDial(secondDial, 1);
  await settle();
  assert.deepEqual(requests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-sol", "medium"]
  ], "the second knob waits to resolve until the first confirms");

  firstResult.resolve({ modelId: "gpt-5.6-sol", reasoningEffort: "medium" });
  await Promise.all([
    state.dials.get(firstDial.id)!.queue.idle(),
    state.dials.get(secondDial.id)!.queue.idle()
  ]);
  assert.deepEqual(requests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-sol", "medium"], ["gpt-5.6-terra", "medium"]
  ]);
  controller.unregisterDial(firstDial);
  controller.unregisterDial(secondDial);
});

test("a model preset waits for predecessor reasoning confirmation before resolving its pair", async () => {
  const controller = new DeckController();
  const reasoningDial = fakeDial("reasoning-global-first");
  const presetDial = fakeDial("model-preset-global-after-reasoning");
  const state = probe(controller);
  const reasoningResult = deferred<ReasoningAdjustmentExecution>();
  const presetRequests: ModelPresetRequest[] = [];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() { return reasoningResult.promise; },
    async applyModelPreset(request) {
      presetRequests.push(structuredClone(request));
      return { modelId: request.modelId, reasoningEffort: request.reasoningEffort };
    }
  };
  controller.registerDial(reasoningDial, expandDialPreset("reasoning"));
  controller.registerDial(presetDial, modelPresetSettings());
  await settle();

  controller.rotateDial(reasoningDial, -1);
  controller.rotateDial(presetDial, 1);
  await settle();
  assert.deepEqual(presetRequests, [], "preset resolution waits behind the reasoning mutation");

  reasoningResult.resolve({ outcome: "applied", reasoningEffort: "medium" });
  await Promise.all([
    state.dials.get(reasoningDial.id)!.queue.idle(),
    state.dials.get(presetDial.id)!.queue.idle()
  ]);
  assert.deepEqual(presetRequests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-terra", "medium"]
  ]);
  controller.unregisterDial(reasoningDial);
  controller.unregisterDial(presetDial);
});

test("reasoning waiting on the shared mutation order rechecks registration disposal", async () => {
  const controller = new DeckController();
  const presetDial = fakeDial("model-preset-global-blocker");
  const reasoningDial = fakeDial("reasoning-global-disposed");
  const state = probe(controller);
  const presetResult = deferred<ModelPresetExecution>();
  let reasoningCalls = 0;
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async applyModelPreset() { return presetResult.promise; },
    async adjustReasoning() {
      reasoningCalls += 1;
      return { outcome: "applied", reasoningEffort: "high" };
    }
  };
  controller.registerDial(presetDial, modelPresetSettings());
  controller.registerDial(reasoningDial, expandDialPreset("reasoning"));
  await settle();
  const reasoningRegistration = state.dials.get(reasoningDial.id)!;

  controller.rotateDial(presetDial, 1);
  controller.rotateDial(reasoningDial, 1);
  await settle();
  controller.unregisterDial(reasoningDial);
  presetResult.resolve({ modelId: "gpt-5.6-sol", reasoningEffort: "medium" });
  await Promise.all([
    state.dials.get(presetDial.id)!.queue.idle(),
    reasoningRegistration.queue.idle()
  ]);

  assert.equal(reasoningCalls, 0);
  controller.unregisterDial(presetDial);
});

test("public reasoning patches its confirmed effort before a waiting preset resolves", async () => {
  const controller = new DeckController();
  const presetDial = fakeDial("model-preset-after-public-reasoning");
  const state = probe(controller);
  const reasoningResult = deferred<ReasoningAdjustmentExecution>();
  const presetRequests: ModelPresetRequest[] = [];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() { return reasoningResult.promise; },
    async applyModelPreset(request) {
      presetRequests.push(structuredClone(request));
      return { modelId: request.modelId, reasoningEffort: request.reasoningEffort };
    }
  };
  controller.registerDial(presetDial, modelPresetSettings());
  await settle();

  const reasoning = controller.adjustReasoning("decrease");
  controller.rotateDial(presetDial, 1);
  await settle();
  assert.deepEqual(presetRequests, []);
  reasoningResult.resolve({ outcome: "applied", reasoningEffort: "medium" });
  await reasoning;
  await state.dials.get(presetDial.id)!.queue.idle();

  assert.equal(state.localSnapshotGeneration, 2, "reasoning and preset each fence older snapshots");
  assert.deepEqual(presetRequests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-terra", "medium"]
  ]);
  controller.unregisterDial(presetDial);
});

test("incoming relay reasoning patches before release and fences a held refresh from a waiting preset", async () => {
  const controller = new DeckController();
  const presetDial = fakeDial("model-preset-after-relay-reasoning");
  const state = probe(controller);
  const staleRefresh = deferred<MicroSnapshot>();
  const reasoningResult = deferred<ReasoningAdjustmentExecution>();
  const presetRequests: ModelPresetRequest[] = [];
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  state.microBridge = {
    async sendAgent() {},
    async refresh() { return staleRefresh.promise; },
    async adjustReasoning() { return reasoningResult.promise; },
    async applyModelPreset(request) {
      presetRequests.push(structuredClone(request));
      return { modelId: request.modelId, reasoningEffort: request.reasoningEffort };
    }
  };
  controller.registerDial(presetDial, modelPresetSettings());
  await settle();
  const olderRefresh = state.refresh();
  await settle();

  const relayReasoning = state.adjustLocalReasoningFromRelay("decrease", { includeUltra: false });
  controller.rotateDial(presetDial, 1);
  await settle();
  reasoningResult.resolve({ outcome: "applied", reasoningEffort: "medium" });
  await relayReasoning;
  await state.dials.get(presetDial.id)!.queue.idle();

  assert.deepEqual(presetRequests.map(({ modelId, reasoningEffort }) => [modelId, reasoningEffort]), [
    ["gpt-5.6-terra", "medium"]
  ]);
  staleRefresh.resolve(modelSnapshot("gpt-5.6-sol", "high"));
  await olderRefresh;
  assert.equal(state.localSnapshot.snapshot.activeModelId, "gpt-5.6-terra");
  assert.equal(state.localSnapshot.snapshot.reasoningEffort, "medium");
  controller.unregisterDial(presetDial);
});

test("shared local reasoning validation is descriptor-safe and failures retain last-known state", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  let getterReads = 0;
  const accessorExecution = Object.defineProperty(
    { outcome: "applied" }, "reasoningEffort",
    { enumerable: true, get() { getterReads += 1; return "medium"; } }
  );
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.localSnapshot = { host: HOST, observedAt: 1_000, snapshot: modelSnapshot() };
  const retained = state.localSnapshot;
  state.microBridge = {
    async sendAgent() {},
    async adjustReasoning() { return accessorExecution as ReasoningAdjustmentExecution; }
  };

  await assert.rejects(controller.adjustReasoning("decrease"), /invalid reasoning adjustment result/i);
  assert.equal(getterReads, 0);
  assert.equal(state.localSnapshot, retained);
  assert.equal(state.localSnapshotGeneration, 1);
  assert.equal(state.localHealth.state, "ready");

  state.microBridge.adjustReasoning = async () => { throw new Error("bridge unavailable"); };
  await assert.rejects(controller.adjustReasoning("decrease"), /bridge unavailable/);
  assert.equal(state.localSnapshot, retained);
  assert.equal(state.localSnapshotGeneration, 2);
  assert.equal(state.localHealth.state, "ready");
});
