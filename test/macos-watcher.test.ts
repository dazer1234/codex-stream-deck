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

test("every unbridged process generation is preserved", () => {
  let state = createWatcherPolicyState(0);
  for (const generation of ["A", "A", "B", "UPDATE", "LOGIN"]) {
    const result = evaluateWatcherPolicy(state, { now: 1_000_000, generation, bridgeHealthy: false });
    assert.equal(result.action.type, "preserve-session");
    assert.equal(result.state.lastGeneration, generation);
    state = result.state;
  }
});

test("a healthy bridge is reused and losing it never restarts the session", () => {
  const healthy = evaluateWatcherPolicy(createWatcherPolicyState(0), { now: 0, generation: "A", bridgeHealthy: true });
  assert.equal(healthy.action.type, "reuse-bridge");
  const missing = evaluateWatcherPolicy(healthy.state, { now: 900_000, generation: "A", bridgeHealthy: false });
  assert.equal(missing.action.type, "preserve-session");
  const recovered = evaluateWatcherPolicy(missing.state, { now: 910_000, generation: "A", bridgeHealthy: true });
  assert.equal(recovered.action.type, "reuse-bridge");
});

test("closed Codex stays closed before and after a healthy bridge", () => {
  for (const hadHealthyBridge of [true, false]) {
    const result = evaluateWatcherPolicy({ ...createWatcherPolicyState(), hadHealthyBridge },
      { now: 900_000, generation: null, bridgeHealthy: false });
    assert.deepEqual(result.action, { type: "wait", reason: "codex-not-running" });
  }
});

test("policy migration discards obsolete recovery permissions and validates stored fields", () => {
  assert.deepEqual(resumeWatcherPolicyState({ lastGeneration: "A", hadHealthyBridge: true, recoveryAttempts: ["A"] }),
    { lastGeneration: "A", hadHealthyBridge: true });
  assert.deepEqual(resumeWatcherPolicyState({ lastGeneration: 123, hadHealthyBridge: "yes" }), createWatcherPolicyState());
  assert.deepEqual(resumeWatcherPolicyState(null), createWatcherPolicyState());
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

test("duplicate watcher instances exit safely under a PID lock", { skip: process.platform !== "darwin" }, async () => {
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
