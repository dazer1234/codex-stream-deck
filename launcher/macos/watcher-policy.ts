export type WatcherObservation = {
  now: number;
  generation: string | null;
  bridgeHealthy: boolean;
};

export type WatcherAction =
  | { type: "preserve-session" }
  | { type: "reuse-bridge" }
  | { type: "wait"; reason: "codex-not-running" };

export type WatcherPolicyState = {
  lastGeneration: string | null;
  hadHealthyBridge: boolean;
};

export function createWatcherPolicyState(_now = Date.now()): WatcherPolicyState {
  return { lastGeneration: null, hadHealthyBridge: false };
}

export function resumeWatcherPolicyState(stored: unknown, _now = Date.now()): WatcherPolicyState {
  // Old recovery timers and attempted generations must not authorize a restart.
  if (!stored || typeof stored !== "object") return createWatcherPolicyState();
  const previous = stored as Partial<WatcherPolicyState>;
  return {
    lastGeneration: typeof previous.lastGeneration === "string" ? previous.lastGeneration : null,
    hadHealthyBridge: previous.hadHealthyBridge === true
  };
}

export function evaluateWatcherPolicy(
  state: WatcherPolicyState,
  observation: WatcherObservation
): { state: WatcherPolicyState; action: WatcherAction } {
  const { generation, bridgeHealthy } = observation;
  const next = {
    lastGeneration: generation,
    hadHealthyBridge: state.hadHealthyBridge || (generation != null && bridgeHealthy)
  };
  if (generation == null) {
    return { state: next, action: { type: "wait", reason: "codex-not-running" } };
  }
  if (bridgeHealthy) return { state: next, action: { type: "reuse-bridge" } };
  // Missing DevTools is a connectivity condition, never permission to kill the app.
  return { state: next, action: { type: "preserve-session" } };
}
