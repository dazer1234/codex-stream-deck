import type { OfficialKeycapId } from "./keycaps.js";
import type { HostHealthState, MicroActionSlot, MicroDirection } from "./types.js";

export type JsonValue = boolean | number | string | null | undefined | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export const DIAL_PRESETS = Object.freeze(
  ["reasoning", "agents", "actions", "navigation", "usage", "custom", "model-presets"] as const
);
export type DialPreset = typeof DIAL_PRESETS[number];
export type LegacyDialPreset = Exclude<DialPreset, "model-presets">;

export const DIAL_FEEDBACK_MODES = Object.freeze(
  ["auto", "reasoning", "agent", "action", "navigation", "usage", "static", "model-presets"] as const
);
export type DialFeedbackMode = typeof DIAL_FEEDBACK_MODES[number];
export type LegacyDialFeedbackMode = Exclude<DialFeedbackMode, "model-presets">;

export const DIAL_SELECTOR_SOURCES = Object.freeze(["agents", "actions", "usage"] as const);
export type DialSelectorSource = typeof DIAL_SELECTOR_SOURCES[number];

export type DialBindingId =
  | "none" | "selector.activate"
  | "reasoning.decrease" | "reasoning.increase"
  | "new-task" | "host.toggle"
  | "usage.refresh" | "usage.toggle-overview" | "usage.rate-limit-reset"
  | `micro.${MicroActionSlot}` | `joystick.${MicroDirection}` | `keycap.${OfficialKeycapId}`;

export interface PairedDialRotation extends JsonObject {
  kind: "paired";
  counterClockwise: DialBindingId;
  clockwise: DialBindingId;
}

export interface SelectorDialRotation extends JsonObject {
  kind: "selector";
  source: DialSelectorSource;
  wrap: boolean;
  items: DialBindingId[];
}

export interface ModelPresetRotation extends JsonObject {
  kind: "model-presets";
}

export interface ModelPresetEntry extends JsonObject {
  modelId: string;
  reasoningEffort: string;
}

export type LegacyDialRotation = PairedDialRotation | SelectorDialRotation;
export type DialRotation = LegacyDialRotation | ModelPresetRotation;

export interface CodexDialSettingsBase extends JsonObject {
  customized: boolean;
  includeUltraReasoning: boolean;
  press: DialBindingId;
  touchTap: DialBindingId;
  staticLabel?: string;
}

export interface CodexDialSettingsV1 extends CodexDialSettingsBase {
  version: 1;
  preset: LegacyDialPreset;
  rotation: LegacyDialRotation;
  feedback: LegacyDialFeedbackMode;
}

export interface ExistingDialSettingsV2 extends CodexDialSettingsBase {
  version: 2;
  preset: LegacyDialPreset;
  rotation: LegacyDialRotation;
  feedback: LegacyDialFeedbackMode;
}

export interface ModelPresetsDialSettings extends CodexDialSettingsBase {
  version: 2;
  preset: "model-presets";
  rotation: ModelPresetRotation;
  feedback: "model-presets";
  modelPresets: ModelPresetEntry[];
}

export type CodexDialSettings = ExistingDialSettingsV2 | ModelPresetsDialSettings;

export type ModelPresetDirection = "clockwise" | "counter-clockwise";
export type ModelPresetResolution =
  | { kind: "target"; entry: ModelPresetEntry; index: number; count: number }
  | { kind: "empty" }
  | { kind: "unavailable" };

export type DialSelectorItem = {
  id: string;
  label: string;
  detail?: string;
  binding?: DialBindingId;
  agentSlot?: number;
  threadKey?: string;
};

export type DialRuntimeState = {
  selectedId?: string;
  selectedIndex?: number;
  usageMode: "auto" | "five-hour" | "weekly";
  usageOverview: boolean;
  modelPresetSwitching?: boolean;
};

export type DialRuntimeModelCatalogEntry = {
  modelId: string;
  displayName: string;
  supportedReasoningEfforts: string[];
};

export type DialRuntimeAgent = {
  id: number;
  identity: string;
  threadKey: string;
  title: string;
  status: string;
  health: HostHealthState;
  hostBadge?: "M" | "W";
  contextUsedPercent?: number;
};

export type DialRuntimeUsage = {
  mode: "auto" | "five-hour" | "weekly";
  remainingPercent?: number;
  resetsAt?: number | null;
  observedAt?: number;
  fiveHourRemaining?: number;
  weeklyRemaining?: number;
};

export type DialRuntimeView = {
  health: HostHealthState;
  reasoningEffort?: string;
  activeModelId?: string;
  activeModelDisplayName?: string;
  modelCatalog?: DialRuntimeModelCatalogEntry[];
  agents: DialRuntimeAgent[];
  actionLabels: Partial<Record<DialBindingId, string>>;
  usage?: DialRuntimeUsage;
  now: number;
};

export type DialFeedback = {
  title: string;
  value: string;
  detail: string;
  indicator: number;
  accent: string;
};
