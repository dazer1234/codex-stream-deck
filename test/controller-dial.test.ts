import assert from "node:assert/strict";
import test from "node:test";
import type { DialAction } from "@elgato/streamdeck";
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
    adjustReasoning?(direction: string): Promise<void>;
    runKeycap?(keycapId: string): Promise<void>;
    consumeRateLimitReset?(): Promise<void>;
  };
  pressedAgents: Map<number, RoutedAgentSlot>;
  refresh(): Promise<void>;
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

function fakeDial(id: string, options: { rejectDescriptions?: boolean } = {}): FakeDial {
  const dial = {
    id,
    feedbackCalls: [] as unknown[],
    triggerCalls: [] as unknown[],
    alerts: 0,
    async setFeedback(payload: unknown) { this.feedbackCalls.push(payload); },
    async setTriggerDescription(payload: unknown) {
      this.triggerCalls.push(payload);
      if (options.rejectDescriptions) throw new Error("description unavailable");
    },
    async showAlert() { this.alerts += 1; }
  };
  return dial as unknown as FakeDial;
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

test("paired detents continue after a dispatch failure and alert only the failing command", async () => {
  const controller = new DeckController();
  const action = fakeDial("reasoning-errors");
  const attempts: string[] = [];
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
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
  assert.equal(state.pressedAgents.size, 0, "failed agent down leaves no saved keypad route");
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

test("two dials pressing the same momentary binding keep independent captured hosts", async () => {
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

test("failed momentary down suppresses unmatched up and a duplicate alert", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  const action = fakeDial("failed-down");
  const events: Array<[string, 0 | 1]> = [];
  state.localHost = HOST;
  state.targetPlatform = HOST.platform;
  state.targetHostId = HOST.hostId;
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
  controller.unregisterDial(oldAction);
  assert.equal(probe(controller).dials.has(newAction.id), true, "an old disappear cannot remove the new instance");
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
