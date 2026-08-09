export type AgentVisualStatus = "empty" | "idle" | "thinking" | "complete" | "input" | "error";
export type ThemeMode = "light" | "dark";
export type HostHealthState = "ready" | "degraded" | "offline" | "connecting";
export type UsageLimitMode = "auto" | "five-hour" | "weekly";
export type UsageWindowKind = Exclude<UsageLimitMode, "auto"> | "other";

export type HostHealth = {
  state: HostHealthState;
  reason?: "awaiting-snapshot" | "native-signals-unavailable" | "snapshot-stale" | "relay-disconnected" | "local-bridge-unavailable";
  changedAt: number;
};

export type MicroAgentSlot = {
  id: number;
  threadKey: string | null;
  title: string | null;
  status: string;
  selected: boolean;
  activityAt?: number;
  /** True when this host has the backing Codex rollout file for the task. */
  ownedByHost?: boolean;
  /** Percentage of the current model context window consumed by this task. */
  contextUsedPercent?: number;
};

export type MicroActionSlot = "ACT06" | "ACT07" | "ACT08" | "ACT09" | "ACT10_ACT11" | "ACT12";
export type MicroDirection = "up" | "right" | "down" | "left";
export type ReasoningAdjustment = "decrease" | "increase";

export type MicroLayout = {
  version: 1;
  slots: Record<MicroActionSlot, { keycapId: string; commandId?: string }>;
  analogStick: Record<MicroDirection, unknown>;
};

export type HostSessionPresence = {
  threadId: string;
  activityAt: number;
  status: "idle" | "working" | "complete";
  /** Byte offset of the latest structural task_complete event; no task content is exposed. */
  completionRevision?: number;
  /** Content-free context utilization derived from the latest structural token-count event. */
  contextUsedPercent?: number;
};

export type UsageWindow = {
  id: string;
  kind: UsageWindowKind;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type UsageSnapshot = {
  windows: UsageWindow[];
  observedAt: number;
  resetCreditsAvailable: number | null;
  resetCreditsApplicable: number | null;
};

export type MicroSnapshot = {
  slots: MicroAgentSlot[];
  /** Current reasoning effort selected in the active renderer composer. */
  reasoningEffort?: string;
  /** Whether the active visible Codex reasoning trigger authoritatively reports Fast mode. */
  fastModeEnabled?: boolean;
  /** Task currently open in the Codex renderer, even when it is outside the six native Micro slots. */
  activeThreadKey?: string;
  /** User-visible title for the active task, including tasks outside the six Micro slots. */
  activeThreadTitle?: string;
  layout: MicroLayout;
  agentSource: "pinned" | "recent" | "priority" | "custom";
  lightingAutoOff: string;
  theme: ThemeMode;
  /** Account usage read from Codex's authenticated renderer client. */
  usage?: UsageSnapshot;
  /** Recent local rollout identities used to disambiguate cross-host mirrors. */
  hostSessions?: HostSessionPresence[];
};

export type CodexHost = {
  hostId: string;
  hostName: string;
  platform: "win32" | "darwin";
  codexVersion?: string;
};

export type RoutedAgentSlot = MicroAgentSlot & {
  host: CodexHost;
  sourceSlot: number;
  observedAt: number;
};
