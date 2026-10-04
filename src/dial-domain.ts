import { OFFICIAL_KEYCAP_IDS } from "./keycaps.js";
import { isSafeReasoningIdentifier } from "./types.js";
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
  type ExistingDialSettingsV2,
  type LegacyDialFeedbackMode,
  type LegacyDialPreset,
  type LegacyDialRotation,
  type ModelPresetEntry,
  type ModelPresetDirection,
  type ModelPresetResolution,
  type ModelPresetsDialSettings,
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
export const MAX_DIAL_TICKS_PER_EVENT = 64;
export const MAX_DIAL_QUEUE_PENDING = 128;

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
  private pending = 0;

  get pendingCount(): number {
    return this.pending;
  }

  canEnqueue(count = 1): boolean {
    return Number.isSafeInteger(count) && count >= 0 &&
      this.pending + count <= MAX_DIAL_QUEUE_PENDING;
  }

  enqueue(operation: () => Promise<void>): boolean {
    if (!this.canEnqueue()) return false;
    this.pending += 1;
    const run = async (): Promise<void> => {
      try { await operation(); }
      finally { this.pending -= 1; }
    };
    this.tail = this.tail.then(run, run).catch(() => undefined);
    return true;
  }

  enqueueCleanup(operation: () => Promise<void>): void {
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
  const stableIndex = items.findIndex((item) => item.id === state.selectedId);
  const priorIndex = Number.isSafeInteger(state.selectedIndex) && state.selectedIndex != null
    ? state.selectedIndex
    : 0;
  const selectedIndex = stableIndex >= 0
    ? stableIndex
    : Math.min(items.length - 1, Math.max(0, priorIndex));
  return { ...state, selectedId: items[selectedIndex]!.id, selectedIndex };
}

export function isDialTickCount(ticks: number): boolean {
  return Number.isSafeInteger(ticks) && Math.abs(ticks) <= MAX_DIAL_TICKS_PER_EVENT;
}

export function reduceDialRotation(
  settings: CodexDialSettings,
  state: DialRuntimeState,
  view: DialRuntimeView,
  ticks: number
): { state: DialRuntimeState; bindings: DialBindingId[] } {
  if (!isDialTickCount(ticks) || ticks === 0) {
    return { state, bindings: [] };
  }
  if (settings.rotation.kind === "model-presets") {
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
  const currentIndex = reconciled.selectedIndex ?? 0;
  const nextIndex = settings.rotation.wrap
    ? modulo(currentIndex + (ticks % items.length), items.length)
    : Math.min(items.length - 1, Math.max(0, currentIndex + ticks));
  const selectedId = items[nextIndex]!.id;
  return {
    state: {
      ...reconciled,
      selectedId,
      selectedIndex: nextIndex,
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

export function resolveModelPresetDirection(
  settings: CodexDialSettings,
  view: DialRuntimeView,
  direction: ModelPresetDirection
): ModelPresetResolution {
  if (settings.preset !== "model-presets") return { kind: "unavailable" };
  if (settings.modelPresets.length === 0) return { kind: "empty" };
  const entries = validModelPresetEntries(settings, view);
  if (entries == null) return { kind: "unavailable" };
  if (entries.length === 0) return { kind: "empty" };
  const activeIndex = entries.findIndex(({ entry }) =>
    entry.modelId === view.activeModelId && entry.reasoningEffort === view.reasoningEffort);
  const targetIndex = activeIndex < 0
    ? direction === "clockwise" ? 0 : entries.length - 1
    : modulo(activeIndex + (direction === "clockwise" ? 1 : -1), entries.length);
  return {
    kind: "target",
    entry: { ...entries[targetIndex]!.entry },
    index: targetIndex,
    count: entries.length
  };
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
            : mode === "model-presets"
              ? modelPresetsFeedback(settings, state, view)
            : staticFeedback(settings);
  const emptySelector = (mode === "agent" || mode === "action") &&
    selectorItems(settings, view).length === 0;
  if (mode === "agent" || emptySelector) return live;
  return view.health === "ready" ? live : healthFeedback(live.title, view.health);
}

export function expandDialPreset(preset: DialPreset): CodexDialSettings {
  if (preset === "model-presets") {
    return {
      version: 2,
      preset: "model-presets",
      customized: false,
      includeUltraReasoning: false,
      rotation: { kind: "model-presets" },
      press: "none",
      touchTap: "keycap.FAST",
      feedback: "model-presets",
      modelPresets: []
    };
  }
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
  const version = ownDataValue(input, "version");
  const preset = ownDataValue(input, "preset");
  if (version === 2 && isPreset(preset)) {
    const fallback = expandDialPreset(preset);
    try {
      return normalizeVersion2(input, preset) ?? fallback;
    } catch {
      return fallback;
    }
  }
  if (version !== 1 || !isLegacyPreset(preset)) {
    return expandDialPreset("reasoning");
  }

  if (!record(input)) return expandDialPreset("reasoning");
  const fallback = expandDialPreset(preset) as ExistingDialSettingsV2;
  const staticLabelValue = ownDataValue(input, "staticLabel");
  const staticLabel = typeof staticLabelValue === "string"
    ? staticLabelValue.trim().slice(0, 40)
    : undefined;
  const rotation = normalizeRotation(ownDataValue(input, "rotation"), fallback.rotation);
  const pressValue = ownDataValue(input, "press");
  const requestedPress = isDialBindingId(pressValue, "press")
    ? pressValue
    : fallback.press;
  const touchTapValue = ownDataValue(input, "touchTap");
  const feedbackValue = ownDataValue(input, "feedback");
  return {
    version: 2,
    preset,
    customized: ownDataValue(input, "customized") === true,
    includeUltraReasoning: ownDataValue(input, "includeUltraReasoning") === true,
    rotation,
    press: rotation.kind === "paired" && requestedPress === "selector.activate" ? "none" : requestedPress,
    touchTap: isDialBindingId(touchTapValue, "touch")
      ? touchTapValue
      : "none",
    feedback: isLegacyFeedback(feedbackValue)
      ? feedbackValue
      : fallback.feedback,
    ...(staticLabel ? { staticLabel } : {})
  };
}

function normalizeVersion2(input: unknown, preset: DialPreset): CodexDialSettings | undefined {
  const requiredKeys = [
    "version", "preset", "customized", "includeUltraReasoning", "rotation", "press",
    "touchTap", "feedback", ...(preset === "model-presets" ? ["modelPresets"] : [])
  ];
  if (!exactPlainDataRecord(input, requiredKeys, ["staticLabel"])) return undefined;
  if (ownDataValue(input, "version") !== 2 || ownDataValue(input, "preset") !== preset) {
    return undefined;
  }
  const customized = ownDataValue(input, "customized");
  const includeUltraReasoning = ownDataValue(input, "includeUltraReasoning");
  const press = ownDataValue(input, "press");
  const touchTap = ownDataValue(input, "touchTap");
  const staticLabel = ownDataValue(input, "staticLabel");
  if (typeof customized !== "boolean" || typeof includeUltraReasoning !== "boolean" ||
      !isDialBindingId(press, "press") || !isDialBindingId(touchTap, "touch") ||
      (Object.hasOwn(input, "staticLabel") &&
        (typeof staticLabel !== "string" || staticLabel.length === 0 ||
          staticLabel.length > 40 || staticLabel.trim() !== staticLabel))) {
    return undefined;
  }

  if (preset === "model-presets") {
    const rotation = ownDataValue(input, "rotation");
    const feedbackMode = ownDataValue(input, "feedback");
    const entries = normalizeModelPresetEntries(ownDataValue(input, "modelPresets"));
    if (!exactPlainDataRecord(rotation, ["kind"]) ||
        ownDataValue(rotation, "kind") !== "model-presets" ||
        feedbackMode !== "model-presets" || press === "selector.activate" || entries == null) {
      return undefined;
    }
    return {
      version: 2,
      preset,
      customized,
      includeUltraReasoning,
      rotation: { kind: "model-presets" },
      press,
      touchTap,
      feedback: "model-presets",
      modelPresets: entries,
      ...(typeof staticLabel === "string" ? { staticLabel } : {})
    };
  }

  const rotation = strictLegacyRotation(ownDataValue(input, "rotation"));
  const feedbackMode = ownDataValue(input, "feedback");
  if (rotation == null || !isLegacyFeedback(feedbackMode) ||
      (rotation.kind === "paired" && press === "selector.activate")) return undefined;
  return {
    version: 2,
    preset,
    customized,
    includeUltraReasoning,
    rotation,
    press,
    touchTap,
    feedback: feedbackMode,
    ...(typeof staticLabel === "string" ? { staticLabel } : {})
  };
}

function strictLegacyRotation(value: unknown): LegacyDialRotation | undefined {
  const kind = ownDataValue(value, "kind");
  if (kind === "paired") {
    if (!exactPlainDataRecord(value, ["kind", "counterClockwise", "clockwise"])) return undefined;
    const counterClockwise = ownDataValue(value, "counterClockwise");
    const clockwise = ownDataValue(value, "clockwise");
    if (!isDialBindingId(counterClockwise, "rotation") ||
        !isDialBindingId(clockwise, "rotation")) return undefined;
    return { kind, counterClockwise, clockwise };
  }
  if (kind !== "selector" ||
      !exactPlainDataRecord(value, ["kind", "source", "wrap", "items"])) return undefined;
  const source = ownDataValue(value, "source");
  const wrap = ownDataValue(value, "wrap");
  const items = ownDataValue(value, "items");
  const itemValues = ownDataArrayValues(items, 30);
  if (!isSelectorSource(source) || typeof wrap !== "boolean" || itemValues == null) {
    return undefined;
  }
  const bindings: DialBindingId[] = [];
  for (const item of itemValues) {
    if (!isDialBindingId(item, "selector") || bindings.includes(item)) return undefined;
    bindings.push(item);
  }
  if (source !== "actions" && bindings.length !== 0) return undefined;
  return { kind, source, wrap, items: bindings };
}

function normalizeModelPresetEntries(value: unknown): ModelPresetEntry[] | undefined {
  const values = ownDataArrayValues(value, 12);
  if (values == null) return undefined;
  const entries: ModelPresetEntry[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (!exactPlainDataRecord(item, ["modelId", "reasoningEffort"])) return undefined;
    const modelId = ownDataValue(item, "modelId");
    const reasoningEffort = ownDataValue(item, "reasoningEffort");
    if (!isSafeReasoningIdentifier(modelId, 128) ||
        !isSafeReasoningIdentifier(reasoningEffort)) return undefined;
    const identity = `${modelId}\u0000${reasoningEffort}`;
    if (seen.has(identity)) return undefined;
    seen.add(identity);
    entries.push({ modelId, reasoningEffort });
  }
  return entries;
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function ownDataValue(value: unknown, key: string): unknown {
  try {
    if (!record(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor != null && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function exactPlainDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): value is Record<string, unknown> {
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.keys(descriptors);
  if (keys.length < requiredKeys.length ||
      keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key)) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) return false;
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor != null && "value" in descriptor && descriptor.enumerable === true;
  });
}

function ownDataArrayValues(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors["length"];
    const length = lengthDescriptor?.value;
    if (lengthDescriptor == null || !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(length) || typeof length !== "number" || length < 0 ||
        length > maximum) return undefined;
    const expectedKeys = Array.from(
      { length }, (_, index) => String(index)
    );
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (keys.length !== expectedKeys.length ||
        keys.some((key, index) => key !== expectedKeys[index])) return undefined;
    const values: unknown[] = [];
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor == null || !("value" in descriptor) || descriptor.enumerable !== true) {
        return undefined;
      }
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return undefined;
  }
}

function isPreset(value: unknown): value is DialPreset {
  return typeof value === "string" && PRESET_IDS.has(value);
}

function isLegacyPreset(value: unknown): value is LegacyDialPreset {
  return isPreset(value) && value !== "model-presets";
}

function isFeedback(value: unknown): value is DialFeedbackMode {
  return typeof value === "string" && FEEDBACK_MODE_IDS.has(value);
}

function isLegacyFeedback(value: unknown): value is LegacyDialFeedbackMode {
  return isFeedback(value) && value !== "model-presets";
}

function isSelectorSource(value: unknown): value is DialSelectorSource {
  return typeof value === "string" && SELECTOR_SOURCE_IDS.has(value);
}

function pairedPreset(
  preset: LegacyDialPreset,
  counterClockwise: DialBindingId,
  clockwise: DialBindingId,
  press: DialBindingId,
  touchTap: DialBindingId,
  feedback: LegacyDialFeedbackMode
): ExistingDialSettingsV2 {
  return {
    version: 2,
    preset,
    customized: false,
    includeUltraReasoning: false,
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
  feedback: LegacyDialFeedbackMode,
  items: DialBindingId[] = []
): ExistingDialSettingsV2 {
  return {
    version: 2,
    preset,
    customized: false,
    includeUltraReasoning: false,
    rotation: { kind: "selector", source: preset, wrap: true, items },
    press,
    touchTap,
    feedback
  };
}

function normalizeRotation(value: unknown, fallback: LegacyDialRotation): LegacyDialRotation {
  try {
    const kind = ownDataValue(value, "kind");
    if (kind === "paired") {
      const counterClockwise = ownDataValue(value, "counterClockwise");
      const clockwise = ownDataValue(value, "clockwise");
      return {
        kind,
        counterClockwise: isDialBindingId(counterClockwise, "rotation")
          ? counterClockwise
          : "none",
        clockwise: isDialBindingId(clockwise, "rotation") ? clockwise : "none"
      };
    }
    if (kind !== "selector") return fallback;
    const source = ownDataValue(value, "source");
    const wrap = ownDataValue(value, "wrap");
    const items = ownDataValue(value, "items");
    const itemValues = ownDataArrayValues(items, 10_000);
    if (!isSelectorSource(source) || typeof wrap !== "boolean" || itemValues == null) {
      return fallback;
    }
    return {
      kind,
      source,
      wrap,
      items: source === "actions"
        ? itemValues.filter((item): item is DialBindingId =>
          isDialBindingId(item, "selector"))
          .filter((item, index, candidates) => candidates.indexOf(item) === index)
          .slice(0, 30)
        : []
    };
  } catch {
    return fallback;
  }
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

function validModelPresetEntries(
  settings: ModelPresetsDialSettings,
  view: DialRuntimeView
): Array<{ entry: ModelPresetEntry; displayName: string }> | undefined {
  if (view.modelCatalog == null) return undefined;
  const valid: Array<{ entry: ModelPresetEntry; displayName: string }> = [];
  for (const entry of settings.modelPresets) {
    if (!settings.includeUltraReasoning && entry.reasoningEffort.toLowerCase() === "ultra") continue;
    const model = view.modelCatalog.find((candidate) => candidate.modelId === entry.modelId);
    if (model == null || !model.supportedReasoningEfforts.includes(entry.reasoningEffort)) continue;
    valid.push({ entry, displayName: model.displayName });
  }
  return valid;
}

function modelPresetsFeedback(
  settings: CodexDialSettings,
  state: DialRuntimeState,
  view: DialRuntimeView
): DialFeedback {
  if (settings.preset !== "model-presets") {
    return feedback("MODEL PRESET", "UNAVAILABLE", "LIVE VALUE NOT REPORTED", 0, DIAL_ACCENTS.muted);
  }
  if (state.modelPresetSwitching === true) {
    return feedback("MODEL PRESET", "SWITCHING…", "WAIT", 0, DIAL_ACCENTS.blue);
  }
  if (settings.modelPresets.length === 0) {
    return feedback("MODEL PRESET", "NO PRESETS", "ADD IN SETTINGS", 0, DIAL_ACCENTS.muted);
  }
  const entries = validModelPresetEntries(settings, view);
  if (entries == null || view.activeModelId == null || view.reasoningEffort == null) {
    return feedback("MODEL PRESET", "UNAVAILABLE", "LIVE VALUE NOT REPORTED", 0, DIAL_ACCENTS.muted);
  }
  if (entries.length === 0) {
    return feedback("MODEL PRESET", "NO PRESETS", "ADD IN SETTINGS", 0, DIAL_ACCENTS.muted);
  }
  const index = entries.findIndex(({ entry }) =>
    entry.modelId === view.activeModelId && entry.reasoningEffort === view.reasoningEffort);
  if (index >= 0) {
    return feedback(
      `MODEL PRESET ${index + 1}/${entries.length}`,
      entries[index]!.displayName,
      titleCase(view.reasoningEffort),
      ((index + 1) / entries.length) * 100,
      DIAL_ACCENTS.teal
    );
  }
  const activeCatalogEntry = view.modelCatalog?.find((entry) => entry.modelId === view.activeModelId);
  return feedback(
    "MODEL PRESET",
    cleanDisplaySource(view.activeModelDisplayName) ?? activeCatalogEntry?.displayName ?? view.activeModelId,
    `${titleCase(view.reasoningEffort)} · UNLISTED`,
    0,
    DIAL_ACCENTS.muted
  );
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
  const items = selectorItems(settings, view);
  if (items.length === 0) {
    return feedback("AGENT", "NO ITEMS", "NO ACTIVE AGENTS", 0, DIAL_ACCENTS.muted);
  }
  const reconciled = reconcileSelector(state, items);
  const item = items.find((candidate) => candidate.id === reconciled.selectedId);
  if (!item) {
    return feedback("AGENT", "UNAVAILABLE", "SELECTION UNAVAILABLE", 0, DIAL_ACCENTS.muted);
  }
  const agent = view.agents.find((candidate) => candidate.identity === item.id);
  if (!agent) {
    return feedback("AGENT", "UNAVAILABLE", "SELECTION UNAVAILABLE", 0, DIAL_ACCENTS.muted);
  }
  const context = finitePercent(agent.contextUsedPercent);
  const status = item.detail ?? "unknown";
  const detail = context == null
    ? status
    : `${status} • ${Math.round(context)}% context`;
  const live = feedback(
    `AGENT ${agentDisplayNumber(agent.id)}${agent.hostBadge ? ` • ${agent.hostBadge}` : ""}`,
    item.label,
    detail,
    context ?? 0,
    agentAccent(status)
  );
  return agent.health === "ready" ? live : healthFeedback(live.title, agent.health);
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
  if (items.length === 0) {
    return feedback("ACTION", "NO ITEMS", "NO ACTIONS CONFIGURED", 0, DIAL_ACCENTS.muted);
  }
  if (!item) {
    return feedback("ACTION", "UNAVAILABLE", "SELECTION UNAVAILABLE", 0, DIAL_ACCENTS.muted);
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
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainder = minutes % 60;
  const units = [
    ...(days > 0 ? [`${days}D`] : []),
    ...(hours > 0 ? [`${hours}H`] : []),
    ...(remainder > 0 || (days === 0 && hours === 0) ? [`${remainder}M`] : [])
  ];
  return `RESETS IN ${units.join(" ")}`;
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
