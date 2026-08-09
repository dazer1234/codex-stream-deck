import { OFFICIAL_KEYCAP_IDS } from "./keycaps.js";
import {
  DIAL_FEEDBACK_MODES,
  DIAL_PRESETS,
  DIAL_SELECTOR_SOURCES,
  type CodexDialSettings,
  type DialBindingId,
  type DialFeedbackMode,
  type DialPreset,
  type DialRotation,
  type DialSelectorSource
} from "./dial-types.js";

export const MICRO_SLOTS = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"] as const;
export const JOYSTICK_DIRECTIONS = ["up", "right", "down", "left"] as const;
export const DEFAULT_ACTION_SELECTOR_ITEMS: readonly DialBindingId[] = MICRO_SLOTS.map(
  (slot): DialBindingId => `micro.${slot}`
);

export function expandDialPreset(preset: DialPreset): CodexDialSettings {
  if (preset === "agents") {
    return selectorPreset("agents", "selector.activate", "keycap.TIME", "agent");
  }
  if (preset === "actions") {
    return selectorPreset(
      "actions", "selector.activate", "keycap.SETUP", "action", [...DEFAULT_ACTION_SELECTOR_ITEMS]
    );
  }
  if (preset === "usage") {
    return selectorPreset("usage", "usage.toggle-overview", "usage.refresh", "usage");
  }
  if (preset === "navigation") {
    return pairedPreset(
      "navigation", "joystick.left", "joystick.right", "joystick.up", "joystick.down", "navigation"
    );
  }
  if (preset === "custom") {
    return pairedPreset("custom", "none", "none", "none", "none", "static");
  }
  return pairedPreset(
    "reasoning", "reasoning.decrease", "reasoning.increase", "none", "keycap.FAST", "reasoning"
  );
}

export function isDialBindingId(
  value: unknown,
  gesture: "rotation" | "press" | "touch" | "selector" = "press"
): value is DialBindingId {
  if (typeof value !== "string") return false;
  const valid = value === "none" || value === "selector.activate" ||
    value === "reasoning.decrease" || value === "reasoning.increase" ||
    value === "new-task" || value === "host.toggle" || value === "usage.refresh" ||
    value === "usage.toggle-overview" || value === "usage.rate-limit-reset" ||
    (value.startsWith("micro.") && MICRO_SLOTS.includes(value.slice(6) as typeof MICRO_SLOTS[number])) ||
    (value.startsWith("joystick.") && JOYSTICK_DIRECTIONS.includes(
      value.slice(9) as typeof JOYSTICK_DIRECTIONS[number]
    )) ||
    (value.startsWith("keycap.") && OFFICIAL_KEYCAP_IDS.includes(
      value.slice(7) as typeof OFFICIAL_KEYCAP_IDS[number]
    ));
  if (!valid) return false;
  if (value === "usage.rate-limit-reset" && gesture !== "press") return false;
  if (value === "selector.activate" && gesture !== "press") return false;
  return true;
}

export function normalizeDialSettings(input: unknown): CodexDialSettings {
  if (!record(input) || input.version !== 1 || !isPreset(input.preset)) {
    return expandDialPreset("reasoning");
  }

  const fallback = expandDialPreset(input.preset);
  const staticLabel = typeof input.staticLabel === "string"
    ? input.staticLabel.trim().slice(0, 40)
    : undefined;
  return {
    version: 1,
    preset: input.preset,
    customized: input.customized === true,
    rotation: normalizeRotation(input.rotation, fallback.rotation),
    press: isDialBindingId(input.press, "press") ? input.press : fallback.press,
    touchTap: isDialBindingId(input.touchTap, "touch") ? input.touchTap : "none",
    feedback: isFeedback(input.feedback) ? input.feedback : fallback.feedback,
    ...(staticLabel ? { staticLabel } : {})
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreset(value: unknown): value is DialPreset {
  return typeof value === "string" && DIAL_PRESETS.includes(value as DialPreset);
}

function isFeedback(value: unknown): value is DialFeedbackMode {
  return typeof value === "string" && DIAL_FEEDBACK_MODES.includes(value as DialFeedbackMode);
}

function isSelectorSource(value: unknown): value is DialSelectorSource {
  return typeof value === "string" && DIAL_SELECTOR_SOURCES.includes(value as DialSelectorSource);
}

function pairedPreset(
  preset: DialPreset,
  counterClockwise: DialBindingId,
  clockwise: DialBindingId,
  press: DialBindingId,
  touchTap: DialBindingId,
  feedback: DialFeedbackMode
): CodexDialSettings {
  return {
    version: 1,
    preset,
    customized: false,
    rotation: { kind: "paired", counterClockwise, clockwise },
    press,
    touchTap,
    feedback
  };
}

function selectorPreset(
  preset: DialSelectorSource,
  press: DialBindingId,
  touchTap: DialBindingId,
  feedback: DialFeedbackMode,
  items: DialBindingId[] = []
): CodexDialSettings {
  return {
    version: 1,
    preset,
    customized: false,
    rotation: { kind: "selector", source: preset, wrap: true, items },
    press,
    touchTap,
    feedback
  };
}

function normalizeRotation(value: unknown, fallback: DialRotation): DialRotation {
  if (!record(value)) return fallback;
  if (value.kind === "paired") {
    return {
      kind: "paired",
      counterClockwise: isDialBindingId(value.counterClockwise, "rotation")
        ? value.counterClockwise
        : "none",
      clockwise: isDialBindingId(value.clockwise, "rotation") ? value.clockwise : "none"
    };
  }
  if (value.kind === "selector" && isSelectorSource(value.source) &&
      typeof value.wrap === "boolean" && Array.isArray(value.items)) {
    return {
      kind: "selector",
      source: value.source,
      wrap: value.wrap,
      items: value.items.filter((item): item is DialBindingId =>
        isDialBindingId(item, "selector")).slice(0, 30)
    };
  }
  return fallback;
}
