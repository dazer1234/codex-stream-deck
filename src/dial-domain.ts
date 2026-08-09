import { OFFICIAL_KEYCAP_IDS } from "./keycaps.js";
import {
  DIAL_FEEDBACK_MODES,
  DIAL_PRESETS,
  DIAL_SELECTOR_SOURCES,
  type CodexDialSettings,
  type DialBindingId,
  type DialFeedback,
  type DialFeedbackMode,
  type DialPreset,
  type DialRuntimeState,
  type DialRuntimeView,
  type DialRotation,
  type DialSelectorItem,
  type DialSelectorSource
} from "./dial-types.js";

export const MICRO_SLOTS = Object.freeze(
  ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"] as const
);
export const JOYSTICK_DIRECTIONS = Object.freeze(["up", "right", "down", "left"] as const);
export const DEFAULT_ACTION_SELECTOR_ITEMS: readonly DialBindingId[] = Object.freeze(
  MICRO_SLOTS.map((slot): DialBindingId => `micro.${slot}`)
);

export function bindingLifecycle(
  binding: DialBindingId
): "none" | "one-shot" | "momentary" | "hold" {
  if (binding === "none") return "none";
  if (binding === "usage.rate-limit-reset") return "hold";
  if (binding.startsWith("micro.") || binding.startsWith("joystick.")) return "momentary";
  return "one-shot";
}

export class DialCommandQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(operation: () => Promise<void>): void {
    this.tail = this.tail.then(operation, operation).catch(() => undefined);
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

const PRESET_IDS = new Set<string>(DIAL_PRESETS);
const FEEDBACK_MODE_IDS = new Set<string>(DIAL_FEEDBACK_MODES);
const SELECTOR_SOURCE_IDS = new Set<string>(DIAL_SELECTOR_SOURCES);
const MICRO_SLOT_IDS = new Set<string>(MICRO_SLOTS);
const JOYSTICK_DIRECTION_IDS = new Set<string>(JOYSTICK_DIRECTIONS);
const OFFICIAL_KEYCAP_ID_SET = new Set<string>(OFFICIAL_KEYCAP_IDS);
// Stream Deck dial events are far smaller; this rejects corrupted counts while preserving every
// detent from any physically plausible SDK event.
const MAX_DIAL_TICKS_PER_EVENT = 4_096;
const DIAL_ACCENTS = Object.freeze({
  blue: "#1683FF",
  green: "#35D86B",
  orange: "#FF9A3D",
  red: "#FF4B61",
  teal: "#4CE0C2",
  muted: "#707B85"
} as const);

export function initialDialRuntimeState(): DialRuntimeState {
  return { usageMode: "auto", usageOverview: false };
}

export function selectorItems(
  settings: CodexDialSettings,
  view: DialRuntimeView
): DialSelectorItem[] {
  if (settings.rotation.kind !== "selector") return [];
  if (settings.rotation.source === "agents") {
    return view.agents.map((agent) => {
      const displayNumber = agentDisplayNumber(agent.id);
      return {
        id: agent.identity,
        label: cleanDisplaySource(agent.title) ?? `Agent ${displayNumber}`,
        detail: cleanDisplaySource(agent.status) ?? "unknown",
        agentSlot: agent.id,
        threadKey: agent.threadKey
      };
    });
  }
  if (settings.rotation.source === "usage") {
    return [
      { id: "auto", label: "Auto" },
      { id: "five-hour", label: "5h" },
      { id: "weekly", label: "Weekly" }
    ];
  }
  return settings.rotation.items.map((binding) => ({
    id: binding,
    label: cleanActionLabel(view.actionLabels[binding]) ?? dialBindingLabel(binding),
    binding
  }));
}

export function reconcileSelector(
  state: DialRuntimeState,
  items: readonly DialSelectorItem[]
): DialRuntimeState {
  if (items.length === 0) {
    const { selectedId: _selectedId, ...cleared } = state;
    return { ...cleared };
  }
  const selectedId = items.some((item) => item.id === state.selectedId)
    ? state.selectedId
    : items[0]!.id;
  return { ...state, selectedId };
}

export function reduceDialRotation(
  settings: CodexDialSettings,
  state: DialRuntimeState,
  view: DialRuntimeView,
  ticks: number
): { state: DialRuntimeState; bindings: DialBindingId[] } {
  if (!Number.isSafeInteger(ticks) || ticks === 0 || Math.abs(ticks) > MAX_DIAL_TICKS_PER_EVENT) {
    return { state, bindings: [] };
  }
  if (settings.rotation.kind === "paired") {
    const binding = ticks > 0
      ? settings.rotation.clockwise
      : settings.rotation.counterClockwise;
    const bindings: DialBindingId[] = [];
    for (let detent = 0; detent < Math.abs(ticks); detent += 1) bindings.push(binding);
    return { state, bindings };
  }

  const items = selectorItems(settings, view);
  const reconciled = reconcileSelector(state, items);
  if (items.length === 0) return { state: reconciled, bindings: [] };
  const currentIndex = Math.max(0, items.findIndex((item) => item.id === reconciled.selectedId));
  const nextIndex = settings.rotation.wrap
    ? modulo(currentIndex + (ticks % items.length), items.length)
    : Math.min(items.length - 1, Math.max(0, currentIndex + ticks));
  const selectedId = items[nextIndex]!.id;
  return {
    state: {
      ...reconciled,
      selectedId,
      ...(settings.rotation.source === "usage"
        ? { usageMode: usageModeFromId(selectedId) }
        : {})
    },
    bindings: []
  };
}

export function selectedItem(
  settings: CodexDialSettings,
  state: DialRuntimeState,
  view: DialRuntimeView
): DialSelectorItem | undefined {
  const items = selectorItems(settings, view);
  const reconciled = reconcileSelector(state, items);
  return items.find((item) => item.id === reconciled.selectedId);
}

export function deriveDialFeedback(
  settings: CodexDialSettings,
  state: DialRuntimeState,
  view: DialRuntimeView
): DialFeedback {
  const mode = resolveFeedbackMode(settings);
  const live = mode === "reasoning"
    ? reasoningFeedback(view)
    : mode === "agent"
      ? agentFeedback(settings, state, view)
      : mode === "action"
        ? actionFeedback(settings, state, view)
        : mode === "navigation"
          ? feedback("NAVIGATION", "BACK / FORWARD", "TURN LEFT / RIGHT", 50, DIAL_ACCENTS.blue)
          : mode === "usage"
            ? usageFeedback(state, view)
            : staticFeedback(settings);
  return view.health === "ready" ? live : healthFeedback(live.title, view.health);
}

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
          isDialBindingId(item, "selector"))
          .filter((item, index, items) => items.indexOf(item) === index)
          .slice(0, 30)
        : []
    };
  }
  return fallback;
}

function cleanActionLabel(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean || undefined;
}

export function dialBindingLabel(binding: DialBindingId): string {
  const fixed: Partial<Record<DialBindingId, string>> = {
    none: "None",
    "selector.activate": "Activate Selection",
    "reasoning.decrease": "Reasoning Decrease",
    "reasoning.increase": "Reasoning Increase",
    "new-task": "New Task",
    "host.toggle": "Toggle Host",
    "usage.refresh": "Refresh Usage",
    "usage.toggle-overview": "Toggle Usage Overview",
    "usage.rate-limit-reset": "Rate Limit Reset"
  };
  const known = fixed[binding];
  if (known) return known;
  if (binding.startsWith("micro.")) return binding.slice(6).replaceAll("_", " + ");
  if (binding.startsWith("joystick.")) return `Joystick ${titleCase(binding.slice(9))}`;
  if (binding.startsWith("keycap.")) return `Keycap ${binding.slice(7).replaceAll("_", " ")}`;
  return "Action";
}

function titleCase(value: string): string {
  return value.replace(/(^|[-_ ])([a-z])/g, (_match, separator: string, letter: string) =>
    `${separator === "-" || separator === "_" ? " " : separator}${letter.toUpperCase()}`);
}

function agentDisplayNumber(id: number): number {
  return Number.isSafeInteger(id) && id >= 0 ? id + 1 : 1;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function usageModeFromId(id: string): DialRuntimeState["usageMode"] {
  if (id === "five-hour") return "five-hour";
  if (id === "weekly") return "weekly";
  return "auto";
}

function resolveFeedbackMode(settings: CodexDialSettings): Exclude<DialFeedbackMode, "auto"> {
  if (settings.feedback !== "auto") return settings.feedback;
  if (settings.rotation.kind === "selector") {
    if (settings.rotation.source === "agents") return "agent";
    if (settings.rotation.source === "actions") return "action";
    return "usage";
  }
  if (settings.preset === "reasoning") return "reasoning";
  if (settings.preset === "agents") return "agent";
  if (settings.preset === "actions") return "action";
  if (settings.preset === "navigation") return "navigation";
  if (settings.preset === "usage") return "usage";
  if (settings.rotation.counterClockwise.startsWith("reasoning.") ||
      settings.rotation.clockwise.startsWith("reasoning.")) return "reasoning";
  if (settings.rotation.counterClockwise.startsWith("joystick.") ||
      settings.rotation.clockwise.startsWith("joystick.")) return "navigation";
  return "static";
}

function reasoningFeedback(view: DialRuntimeView): DialFeedback {
  const effort = cleanDisplaySource(view.reasoningEffort);
  if (!effort) {
    return feedback(
      "REASONING", "UNAVAILABLE", "LIVE VALUE NOT REPORTED", 0, DIAL_ACCENTS.muted
    );
  }
  const indicators: Record<string, number> = {
    minimal: 10,
    low: 25,
    medium: 50,
    high: 75,
    xhigh: 100
  };
  return feedback(
    "REASONING",
    effort,
    "TURN TO ADJUST",
    indicators[effort.toLowerCase()] ?? 50,
    DIAL_ACCENTS.blue
  );
}

function agentFeedback(
  settings: CodexDialSettings,
  state: DialRuntimeState,
  view: DialRuntimeView
): DialFeedback {
  const item = selectedItem(settings, state, view);
  if (!item) {
    return feedback("AGENT", "UNAVAILABLE", "NO ACTIVE AGENTS", 0, DIAL_ACCENTS.muted);
  }
  const agent = view.agents.find((candidate) => candidate.identity === item.id);
  if (!agent) {
    return feedback("AGENT", "UNAVAILABLE", "NO ACTIVE AGENTS", 0, DIAL_ACCENTS.muted);
  }
  const context = finitePercent(agent.contextUsedPercent);
  const status = item.detail ?? "unknown";
  const detail = context == null
    ? status
    : `${status} • ${Math.round(context)}% context`;
  return feedback(
    `AGENT ${agentDisplayNumber(agent.id)}`,
    item.label,
    detail,
    context ?? 0,
    agentAccent(status)
  );
}

function actionFeedback(
  settings: CodexDialSettings,
  state: DialRuntimeState,
  view: DialRuntimeView
): DialFeedback {
  const items = selectorItems(settings, view);
  const reconciled = reconcileSelector(state, items);
  const index = items.findIndex((item) => item.id === reconciled.selectedId);
  const item = index >= 0 ? items[index] : undefined;
  if (!item) {
    return feedback("ACTION", "UNAVAILABLE", "NO ACTIONS CONFIGURED", 0, DIAL_ACCENTS.muted);
  }
  return feedback(
    `ACTION ${index + 1}/${items.length}`,
    item.label,
    "PRESS TO RUN",
    ((index + 1) / items.length) * 100,
    DIAL_ACCENTS.teal
  );
}

function usageFeedback(state: DialRuntimeState, view: DialRuntimeView): DialFeedback {
  const usage = view.usage;
  if (state.usageOverview) {
    if (!usage) {
      return feedback(
        "USAGE OVERVIEW", "UNAVAILABLE", "LIVE VALUE NOT REPORTED", 0, DIAL_ACCENTS.muted
      );
    }
    const fiveHour = finitePercent(usage.fiveHourRemaining);
    const weekly = finitePercent(usage.weeklyRemaining);
    const value = `5H ${percentOrDash(fiveHour)} • WK ${percentOrDash(weekly)}`;
    const indicator = selectedUsageRemaining(state.usageMode, usage) ?? fiveHour ?? weekly ?? 0;
    return feedback(
      "USAGE OVERVIEW",
      value,
      "PRESS TO CLOSE",
      indicator,
      usageAccent(fiveHour ?? weekly)
    );
  }

  const effectiveMode = state.usageMode === "auto" ? usage?.mode ?? "auto" : state.usageMode;
  const title = `USAGE • ${usageModeLabel(effectiveMode)}`;
  const remaining = usage ? selectedUsageRemaining(state.usageMode, usage) : undefined;
  if (remaining == null) {
    return feedback(title, "UNAVAILABLE", "LIVE VALUE NOT REPORTED", 0, DIAL_ACCENTS.muted);
  }
  const resetMatchesSelection = usage != null &&
    (state.usageMode === "auto" || state.usageMode === usage.mode);
  const detail = resetMatchesSelection
    ? resetCountdown(usage.resetsAt, view.now)
    : "RESET UNAVAILABLE";
  return feedback(
    title,
    `${Math.round(remaining)}% LEFT`,
    detail,
    remaining,
    usageAccent(remaining)
  );
}

function staticFeedback(settings: CodexDialSettings): DialFeedback {
  return feedback(
    "CUSTOM",
    cleanDisplaySource(settings.staticLabel) ?? "CODEX DIAL",
    "READY",
    0,
    DIAL_ACCENTS.muted
  );
}

function healthFeedback(
  title: string,
  health: Exclude<DialRuntimeView["health"], "ready">
): DialFeedback {
  if (health === "offline") {
    return feedback(title, "OFFLINE", "LIVE DATA UNAVAILABLE", 0, DIAL_ACCENTS.red);
  }
  if (health === "connecting") {
    return feedback(title, "CONNECTING", "WAITING FOR LIVE DATA", 0, DIAL_ACCENTS.orange);
  }
  return feedback(title, "DEGRADED", "LIVE DATA MAY BE STALE", 0, DIAL_ACCENTS.orange);
}

function selectedUsageRemaining(
  mode: DialRuntimeState["usageMode"],
  usage: NonNullable<DialRuntimeView["usage"]>
): number | undefined {
  if (mode === "five-hour") return finitePercent(usage.fiveHourRemaining);
  if (mode === "weekly") return finitePercent(usage.weeklyRemaining);
  return finitePercent(usage.remainingPercent)
    ?? (usage.mode === "weekly"
      ? finitePercent(usage.weeklyRemaining)
      : finitePercent(usage.fiveHourRemaining))
    ?? finitePercent(usage.weeklyRemaining);
}

function usageModeLabel(mode: DialRuntimeState["usageMode"]): string {
  if (mode === "five-hour") return "5 HOURS";
  if (mode === "weekly") return "WEEKLY";
  return "AUTOMATIC";
}

function percentOrDash(value: number | undefined): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function resetCountdown(resetsAt: number | null | undefined, now: number): string {
  if (resetsAt == null || !Number.isFinite(resetsAt) || !Number.isFinite(now)) {
    return "RESET UNAVAILABLE";
  }
  const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `RESETS IN ${remainder}M`;
  if (remainder === 0) return `RESETS IN ${hours}H`;
  return `RESETS IN ${hours}H ${remainder}M`;
}

function usageAccent(remaining: number | undefined): string {
  if (remaining == null) return DIAL_ACCENTS.muted;
  return remaining <= 20 ? DIAL_ACCENTS.red : DIAL_ACCENTS.green;
}

function agentAccent(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "error") return DIAL_ACCENTS.red;
  if (normalized === "complete") return DIAL_ACCENTS.green;
  if (normalized === "input") return DIAL_ACCENTS.orange;
  if (normalized === "thinking" || normalized === "working") return DIAL_ACCENTS.blue;
  return DIAL_ACCENTS.muted;
}

function finitePercent(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function cleanDisplaySource(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean || undefined;
}

function feedback(
  title: string,
  value: string,
  detail: string,
  indicator: number,
  accent: string
): DialFeedback {
  return {
    title: displayText(title, 18),
    value: displayText(value, 24),
    detail: displayText(detail, 32),
    indicator: finitePercent(indicator) ?? 0,
    accent
  };
}

function displayText(value: string, maximum: number): string {
  const uppercase = value.replace(/\s+/g, " ").trim().toUpperCase();
  const codePoints = Array.from(uppercase);
  if (codePoints.length <= maximum) return uppercase;
  return `${codePoints.slice(0, maximum - 1).join("").trimEnd()}…`;
}
