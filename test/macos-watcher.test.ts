import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquirePidLock, isBridgeStateStale, removeStaleBridgeStateFile } from "../launcher/macos/codex-deck-macos.js";
import {
  createWatcherPolicyState,
  evaluateWatcherPolicy,
  resumeWatcherPolicyState
} from "../launcher/macos/watcher-policy.js";

test("initial existing normal session remains untouched", () => {
  const result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "A", bridgeHealthy: false
  });
  assert.equal(result.action.type, "preserve-initial-session");
  assert.equal(result.state.suppressedInitialGeneration, "A");
});

test("same process generation remains degraded without recovery restart", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "A", bridgeHealthy: true
  });
  result = evaluateWatcherPolicy(result.state, { now: 30_000, generation: "B", bridgeHealthy: false });
  result = evaluateWatcherPolicy(result.state, { now: 40_000, generation: "B", bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" });
  result = evaluateWatcherPolicy(result.state, { now: 71_000, generation: "B", bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" });
});

test("rapid main-process replacement is detected without observing a stopped poll", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "A", bridgeHealthy: true
  });
  result = evaluateWatcherPolicy(result.state, { now: 30_000, generation: "B", bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "confirm-stable-unbridged-generation" });
  result = evaluateWatcherPolicy(result.state, { now: 40_000, generation: "B", bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" });
});

test("a previously healthy bridge can remain unavailable without restarting Codex", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "A", bridgeHealthy: true
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 30_000, generation: "B", bridgeHealthy: false
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 45_000, generation: "B", bridgeHealthy: false
  });
  assert.deepEqual(result.action, {
    type: "wait",
    reason: "bridge-unavailable-degraded"
  });
});

test("an observed stopped interval never auto-launches Codex", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "A", bridgeHealthy: true
  });
  result = evaluateWatcherPolicy(result.state, { now: 6_000, generation: null, bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "codex-not-running" });
  result = evaluateWatcherPolicy(result.state, { now: 8_001, generation: null, bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "codex-not-running" });
});

test("a newly opened normal Codex session gets one startup-only bridge recovery", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: null, bridgeHealthy: false, startedAt: null
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 100_000, generation: "B", bridgeHealthy: false, startedAt: 100_000
  });
  assert.deepEqual(result.action, { type: "wait", reason: "confirm-stable-unbridged-generation" });
  result = evaluateWatcherPolicy(result.state, {
    now: 110_000, generation: "B", bridgeHealthy: false, startedAt: 100_000
  });
  assert.deepEqual(result.action, { type: "recover-bridge", generation: "B" });
  result = evaluateWatcherPolicy(result.state, {
    now: 111_000, generation: "B", bridgeHealthy: false, startedAt: 100_000
  });
  assert.notEqual(result.action.type, "recover-bridge", "the same generation is never restarted twice");
});

test("an older unbridged Codex session is never restarted as startup recovery", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: null, bridgeHealthy: false, startedAt: null
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 100_000, generation: "OLD", bridgeHealthy: false, startedAt: 1_000
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 110_000, generation: "OLD", bridgeHealthy: false, startedAt: 1_000
  });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" });
});

test("previous healthy bridge stays degraded after app update replacement", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "A:/Applications/Old.app", bridgeHealthy: true
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 30_000, generation: "B:/Applications/New.app", bridgeHealthy: false
  });
  assert.equal(result.action.type, "wait");
  result = evaluateWatcherPolicy(result.state, {
    now: 40_000, generation: "B:/Applications/New.app", bridgeHealthy: false
  });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" });
});

test("replacement generations never enter an automatic recovery circuit", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "A", bridgeHealthy: true
  });
  result = evaluateWatcherPolicy(result.state, { now: 30_000, generation: "B", bridgeHealthy: false });
  result = evaluateWatcherPolicy(result.state, { now: 40_000, generation: "B", bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" });
  result = evaluateWatcherPolicy(result.state, { now: 71_000, generation: "C", bridgeHealthy: false });
  assert.deepEqual(result.action, { type: "wait", reason: "confirm-stable-unbridged-generation" });
});

test("LaunchAgent startup race recovers only when it observed Codex was initially stopped", () => {
  let fresh = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: null, bridgeHealthy: false, startedAt: null
  });
  fresh = evaluateWatcherPolicy(fresh.state, {
    now: 2_000, generation: "LOGIN", bridgeHealthy: false, startedAt: 2_000
  });
  assert.deepEqual(fresh.action, { type: "wait", reason: "launch-agent-startup-grace" });
  fresh = evaluateWatcherPolicy(fresh.state, {
    now: 12_000, generation: "LOGIN", bridgeHealthy: false, startedAt: 2_000
  });
  assert.deepEqual(fresh.action, { type: "recover-bridge", generation: "LOGIN" });

  let prior = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "OLD", bridgeHealthy: true
  }).state;
  prior = resumeWatcherPolicyState(prior, 100_000);
  let resumed = evaluateWatcherPolicy(prior, { now: 101_000, generation: "LOGIN", bridgeHealthy: false });
  assert.deepEqual(resumed.action, { type: "preserve-initial-session" });
  resumed = evaluateWatcherPolicy(resumed.state, { now: 130_000, generation: "LOGIN", bridgeHealthy: false });
  assert.deepEqual(resumed.action, { type: "preserve-initial-session" });
});

test("resumed watcher recovers a newly opened session without spending the trigger window on artificial pending", () => {
  const stored = evaluateWatcherPolicy(createWatcherPolicyState(-100_000), {
    now: -100_000, generation: "OLD", bridgeHealthy: true
  }).state;
  let result = evaluateWatcherPolicy(resumeWatcherPolicyState(stored, 0), {
    now: 0, generation: null, bridgeHealthy: false, startedAt: null
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 2_000, generation: "LOGIN", bridgeHealthy: false, startedAt: 2_000
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 12_000, generation: "LOGIN", bridgeHealthy: false, startedAt: 2_000
  });
  assert.deepEqual(result.action, { type: "recover-bridge", generation: "LOGIN" });
});

test("resumed watcher preserves even a young session already running on its first observation", () => {
  const stored = evaluateWatcherPolicy(createWatcherPolicyState(-100_000), {
    now: -100_000, generation: "OLD", bridgeHealthy: true
  }).state;
  let result = evaluateWatcherPolicy(resumeWatcherPolicyState(stored, 0), {
    now: 1_000, generation: "EXISTING", bridgeHealthy: false, startedAt: -1_000
  });
  assert.deepEqual(result.action, { type: "preserve-initial-session" });
  result = evaluateWatcherPolicy(result.state, {
    now: 12_000, generation: "EXISTING", bridgeHealthy: false, startedAt: -1_000
  });
  assert.deepEqual(result.action, { type: "preserve-initial-session" });
});

test("resuming retains a real pending recovery and cooldown instead of replacing them with login grace", () => {
  const stored = { ...createWatcherPolicyState(-100_000), initialized: true,
    recoveryPendingUntil: 9_000, recoveryCooldownUntil: 20_000, recoveryAttempts: ["ATTEMPTED"] };
  const resumed = resumeWatcherPolicyState(stored, 0);
  assert.equal(resumed.recoveryPendingUntil, 9_000);
  assert.equal(resumed.recoveryCooldownUntil, 20_000);
  assert.deepEqual(resumed.recoveryAttempts, ["ATTEMPTED"]);
  let result = evaluateWatcherPolicy(resumed, { now: 0, generation: null, bridgeHealthy: false });
  result = evaluateWatcherPolicy(result.state, { now: 2_000, generation: "NEW", bridgeHealthy: false, startedAt: 2_000 });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-startup-pending" });
  result = evaluateWatcherPolicy(result.state, { now: 12_000, generation: "NEW", bridgeHealthy: false, startedAt: 2_000 });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" });
  result = evaluateWatcherPolicy(result.state, { now: 20_000, generation: "NEW", bridgeHealthy: false, startedAt: 2_000 });
  assert.deepEqual(result.action, { type: "recover-bridge", generation: "NEW" });
});

test("a young app replacement without an observed stopped interval is never auto-restarted", () => {
  let result = evaluateWatcherPolicy(createWatcherPolicyState(0), {
    now: 0, generation: "A", bridgeHealthy: true, startedAt: 0
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 100_000, generation: "B", bridgeHealthy: false, startedAt: 100_000
  });
  result = evaluateWatcherPolicy(result.state, {
    now: 110_000, generation: "B", bridgeHealthy: false, startedAt: 100_000
  });
  assert.deepEqual(result.action, { type: "wait", reason: "bridge-unavailable-degraded" });
});

test("stale port state is identified while the live port is retained", () => {
  assert.equal(isBridgeStateStale(56_871, 56_871), false);
  assert.equal(isBridgeStateStale(56_871, 56_872), true);
  assert.equal(isBridgeStateStale(70_000, null), true);
  assert.equal(isBridgeStateStale("not-a-port", null), true);
});

test("stale bridge-port file is removed but the active one is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-state-test-"));
  try {
    const path = join(root, "codex-micro-bridge.json");
    await writeFile(path, `${JSON.stringify({ port: 56_871 })}\n`);
    assert.equal(await removeStaleBridgeStateFile(path, 56_871), false);
    assert.match(await readFile(path, "utf8"), /56871/);
    assert.equal(await removeStaleBridgeStateFile(path, null), true);
    await assert.rejects(readFile(path, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate watcher instances exit safely under a PID lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-lock-test-"));
  try {
    const lockPath = join(root, "watcher.lock");
    const release = await acquirePidLock(lockPath);
    assert.ok(release);
    assert.equal(await acquirePidLock(lockPath), null);
    await release();
    const reacquired = await acquirePidLock(lockPath);
    assert.ok(reacquired);
    await reacquired();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
