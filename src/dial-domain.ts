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

export const MICRO_SLOTS = Object.freeze(
  ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"] as const
);
export const JOYSTICK_DIRECTIONS = Object.freeze(["up", "right", "down", "left"] as const);
export const DEFAULT_ACTION_SELECTOR_ITEMS: readonly DialBindingId[] = Object.freeze(
  MICRO_SLOTS.map((slot): DialBindingId => `micro.${slot}`)
);

const PRESET_IDS = new Set<string>(DIAL_PRESETS);
const FEEDBACK_MODE_IDS = new Set<string>(DIAL_FEEDBACK_MODES);
const SELECTOR_SOURCE_IDS = new Set<string>(DIAL_SELECTOR_SOURCES);
const MICRO_SLOT_IDS = new Set<string>(MICRO_SLOTS);
const JOYSTICK_DIRECTION_IDS = new Set<string>(JOYSTICK_DIRECTIONS);
const OFFICIAL_KEYCAP_ID_SET = new Set<string>(OFFICIAL_KEYCAP_IDS);

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
    (value.startsWith("micro.") && MICRO_SLOT_IDS.has(value.slice(6))) ||
    (value.startsWith("joystick.") && JOYSTICK_DIRECTION_IDS.has(value.slice(9))) ||
    (value.startsWith("keycap.") && OFFICIAL_KEYCAP_ID_SET.has(value.slice(7)));
  if (!valid) return false;
  if (value === "usage.rate-limit-reset" && gesture !== "press") return false;
  if (value === "selector.activate" && gesture !== "press") return false;
  return true;
}

export function normalizeDialSettings(input: unknown): CodexDialSettings {
  if (!record(input) || !hasOwn(input, "version") || input.version !== 1 ||
      !hasOwn(input, "preset") || !isPreset(input.preset)) {
    return expandDialPreset("reasoning");
  }

  const fallback = expandDialPreset(input.preset);
  const staticLabel = hasOwn(input, "staticLabel") && typeof input.staticLabel === "string"
    ? input.staticLabel.trim().slice(0, 40)
    : undefined;
  return {
    version: 1,
    preset: input.preset,
    customized: hasOwn(input, "customized") && input.customized === true,
    rotation: normalizeRotation(hasOwn(input, "rotation") ? input.rotation : undefined, fallback.rotation),
    press: hasOwn(input, "press") && isDialBindingId(input.press, "press")
      ? input.press
      : fallback.press,
    touchTap: hasOwn(input, "touchTap") && isDialBindingId(input.touchTap, "touch")
      ? input.touchTap
      : "none",
    feedback: hasOwn(input, "feedback") && isFeedback(input.feedback)
      ? input.feedback
      : fallback.feedback,
    ...(staticLabel ? { staticLabel } : {})
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isPreset(value: unknown): value is DialPreset {
  return typeof value === "string" && PRESET_IDS.has(value);
}

function isFeedback(value: unknown): value is DialFeedbackMode {
  return typeof value === "string" && FEEDBACK_MODE_IDS.has(value);
}

function isSelectorSource(value: unknown): value is DialSelectorSource {
  return typeof value === "string" && SELECTOR_SOURCE_IDS.has(value);
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
  if (!record(value) || !hasOwn(value, "kind")) return fallback;
  if (value.kind === "paired") {
    return {
      kind: "paired",
      counterClockwise: hasOwn(value, "counterClockwise") &&
        isDialBindingId(value.counterClockwise, "rotation")
        ? value.counterClockwise
        : "none",
      clockwise: hasOwn(value, "clockwise") && isDialBindingId(value.clockwise, "rotation")
        ? value.clockwise
        : "none"
    };
  }
  if (value.kind === "selector" && hasOwn(value, "source") && isSelectorSource(value.source) &&
      hasOwn(value, "wrap") && typeof value.wrap === "boolean" &&
      hasOwn(value, "items") && Array.isArray(value.items)) {
    return {
      kind: "selector",
      source: value.source,
      wrap: value.wrap,
      items: value.source === "actions"
        ? value.items.filter((item): item is DialBindingId =>
          isDialBindingId(item, "selector")).slice(0, 30)
        : []
    };
  }
  return fallback;
}
