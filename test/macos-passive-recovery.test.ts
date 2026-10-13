import assert from "node:assert/strict";
import test from "node:test";
import { createWatcherPolicyState, evaluateWatcherPolicy, resumeWatcherPolicyState } from "../launcher/macos/watcher-policy.js";

test("normal launch after a closed interval never authorizes a restart", () => {
  let state = evaluateWatcherPolicy(createWatcherPolicyState(0), { now: 0, generation: "A", bridgeHealthy: true }).state;
  for (const observation of [
    { now: 60_000, generation: null, bridgeHealthy: false },
    { now: 120_000, generation: "B", bridgeHealthy: false },
    { now: 150_000, generation: "B", bridgeHealthy: false },
    { now: 900_000, generation: "B", bridgeHealthy: false }
  ]) {
    const result = evaluateWatcherPolicy(state, observation);
    assert.notEqual(result.action.type, "restart-for-recovery");
    state = result.state;
  }
});

test("lost bridge and replacement generations remain non-destructive after cooldowns", () => {
  let state = evaluateWatcherPolicy(createWatcherPolicyState(0), { now: 0, generation: "A", bridgeHealthy: true }).state;
  for (let index = 1; index <= 20; index++) {
    const now = index * 900_000;
    state = evaluateWatcherPolicy(state, { now, generation: String(index), bridgeHealthy: false }).state;
    const result = evaluateWatcherPolicy(state, { now: now + 60_000, generation: String(index), bridgeHealthy: false });
    assert.notEqual(result.action.type, "restart-for-recovery");
    state = result.state;
  }
});

test("resuming pre-fix healthy policy cannot grant permission to restart", () => {
  const stored = {
    ...createWatcherPolicyState(0), initialized: true,
    lastGeneration: "OLD", hadHealthyBridge: true,
    recoveryPendingUntil: 0, recoveryCooldownUntil: 0,
  };
  let state = resumeWatcherPolicyState(stored, 100_000);
  state = evaluateWatcherPolicy(state, { now: 131_000, generation: "NEW", bridgeHealthy: false }).state;
  const result = evaluateWatcherPolicy(state, { now: 150_000, generation: "NEW", bridgeHealthy: false });
  assert.notEqual(result.action.type, "restart-for-recovery");
});
