import type { OfficialKeycapId } from "./keycaps.js";
import type { MicroActionSlot, MicroDirection } from "./types.js";

export type JsonValue = boolean | number | string | null | undefined | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export const DIAL_PRESETS = Object.freeze(
  ["reasoning", "agents", "actions", "navigation", "usage", "custom"] as const
);
export type DialPreset = typeof DIAL_PRESETS[number];

export const DIAL_FEEDBACK_MODES = Object.freeze(
  ["auto", "reasoning", "agent", "action", "navigation", "usage", "static"] as const
);
export type DialFeedbackMode = typeof DIAL_FEEDBACK_MODES[number];

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

export type DialRotation = PairedDialRotation | SelectorDialRotation;

export interface CodexDialSettings extends JsonObject {
  version: 1;
  preset: DialPreset;
  customized: boolean;
  rotation: DialRotation;
  press: DialBindingId;
  touchTap: DialBindingId;
  feedback: DialFeedbackMode;
  staticLabel?: string;
}

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
  usageMode: "auto" | "five-hour" | "weekly";
  usageOverview: boolean;
};

export type DialFeedback = {
  title: string;
  value: string;
  detail: string;
  indicator: number;
  accent: string;
};
