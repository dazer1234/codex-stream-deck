import assert from "node:assert/strict";
import test from "node:test";
import streamDeck, { type DialAction, type KeyAction } from "@elgato/streamdeck";
import { DeckController } from "../src/controller.js";
import { expandDialPreset, type DialCommandQueue } from "../src/dial-domain.js";
import type { CodexDialSettings, DialRuntimeState } from "../src/dial-types.js";
import type { CodexHost, HostHealth, MicroSnapshot, RoutedAgentSlot } from "../src/types.js";

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
  relayClient?: {
    currentHost(): CodexHost | undefined;
    currentHealth(): HostHealth;
    currentSnapshot(): undefined;
    send(command: unknown): Promise<void>;
  };
  microBridge: {
    sendAgent(slot: number, act: 0 | 1, threadKey?: string): Promise<void>;
    sendAction?(slot: string, act: 0 | 1): Promise<void>;
    sendJoystick?(direction: string, distance: 0 | 1): Promise<void>;
    adjustReasoning?(direction: string): Promise<void>;
    runKeycap?(keycapId: string): Promise<void>;
    consumeRateLimitReset?(): Promise<void>;
  };
  pressedAgents: Map<number, unknown>;
  dialDescriptionErrors: Set<string>;
  dialRenderErrors: Set<string>;
  dialSuccessErrors: Set<string>;
  refresh(): Promise<void>;
  refreshInFlight?: Promise<void>;
  refreshLocalUsage(): Promise<MicroSnapshot>;
  renderAll(): Promise<void>;
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

function decodeImage(image: string): string {
  return decodeURIComponent(image.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
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
  await settle();

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
    }
  };

  controller.registerDial(action, expandDialPreset("reasoning"));
  controller.rotateDial(action, 2);
  await idle(controller, action.id);

  assert.deepEqual(attempts, ["attempt-1", "attempt-2"]);
  assert.equal(action.alerts, 1);
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
    touchTap: "usage.rate-limit-reset"
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
        async adjustReasoning(direction) { sends.push(`reasoning:${direction}`); },
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
      async adjustReasoning(direction) { sends.push(`reasoning:${direction}`); },
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
