export type WatcherObservation = {
  now: number;
  generation: string | null;
  bridgeHealthy: boolean;
};

export type WatcherAction =
  | { type: "preserve-initial-session" }
  | { type: "reuse-bridge" }
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
  recoveryAttempts: string[];
};

export const DEFAULT_STARTUP_GRACE_MS = 30_000;
export const DEFAULT_UNBRIDGED_STABLE_MS = 10_000;
export const DEFAULT_RECOVERY_STARTUP_MS = 30_000;
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
    startupGraceUntil: now + DEFAULT_STARTUP_GRACE_MS,
    stoppedSince: null,
    recoveryPendingUntil: Math.max(Number(stored.recoveryPendingUntil) || 0, now + DEFAULT_STARTUP_GRACE_MS),
    recoveryCooldownUntil: Number(stored.recoveryCooldownUntil) || 0,
    unbridgedGeneration: null,
    unbridgedSince: null,
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
  const { now, generation, bridgeHealthy } = observation;

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
    return { state: next, action: { type: "wait", reason: "codex-not-running" } };
  }

  const previousGeneration = next.lastGeneration;
  const observedStoppedInterval = next.stoppedSince != null;
  const generationChanged = previousGeneration != null && previousGeneration !== generation;
  next.lastGeneration = generation;
  next.stoppedSince = null;

  if (bridgeHealthy) {
    next.hadHealthyBridge = true;
    next.recoveryPendingUntil = 0;
    next.suppressedInitialGeneration = null;
    next.unbridgedGeneration = null;
    next.unbridgedSince = null;
    return { state: next, action: { type: "reuse-bridge" } };
  }

  if (next.unbridgedGeneration !== generation) {
    next.unbridgedGeneration = generation;
    next.unbridgedSince = now;
  }

  if (now < next.recoveryPendingUntil) {
    return { state: next, action: { type: "wait", reason: "bridge-startup-pending" } };
  }

  if (previousGeneration == null && next.suppressedInitialGeneration == null && !next.hadHealthyBridge && now < next.startupGraceUntil) {
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
  return { state: next, action: { type: "wait", reason: "bridge-unavailable-degraded" } };
}
