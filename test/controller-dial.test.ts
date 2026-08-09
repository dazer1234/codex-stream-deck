import assert from "node:assert/strict";
import test from "node:test";
import type { DialAction } from "@elgato/streamdeck";
import { DeckController } from "../src/controller.js";
import { expandDialPreset, type DialCommandQueue } from "../src/dial-domain.js";
import type { CodexDialSettings, DialRuntimeState } from "../src/dial-types.js";
import type { CodexHost, RoutedAgentSlot } from "../src/types.js";

type FakeDial = DialAction<CodexDialSettings> & {
  feedbackCalls: unknown[];
  triggerCalls: unknown[];
  alerts: number;
  oks: number;
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
  microBridge: {
    sendAgent(slot: number, act: 0 | 1, threadKey?: string): Promise<void>;
  };
};

const HOST: CodexHost = {
  hostId: "host-a",
  hostName: "Mac",
  platform: "darwin"
};

function fakeDial(id: string, options: { rejectDescriptions?: boolean } = {}): FakeDial {
  const dial = {
    id,
    feedbackCalls: [] as unknown[],
    triggerCalls: [] as unknown[],
    alerts: 0,
    oks: 0,
    async setFeedback(payload: unknown) { this.feedbackCalls.push(payload); },
    async setTriggerDescription(payload: unknown) {
      this.triggerCalls.push(payload);
      if (options.rejectDescriptions) throw new Error("description unavailable");
    },
    async showAlert() { this.alerts += 1; },
    async showOk() { this.oks += 1; }
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
  probe(controller).routedSlots = [routedAgent(0, "thread-a"), routedAgent(1, "thread-b")];
  controller.sendAgent = async (slot, act, expectedThreadKey) => {
    calls.push([slot, act, expectedThreadKey]);
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
  controller.adjustReasoning = async () => {
    attempts.push(`attempt-${attempts.length + 1}`);
    if (attempts.length === 1) throw new Error("first detent failed");
  };

  controller.registerDial(action, expandDialPreset("reasoning"));
  controller.rotateDial(action, 2);
  await idle(controller, action.id);

  assert.deepEqual(attempts, ["attempt-1", "attempt-2"]);
  assert.equal(action.alerts, 1);
});

test("rate-limit reset remains press-only and reports success only after a completed hold", async () => {
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
  assert.equal(action.oks, 0, "a short hold is a no-op");
  await controller.beginDialPress(action);
  await controller.finishDialPress(action);
  assert.equal(action.oks, 1);
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
  controller.runKeycap = async (keycapId) => { keycaps.push(keycapId); };

  controller.registerDial(action, settings);
  controller.rotateDial(action, 1);
  await idle(controller, action.id);
  assert.deepEqual(keycaps, []);
  await controller.beginDialPress(action);
  assert.deepEqual(keycaps, ["APPR"]);
});
