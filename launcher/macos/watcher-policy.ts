export type WatcherObservation = {
  now: number;
  generation: string | null;
  bridgeHealthy: boolean;
  startedAt?: number | null;
};

export type WatcherAction =
  | { type: "preserve-initial-session" }
  | { type: "reuse-bridge" }
  | { type: "recover-bridge"; generation: string }
  | { type: "wait"; reason: string };

export type WatcherPolicyState = {
  initialized: boolean;
  startupGraceUntil: number;
  lastGeneration: string | null;
  suppressedInitialGeneration: string | null;
  stoppedSince: number | null;
  hadHealthyBridge: boolean;
  recoveryPendingUntil: number;
  recoveryCooldownUntil: number;
  unbridgedGeneration: string | null;
  unbridgedSince: number | null;
  startupRecoveryGeneration: string | null;
  recoveryAttempts: string[];
};

export const DEFAULT_STARTUP_GRACE_MS = 30_000;
export const DEFAULT_UNBRIDGED_STABLE_MS = 10_000;
export const DEFAULT_RECOVERY_TRIGGER_MS = 30_000;
export const DEFAULT_RECOVERY_COMPLETION_MS = 60_000;
export const DEFAULT_RECOVERY_COOLDOWN_MS = 10 * 60_000;

export function createWatcherPolicyState(now = Date.now()): WatcherPolicyState {
  return {
    initialized: false,
    startupGraceUntil: now + DEFAULT_STARTUP_GRACE_MS,
    lastGeneration: null,
    suppressedInitialGeneration: null,
    stoppedSince: null,
    hadHealthyBridge: false,
    recoveryPendingUntil: 0,
    recoveryCooldownUntil: 0,
    unbridgedGeneration: null,
    unbridgedSince: null,
    startupRecoveryGeneration: null,
    recoveryAttempts: []
  };
}

export function resumeWatcherPolicyState(
  stored: WatcherPolicyState | null,
  now = Date.now()
): WatcherPolicyState {
  if (!stored) return createWatcherPolicyState(now);
  return {
    ...stored,
    // Persisted history is not an observation by this watcher instance.
    // Its first live observation must preserve any already-running session.
    initialized: false,
    lastGeneration: null,
    suppressedInitialGeneration: null,
    startupGraceUntil: now + DEFAULT_STARTUP_GRACE_MS,
    stoppedSince: null,
    recoveryPendingUntil: Number(stored.recoveryPendingUntil) || 0,
    recoveryCooldownUntil: Number(stored.recoveryCooldownUntil) || 0,
    unbridgedGeneration: null,
    unbridgedSince: null,
    startupRecoveryGeneration: null,
    recoveryAttempts: [...(stored.recoveryAttempts ?? [])].slice(-16)
  };
}

export function evaluateWatcherPolicy(
  state: WatcherPolicyState,
  observation: WatcherObservation
): { state: WatcherPolicyState; action: WatcherAction } {
  const next: WatcherPolicyState = {
    ...state,
    recoveryAttempts: [...state.recoveryAttempts]
  };
  const { now, generation, bridgeHealthy, startedAt } = observation;

  if (!state.initialized) {
    next.initialized = true;
    next.lastGeneration = generation;
    if (generation != null) {
      next.stoppedSince = null;
      if (bridgeHealthy) {
        next.hadHealthyBridge = true;
        return { state: next, action: { type: "reuse-bridge" } };
      }
      next.suppressedInitialGeneration = generation;
      return { state: next, action: { type: "preserve-initial-session" } };
    }
    next.stoppedSince = now;
    return { state: next, action: { type: "wait", reason: "launch-agent-startup-grace" } };
  }

  if (generation == null) {
    if (next.stoppedSince == null) next.stoppedSince = now;
    next.lastGeneration = null;
    next.suppressedInitialGeneration = null;
    next.unbridgedGeneration = null;
    next.unbridgedSince = null;
    next.startupRecoveryGeneration = null;
    return { state: next, action: { type: "wait", reason: "codex-not-running" } };
  }

  const previousGeneration = next.lastGeneration;
  const observedStoppedInterval = next.stoppedSince != null;
  const generationChanged = previousGeneration != null && previousGeneration !== generation;
  next.lastGeneration = generation;
  next.stoppedSince = null;
  if (observedStoppedInterval) next.startupRecoveryGeneration = generation;
  else if (generationChanged) next.startupRecoveryGeneration = null;

  if (bridgeHealthy) {
    next.hadHealthyBridge = true;
    next.recoveryPendingUntil = 0;
    next.suppressedInitialGeneration = null;
    next.unbridgedGeneration = null;
    next.unbridgedSince = null;
    next.startupRecoveryGeneration = null;
    return { state: next, action: { type: "reuse-bridge" } };
  }

  if (next.unbridgedGeneration !== generation) {
    next.unbridgedGeneration = generation;
    next.unbridgedSince = now;
  }

  if (now < next.recoveryPendingUntil) {
    return { state: next, action: { type: "wait", reason: "bridge-startup-pending" } };
  }

  if (previousGeneration == null && !observedStoppedInterval && next.suppressedInitialGeneration == null &&
      !next.hadHealthyBridge && now < next.startupGraceUntil) {
    next.suppressedInitialGeneration = generation;
    return { state: next, action: { type: "preserve-initial-session" } };
  }

  if (now < next.startupGraceUntil && (generationChanged || observedStoppedInterval)) {
    return { state: next, action: { type: "wait", reason: "launch-agent-startup-grace" } };
  }

  if (generation === next.suppressedInitialGeneration && !generationChanged && !observedStoppedInterval) {
    return { state: next, action: { type: "preserve-initial-session" } };
  }

  if (next.unbridgedSince == null || now - next.unbridgedSince < DEFAULT_UNBRIDGED_STABLE_MS) {
    return { state: next, action: { type: "wait", reason: "confirm-stable-unbridged-generation" } };
  }
  const processAge = typeof startedAt === "number" && Number.isFinite(startedAt) ? now - startedAt : Infinity;
  const startupRecoveryEligible = generation === next.startupRecoveryGeneration &&
    generation !== next.suppressedInitialGeneration &&
    processAge >= 0 && processAge <= DEFAULT_RECOVERY_TRIGGER_MS &&
    now >= next.recoveryCooldownUntil && !next.recoveryAttempts.includes(generation);
  if (startupRecoveryEligible) {
    next.recoveryAttempts.push(generation);
    next.recoveryAttempts = next.recoveryAttempts.slice(-16);
    next.recoveryPendingUntil = now + DEFAULT_RECOVERY_COMPLETION_MS;
    next.recoveryCooldownUntil = now + DEFAULT_RECOVERY_COOLDOWN_MS;
    return { state: next, action: { type: "recover-bridge", generation } };
  }
  return { state: next, action: { type: "wait", reason: "bridge-unavailable-degraded" } };
}
