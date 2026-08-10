import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { codexDeckStateRoot } from "./codex-deck-paths.js";
import { OFFICIAL_KEYCAP_IDS, type OfficialKeycapId } from "./keycaps.js";
import { CodexSessionOwnershipIndex } from "./session-ownership.js";
import type {
  MicroActionSlot, MicroDirection, MicroSnapshot, ReasoningAdjustment, ReasoningAdjustmentPolicy,
  ReasoningAdjustmentResult, UsageSnapshot, UsageWindow
} from "./types.js";

type DebugTarget = {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export function selectCodexMainTarget(targets: DebugTarget[]): DebugTarget | undefined {
  const candidates = targets.filter((target) =>
    target.type === "page" && target.webSocketDebuggerUrl && target.url.startsWith("app://")
  );
  const isIndexDocument = (target: DebugTarget): boolean => {
    try { return new URL(target.url).pathname === "/index.html"; }
    catch { return false; }
  };
  const isAuxiliarySurface = (target: DebugTarget): boolean =>
    /avatar-overlay|composition-surface/i.test(target.url);

  return candidates.find((target) => isIndexDocument(target) && !new URL(target.url).search)
    ?? candidates.find(isIndexDocument)
    ?? candidates.find((target) => !isAuxiliarySurface(target) && !target.url.includes("initialRoute="))
    ?? candidates.find((target) => !isAuxiliarySurface(target));
}

type CdpResponse = {
  id?: number;
  result?: { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  error?: { message?: string };
};

export type AgentDispatchPlan =
  | { kind: "native"; slot: number; threadKey: string }
  | { kind: "direct"; threadKey: string };

export function resolveAgentDispatch(
  snapshot: MicroSnapshot,
  requestedSlot: number,
  expectedThreadKey?: string
): AgentDispatchPlan {
  const requested = snapshot.slots.find((item) => item.id === requestedSlot);
  const threadKey = expectedThreadKey ?? requested?.threadKey ?? null;
  if (!threadKey) throw new Error("The selected Codex task has no stable thread identity.");
  const current = snapshot.slots.find((item) => item.threadKey === threadKey);
  return current
    ? { kind: "native", slot: current.id, threadKey }
    : { kind: "direct", threadKey };
}

type CommandRunner = (command: string, source: string) => unknown;
type ReasoningCommand = "composer.increaseReasoningEffort" | "composer.decreaseReasoningEffort";

const REASONING_COMMANDS = Object.freeze([
  "composer.increaseReasoningEffort",
  "composer.decreaseReasoningEffort"
] as const);

export async function resolveCommandRunner(
  bridgeSource: string,
  bridgeUrl: string,
  importModule: (url: string) => Promise<Record<string, unknown>>
): Promise<CommandRunner | null> {
  const guardedCall = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*,\s*(?:"codex_micro_hid"|'codex_micro_hid'|`codex_micro_hid`)\s*\)/g;
  const runnerLocals = new Set<string>();
  let callMatch: RegExpExecArray | null;
  while ((callMatch = guardedCall.exec(bridgeSource))) runnerLocals.add(callMatch[1]!);
  if (runnerLocals.size === 0) return null;

  const importPattern = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(bridgeSource))) {
    for (const specifier of importMatch[1]!.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const exportName = parts[0];
      const runnerLocal = parts[1] ?? exportName;
      if (!exportName || !runnerLocal || parts.length > 2 ||
          !/^[A-Za-z_$][\w$]*$/.test(exportName) || !/^[A-Za-z_$][\w$]*$/.test(runnerLocal) ||
          !runnerLocals.has(runnerLocal)) continue;
      try {
        const namespace = await importModule(new URL(importMatch[2]!, bridgeUrl).href);
        const candidate = namespace[exportName];
        if (typeof candidate === "function") return candidate as CommandRunner;
      } catch {}
    }
  }
  return null;
}

const execFileAsync = promisify(execFile);
const PORT_FILE = join(codexDeckStateRoot(), "codex-micro-bridge.json");
const DEVICE_STATE = {
  type: "codex-micro-device-state-changed",
  state: { status: "connected", error: null, battery: { percentage: 100, isCharging: true } }
};

type RendererUsageQuery = {
  state?: { data?: unknown; dataUpdatedAt?: number };
  fetch?: () => unknown;
};

export async function readUsageQueryData(
  query: RendererUsageQuery | undefined,
  forceUsageRefresh: boolean,
  now = Date.now(),
  refreshState = globalThis as unknown as Record<symbol, unknown>
): Promise<unknown> {
  if (!query) return undefined;
  if (forceUsageRefresh) {
    if (typeof query.fetch !== "function") throw new Error("Codex usage query cannot be refreshed.");
    await Promise.resolve(query.fetch());
  } else {
    const refreshKey = Symbol.for('codex-deck-rate-limit-refresh-at');
    const dataUpdatedAt = Number(query.state?.dataUpdatedAt) || 0;
    const lastRefreshAttempt = Number(refreshState[refreshKey]) || 0;
    if (typeof query.fetch === "function" && now - dataUpdatedAt >= 15000 && now - lastRefreshAttempt >= 15000) {
      refreshState[refreshKey] = now;
      try { Promise.resolve(query.fetch()).catch(() => {}); } catch {}
    }
  }
  return query.state?.data;
}

export function normalizeRendererUsage(
  data: unknown,
  dataUpdatedAt?: number,
  now = Date.now()
): UsageSnapshot | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const rateLimit = record.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object" || Array.isArray(rateLimit)) return undefined;
  const rateLimitRecord = rateLimit as Record<string, unknown>;
  const toEpoch = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value < 100000000000 ? value * 1000 : value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const normalizeWindow = (value: unknown, role: string): UsageWindow | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const window = value as Record<string, unknown>;
    const used = window.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
    const hasSeconds = Object.prototype.hasOwnProperty.call(window, "limit_window_seconds");
    const seconds = window.limit_window_seconds;
    if (hasSeconds && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)) return null;
    const minutes = typeof seconds === "number" ? seconds / 60 : null;
    const resetValue = window.reset_at;
    const resetsAt = resetValue == null ? null : toEpoch(resetValue);
    if (resetValue != null && resetsAt == null) return null;
    const kind: UsageWindow["kind"] = minutes != null && Math.abs(minutes - 300) <= 1 ? "five-hour"
      : minutes != null && Math.abs(minutes - 10080) <= 1 ? "weekly"
        : "other";
    return {
      id: kind === "other" ? `${role}-${String(minutes ?? "unknown")}` : kind,
      kind,
      usedPercent: used,
      remainingPercent: 100 - used,
      windowDurationMins: minutes,
      resetsAt: resetsAt ?? null
    };
  };
  const windows = [
    normalizeWindow(rateLimitRecord.primary_window, "primary"),
    normalizeWindow(rateLimitRecord.secondary_window, "secondary")
  ].filter((window): window is NonNullable<typeof window> => window != null);
  if (windows.length === 0) return undefined;
  const credits = record.rate_limit_reset_credits;
  const creditRecord = credits && typeof credits === "object" && !Array.isArray(credits)
    ? credits as Record<string, unknown>
    : {};
  const normalizeCredit = (key: string): { valid: boolean; value: number | null } => {
    if (!Object.prototype.hasOwnProperty.call(creditRecord, key)) return { valid: true, value: null };
    const value = creditRecord[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? { valid: true, value }
      : { valid: false, value: null };
  };
  const available = normalizeCredit("available_count");
  const applicable = normalizeCredit("applicable_available_count");
  if (!available.valid || !applicable.valid) return undefined;
  return {
    windows,
    observedAt: typeof dataUpdatedAt === "number" && Number.isFinite(dataUpdatedAt) && dataUpdatedAt > 0
      ? dataUpdatedAt
      : now,
    resetCreditsAvailable: available.value,
    resetCreditsApplicable: applicable.value
  };
}

function hasValidNormalizedUsage(usage: UsageSnapshot | undefined): usage is UsageSnapshot {
  if (!usage || !Array.isArray(usage.windows) || usage.windows.length === 0 || usage.windows.length > 8) return false;
  if (!Number.isFinite(usage.observedAt) || usage.observedAt <= 0) return false;
  const validCredit = (value: number | null): boolean => value == null || (Number.isSafeInteger(value) && value >= 0);
  if (!validCredit(usage.resetCreditsAvailable) || !validCredit(usage.resetCreditsApplicable)) return false;
  return usage.windows.every((window) =>
    typeof window.id === "string" && window.id.length > 0 && window.id.length <= 64 &&
    ["five-hour", "weekly", "other"].includes(window.kind) &&
    Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 &&
    Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100 &&
    (window.windowDurationMins == null || (Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0)) &&
    (window.resetsAt == null || (Number.isFinite(window.resetsAt) && window.resetsAt > 0))
  );
}

type ReasoningTriggerElement = {
  isConnected?: boolean;
  getClientRects?: () => { length: number };
  getAttribute: (name: string) => string | null;
  querySelector?: (selectors: string) => unknown;
};

export function isVisibleReasoningTrigger(element: ReasoningTriggerElement): boolean {
  if (element.isConnected === false || (element.getClientRects?.().length ?? 0) === 0) return false;
  const style = getComputedStyle(element as unknown as Element);
  return style.display !== "none" && style.visibility !== "hidden";
}

export function readActiveReasoningEffort(
  elements: Iterable<ReasoningTriggerElement>,
  isVisible = isVisibleReasoningTrigger
): string | undefined {
  const candidates = new Set<string>();
  for (const element of elements) {
    if (!isVisible(element)) continue;
    if (element.getAttribute("data-composer-navigation-target") !== "reasoning") continue;
    const value = element.getAttribute("data-selected-reasoning-effort")?.trim();
    if (value && value.length <= 64) candidates.add(value);
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

export function isSafeReasoningIdentifier(value: unknown, maxLength = 64): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function readOwnDataProperty(
  object: unknown,
  key: string
): { exists: boolean; value?: unknown } | undefined {
  if (!object || (typeof object !== "object" && typeof object !== "function")) return { exists: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return { exists: false };
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
    return { exists: true, value: descriptor.value };
  } catch { return undefined; }
}

export function normalizeReasoningEffortOrder(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  const efforts: string[] = [];
  const seen = new Set<string>();
  let ultraCount = 0;
  for (const item of value) {
    let effort: unknown;
    if (typeof item === "string") effort = item;
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const property = readOwnDataProperty(item, "reasoningEffort");
      if (!property?.exists) return undefined;
      effort = property.value;
    }
    if (!isSafeReasoningIdentifier(effort) || seen.has(effort)) return undefined;
    if (effort === "ultra" && ++ultraCount > 1) return undefined;
    seen.add(effort);
    efforts.push(effort);
  }
  return efforts;
}

export function readSelectedReasoningModelId(element: ReasoningTriggerElement): string | undefined {
  const pending: Array<{ value: unknown; selectedValue: boolean; propsObject: boolean; depth: number }> = [];
  try {
    for (const key of Object.getOwnPropertyNames(element)) {
      if (key.startsWith("__reactProps$")) {
        const property = readOwnDataProperty(element, key);
        if (!property?.exists) return undefined;
        pending.push({
          value: property.value,
          selectedValue: false,
          propsObject: false,
          depth: 0
        });
      }
    }
  } catch { return undefined; }
  const seenOutside = new Set<object>();
  const seenSelected = new Set<object>();
  const modelIds = new Set<string>();
  let malformed = false;
  let visited = 0;
  while (pending.length && visited < 3000) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (current.depth > 32) {
      malformed = true;
      continue;
    }
    const object = current.value as Record<string, unknown>;
    const seen = current.selectedValue ? seenSelected : seenOutside;
    if (seen.has(object)) continue;
    seen.add(object);
    visited++;
    let props: Record<string, unknown> | undefined;
    let hidden = false;
    const propsProperty = readOwnDataProperty(object, "props");
    if (!propsProperty) {
      malformed = true;
      continue;
    }
    const rawProps = propsProperty.exists ? propsProperty.value : undefined;
    props = rawProps && typeof rawProps === "object" && !Array.isArray(rawProps)
      ? rawProps as Record<string, unknown>
      : undefined;
    let hiddenInspectionFailed = false;
    for (const value of [object, props].filter((item): item is Record<string, unknown> => item != null)) {
      const styleProperty = readOwnDataProperty(value, "style");
      const classNameProperty = readOwnDataProperty(value, "className");
      const hiddenProperty = readOwnDataProperty(value, "hidden");
      const ariaHiddenProperty = readOwnDataProperty(value, "aria-hidden");
      if (!styleProperty || !classNameProperty || !hiddenProperty || !ariaHiddenProperty) {
        hiddenInspectionFailed = true;
        break;
      }
      const rawStyle = styleProperty.exists ? styleProperty.value : undefined;
      const style = rawStyle && typeof rawStyle === "object" && !Array.isArray(rawStyle)
        ? rawStyle as Record<string, unknown>
        : undefined;
      const displayProperty = style ? readOwnDataProperty(style, "display") : { exists: false };
      const visibilityProperty = style ? readOwnDataProperty(style, "visibility") : { exists: false };
      if (!displayProperty || !visibilityProperty) {
        hiddenInspectionFailed = true;
        break;
      }
      const classNameValue = classNameProperty.exists ? classNameProperty.value : undefined;
      const className = typeof classNameValue === "string" ? classNameValue : "";
      const hiddenValue = hiddenProperty.exists ? hiddenProperty.value : undefined;
      const ariaHiddenValue = ariaHiddenProperty.exists ? ariaHiddenProperty.value : undefined;
      hidden ||= hiddenValue === true || ariaHiddenValue === true || ariaHiddenValue === "true" ||
        displayProperty.value === "none" || visibilityProperty.value === "hidden" ||
        /(^|[\s_-])measurement([\s_-]|$)/i.test(className);
    }
    if (hiddenInspectionFailed) {
      malformed = true;
      continue;
    }
    if (hidden) continue;
    const modelProperty = readOwnDataProperty(object, "model");
    if (!modelProperty) {
      malformed = true;
      continue;
    }
    if (current.selectedValue && current.propsObject && modelProperty.exists) {
      const rawModel = modelProperty.value;
      const model = typeof rawModel === "string" ? rawModel.trim() : "";
      if (!model || model.length > 128 || model !== rawModel || /[\s\u0000-\u001f\u007f]/.test(model)) malformed = true;
      else modelIds.add(model);
    }
    try {
      for (const key of Object.keys(object)) {
        if (key === "model" && current.selectedValue && current.propsObject) continue;
        const property = readOwnDataProperty(object, key);
        if (!property?.exists) {
          malformed = true;
          continue;
        }
        pending.push({
          value: property.value,
          selectedValue: current.selectedValue || key === "selectedValue",
          propsObject: key === "props",
          depth: current.depth + 1
        });
      }
    } catch { malformed = true; }
  }
  if (pending.length > 0) malformed = true;
  return !malformed && modelIds.size === 1 ? modelIds.values().next().value : undefined;
}

export function findRendererQueryClients(rootFiber: unknown): unknown[] {
  const queue = [rootFiber];
  const seen = new Set<object>();
  const seenContexts = new Set<object>();
  const queryClients = new Set<object>();
  let contextTraversalTruncated = false;
  while (queue.length && seen.size < 30000) {
    const value = queue.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const fiber = value as Record<string, any>;
    const contextValues: unknown[] = [fiber.memoizedProps?.value];
    let dependency = fiber.dependencies?.firstContext;
    while (dependency && typeof dependency === "object" && seenContexts.size < 30000 && !seenContexts.has(dependency)) {
      seenContexts.add(dependency);
      contextValues.push(dependency.memoizedValue);
      dependency = dependency.next;
    }
    if (dependency && typeof dependency === "object" && !seenContexts.has(dependency)) {
      contextTraversalTruncated = true;
    }
    for (const contextValue of contextValues) {
      if (contextValue && typeof contextValue === "object" &&
          typeof (contextValue as Record<string, unknown>).getQueryCache === "function" &&
          typeof (contextValue as Record<string, unknown>).getQueryData === "function") {
        queryClients.add(contextValue);
      }
    }
    queue.push(fiber.child, fiber.sibling);
  }
  const fiberTraversalTruncated = queue.some((value) =>
    value && typeof value === "object" && !seen.has(value)
  );
  if (contextTraversalTruncated || fiberTraversalTruncated) return [];
  return [...queryClients];
}

export function readReasoningModelEfforts(queryClients: Iterable<unknown>, modelId: string): string[] | undefined {
  if (!modelId || modelId.length > 128 || /[\s\u0000-\u001f\u007f]/.test(modelId)) return undefined;
  const candidates: string[][] = [];
  let visitedQueries = 0;
  try {
    for (const candidate of queryClients) {
      if (!candidate || typeof candidate !== "object") return undefined;
      const client = candidate as Record<string, any>;
      const queries = client.getQueryCache().getAll();
      if (!Array.isArray(queries)) return undefined;
      for (const query of queries) {
        if (++visitedQueries > 30000) return undefined;
        if (!query || typeof query !== "object") return undefined;
        const queryKeyProperty = readOwnDataProperty(query, "queryKey");
        if (!queryKeyProperty) return undefined;
        const queryKey = queryKeyProperty.value;
        if (!Array.isArray(queryKey) || queryKey[0] !== "models" || queryKey[1] !== "list") continue;
        const stateProperty = readOwnDataProperty(query, "state");
        if (!stateProperty) return undefined;
        if (!stateProperty.exists || !stateProperty.value || typeof stateProperty.value !== "object") continue;
        const dataProperty = readOwnDataProperty(stateProperty.value, "data");
        if (!dataProperty) return undefined;
        if (!dataProperty.exists || dataProperty.value === undefined) continue;
        if (!dataProperty.value || typeof dataProperty.value !== "object") return undefined;
        const recordsProperty = readOwnDataProperty(dataProperty.value, "data");
        if (!recordsProperty?.exists) return undefined;
        const records = recordsProperty.value;
        if (!Array.isArray(records) || records.length === 0 || records.length > 1000) return undefined;
        const matches: unknown[] = [];
        for (const record of records) {
          if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
          const modelProperty = readOwnDataProperty(record, "model");
          if (!modelProperty?.exists || !isSafeReasoningIdentifier(modelProperty.value, 128)) return undefined;
          if (modelProperty.value === modelId) matches.push(record);
        }
        if (matches.length === 0) continue;
        if (matches.length !== 1) return undefined;
        const effortsProperty = readOwnDataProperty(matches[0], "supportedReasoningEfforts");
        if (!effortsProperty?.exists) return undefined;
        const effortRecords = effortsProperty.value;
        if (!Array.isArray(effortRecords)) return undefined;
        const liveEfforts: unknown[] = [];
        for (const effortRecord of effortRecords) {
          if (!effortRecord || typeof effortRecord !== "object" || Array.isArray(effortRecord)) return undefined;
          const effortProperty = readOwnDataProperty(effortRecord, "reasoningEffort");
          if (!effortProperty?.exists) return undefined;
          liveEfforts.push(effortProperty.value);
        }
        const efforts = normalizeReasoningEffortOrder(liveEfforts);
        if (!efforts) return undefined;
        candidates.push(efforts);
      }
    }
  } catch { return undefined; }
  if (candidates.length === 0) return undefined;
  const expected = candidates[0]!;
  return candidates.every((efforts) => efforts.length === expected.length &&
    efforts.every((effort, index) => effort === expected[index])) ? expected : undefined;
}

export function readActiveReasoningMetadata(
  elements: Iterable<ReasoningTriggerElement>,
  reactRootFiber: unknown,
  isVisible = isVisibleReasoningTrigger
): { currentEffort: string; modelId: string; supportedEfforts: string[] } | undefined {
  const visibleTriggers: ReasoningTriggerElement[] = [];
  for (const element of elements) {
    if (element.getAttribute("data-codex-intelligence-trigger") !== "true" ||
        element.getAttribute("data-composer-navigation-target") !== "reasoning" || !isVisible(element)) continue;
    visibleTriggers.push(element);
  }
  if (visibleTriggers.length !== 1) return undefined;
  const trigger = visibleTriggers[0]!;
  const currentEffort = trigger.getAttribute("data-selected-reasoning-effort")?.trim();
  if (!isSafeReasoningIdentifier(currentEffort)) return undefined;
  const modelId = readSelectedReasoningModelId(trigger);
  if (!modelId) return undefined;
  const supportedEfforts = readReasoningModelEfforts(findRendererQueryClients(reactRootFiber), modelId);
  return supportedEfforts ? { currentEffort, modelId, supportedEfforts } : undefined;
}

export function decideReasoningAdjustment(
  direction: ReasoningAdjustment,
  policy: ReasoningAdjustmentPolicy,
  currentEffort?: string,
  supportedEfforts?: unknown
): ReasoningAdjustmentResult | "unavailable" {
  if (direction === "decrease" || policy.includeUltra) return "applied";
  if (!isSafeReasoningIdentifier(currentEffort)) return "unavailable";
  const effortOrder = normalizeReasoningEffortOrder(supportedEfforts);
  if (!effortOrder) return "unavailable";
  const currentIndex = effortOrder.indexOf(currentEffort);
  if (currentIndex < 0) return "unavailable";
  return effortOrder[currentIndex + 1] === "ultra" ? "blocked-ultra" : "applied";
}

export function hasFastModeIndicator(element: ReasoningTriggerElement): boolean {
  return Boolean(element.querySelector?.('svg[class*="ModelPickerTriggerInlineFastIcon"]'));
}

export function readActiveFastMode(
  elements: Iterable<ReasoningTriggerElement>,
  isVisible = isVisibleReasoningTrigger,
  hasFastIndicator = hasFastModeIndicator
): boolean | undefined {
  const candidates = new Set<boolean>();
  for (const element of elements) {
    if (!isVisible(element)) continue;
    if (element.getAttribute("data-composer-navigation-target") !== "reasoning") continue;
    candidates.add(hasFastIndicator(element));
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

export function hasApplicableResetCredit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const SNAPSHOT_EXPRESSION = (forceUsageRefresh: boolean): string => `(async () => {
  const forceUsageRefresh = ${forceUsageRefresh};
  const readUsageQueryData = (${readUsageQueryData.toString()});
  const normalizeRendererUsage = (${normalizeRendererUsage.toString()});
  const isVisibleReasoningTrigger = (${isVisibleReasoningTrigger.toString()});
  const readActiveReasoningEffort = (${readActiveReasoningEffort.toString()});
  const hasFastModeIndicator = (${hasFastModeIndicator.toString()});
  const readActiveFastMode = (${readActiveFastMode.toString()});
  const urls = [...new Set([
    ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
    ...performance.getEntriesByType('resource').map((entry) => entry.name)
  ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
  const slotSignalsUrl = urls.find((url) => url.includes('/assets/codex-micro-slot-signals-'));
  if (!slotSignalsUrl) throw new Error('Codex Micro slot signals are not loaded.');

  const namespaces = [];
  for (const url of urls) {
    try { namespaces.push(await import(url)); } catch {}
  }
  const exportedValues = namespaces.flatMap((namespace) => Object.values(namespace));
  const definitions = exportedValues.find((candidate) =>
    candidate && typeof candidate === 'object' &&
    candidate.layout?.key === 'codex-micro-layout' &&
    candidate.agentSource?.key === 'codex-micro-agent-source'
  );
  if (!definitions) throw new Error('Codex Micro settings definitions were not found.');

  const bus = exportedValues.find((candidate) => candidate && typeof candidate === 'object' && candidate.handlers instanceof Map && (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
  if (!bus) throw new Error('Codex VS Code event bus was not found.');
  const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
  if ((bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0) {
    dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
  }
  const root = document.getElementById('root');
  const reactKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactContainer$'));
  if (!root || !reactKey) throw new Error('Codex React root was not found.');

  const slotSignals = await import(slotSignalsUrl);
  const resolvers = Object.values(slotSignals).filter((candidate) =>
    candidate && typeof candidate === 'object' &&
    typeof candidate.resolve === 'function' &&
    typeof candidate.createSubscriberAtom === 'function'
  );
  if (resolvers.length === 0) throw new Error('Codex Micro slot resolver was not found.');

  let queue = [root[reactKey]];
  const seen = new Set();
  const queryClients = new Set();
  let found = null;
  while (queue.length && seen.size < 30000 && !found) {
    const fiber = queue.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const maps = [];
    const contextValues = [fiber.memoizedProps?.value];
    let dependency = fiber.dependencies?.firstContext;
    while (dependency) {
      contextValues.push(dependency.memoizedValue);
      dependency = dependency.next;
    }
    for (const value of contextValues) {
      if (value instanceof Map) maps.push(value);
      if (value && typeof value.getQueryCache === 'function' && typeof value.getQueryData === 'function') queryClients.add(value);
    }
    for (const chain of maps) {
      for (const node of chain.values()) {
        if (!node?.store || typeof node.store.get !== 'function') continue;
        for (const resolver of resolvers) {
          try {
            const atom = resolver.resolve(node, chain);
            const slots = node.store.get(atom);
            if (Array.isArray(slots) && slots.length === 6 && slots.every((slot, index) => slot?.id === index)) {
              found = { chain, node, slots };
              break;
            }
          } catch {}
        }
        if (found) break;
      }
      if (found) break;
    }
    queue.push(fiber.child, fiber.sibling);
  }
  if (!found) throw new Error('Codex Micro slot store was not found.');

  let layout = definitions.layout.default;
  let agentSource = definitions.agentSource.default;
  let lightingAutoOff = definitions.lightingAutoOff?.default ?? '3-minutes';

  let settingsResolved = false;
  const directSettingReader = exportedValues.find((candidate) => {
    if (typeof candidate !== 'function' || candidate.length !== 1) return false;
    const source = Function.prototype.toString.call(candidate);
    return source.includes('get-setting') && source.includes('.default');
  });
  if (directSettingReader) {
    try {
      const candidateLayout = await directSettingReader(definitions.layout);
      const candidateAgentSource = await directSettingReader(definitions.agentSource);
      const candidateLightingAutoOff = definitions.lightingAutoOff
        ? await directSettingReader(definitions.lightingAutoOff)
        : lightingAutoOff;
      if (
        candidateLayout?.version === 1 &&
        typeof candidateLayout.slots === 'object' &&
        ['pinned', 'recent', 'priority', 'custom'].includes(candidateAgentSource)
      ) {
        layout = candidateLayout;
        agentSource = candidateAgentSource;
        if (typeof candidateLightingAutoOff === 'string') lightingAutoOff = candidateLightingAutoOff;
        settingsResolved = true;
      }
    } catch {}
  }

  if (!settingsResolved) {
    const settingReaders = exportedValues.filter((candidate) => {
      if (typeof candidate !== 'function' || candidate.length !== 2) return false;
      const source = Function.prototype.toString.call(candidate);
      return source.includes('.key') && source.includes('.default');
    });
    const getStoreValue = found.node.store.get.bind(found.node.store);
    for (const readSetting of settingReaders) {
      try {
        const candidateLayout = await readSetting(getStoreValue, definitions.layout);
        const candidateAgentSource = await readSetting(getStoreValue, definitions.agentSource);
        const candidateLightingAutoOff = definitions.lightingAutoOff
          ? await readSetting(getStoreValue, definitions.lightingAutoOff)
          : lightingAutoOff;
        if (candidateLayout?.version !== 1 || typeof candidateLayout.slots !== 'object') continue;
        if (!['pinned', 'recent', 'priority', 'custom'].includes(candidateAgentSource)) continue;
        layout = candidateLayout;
        agentSource = candidateAgentSource;
        if (typeof candidateLightingAutoOff === 'string') lightingAutoOff = candidateLightingAutoOff;
        break;
      } catch {}
    }
  }
  const toEpoch = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 100000000000 ? value * 1000 : value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const slots = found.slots.map((slot) => ({
    ...slot,
    activityAt: toEpoch(slot.activityAt) ?? toEpoch(slot.updatedAt) ?? toEpoch(slot.lastActivityAt) ??
      toEpoch(slot.thread?.updatedAt) ?? toEpoch(slot.task?.updatedAt)
  }));

  let usage;
  let forcedUsageQueryFound = false;
  for (const client of queryClients) {
    try {
      const query = client.getQueryCache().getAll().find((candidate) =>
        JSON.stringify(candidate.queryKey) === '["rate-limit-status"]'
      );
      if (forceUsageRefresh && query && typeof query.fetch === 'function') forcedUsageQueryFound = true;
      const data = await readUsageQueryData(query, forceUsageRefresh);
      usage = normalizeRendererUsage(data, query?.state?.dataUpdatedAt);
      if (!usage) continue;
      break;
    } catch (error) {
      if (forceUsageRefresh) throw error;
    }
  }
  if (forceUsageRefresh && !forcedUsageQueryFound) throw new Error('Codex usage query is unavailable.');
  if (forceUsageRefresh && !usage) throw new Error('Codex usage refresh returned no valid rate-limit usage.');

  const html = document.documentElement;
  const body = document.body;
  const themeWords = [
    html.dataset.theme,
    html.dataset.colorScheme,
    html.className,
    body?.dataset?.theme,
    body?.className,
    getComputedStyle(html).colorScheme
  ].filter(Boolean).join(' ').toLowerCase();
  const explicitDark = /(^|[\\s_-])dark($|[\\s_-])/.test(themeWords);
  const explicitLight = /(^|[\\s_-])light($|[\\s_-])/.test(themeWords);
  const backgrounds = [body, document.getElementById('root'), html]
    .filter(Boolean)
    .map((element) => getComputedStyle(element).backgroundColor)
    .map((value) => value.match(/rgba?\\(([^)]+)\\)/)?.[1]?.split(',').map(Number))
    .filter((channels) => channels?.length >= 3 && (channels.length < 4 || channels[3] > 0));
  const background = backgrounds[0];
  const luminance = background
    ? (0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2]) / 255
    : null;
  const theme = explicitDark || (!explicitLight && (luminance != null ? luminance < 0.42 : matchMedia('(prefers-color-scheme: dark)').matches))
    ? 'dark'
    : 'light';
  const activeThreadElement = document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')
    ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]');
  const activeThreadKey = document.querySelector('[data-above-composer-conversation-id]')
    ?.getAttribute('data-above-composer-conversation-id')
    ?? activeThreadElement?.getAttribute('data-app-action-sidebar-thread-id')
    ?? undefined;
  const activeThreadTitle = activeThreadElement
    ? (activeThreadElement.getAttribute('aria-label') ?? activeThreadElement.textContent ?? '').trim().slice(0, 240) || undefined
    : undefined;
  const reasoningEffort = readActiveReasoningEffort(document.querySelectorAll(
    '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]'
  ));
  const fastModeEnabled = readActiveFastMode(document.querySelectorAll(
    '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]'
  ));

  return {
    slots, activeThreadKey, activeThreadTitle, layout, agentSource, lightingAutoOff, theme,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof fastModeEnabled === 'boolean' ? { fastModeEnabled } : {}),
    ...(usage ? { usage } : {})
  };
})()`;

export class CodexMicroRendererBridge {
  private socket?: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private connecting?: Promise<void>;
  private lastSnapshot?: MicroSnapshot;
  private readonly sessionOwnership = new CodexSessionOwnershipIndex();
  private readonly evaluationNamespace = randomUUID();

  constructor(private readonly log: (message: string) => void) {}

  async refresh(): Promise<MicroSnapshot> {
    try {
      return await this.readSnapshot(false);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  async requestUsageRefresh(): Promise<MicroSnapshot> {
    try {
      return await this.readSnapshot(true);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  async refreshUsage(): Promise<void> {
    await this.requestUsageRefresh();
  }

  private async readSnapshot(forceUsageRefresh: boolean): Promise<MicroSnapshot> {
    await this.ensureConnected();
    const nativeSnapshot = await this.evaluate<MicroSnapshot>(SNAPSHOT_EXPRESSION(forceUsageRefresh));
    if (forceUsageRefresh && !hasValidNormalizedUsage(nativeSnapshot.usage)) {
      throw new Error("Codex usage refresh returned no valid rate-limit usage.");
    }
    const snapshot = await this.sessionOwnership.annotate(nativeSnapshot);
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async sendAgent(slot: number, act: 0 | 1, expectedThreadKey?: string): Promise<void> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 5) throw new Error(`Ungültiger Micro-Agent-Slot: ${slot}`);
    const snapshot = act === 1 ? await this.refresh() : this.lastSnapshot ?? await this.refresh();
    const plan = resolveAgentDispatch(snapshot, slot, expectedThreadKey);
    if (plan.kind === "native") {
      if (plan.slot !== slot) {
        this.log(`Agent slot ${slot + 1} changed before dispatch; using current native slot ${plan.slot + 1}.`);
      }
      await this.dispatch("codex-micro-hid-event", {
        event: { key: `AG0${plan.slot}`, act, slot: plan.slot, threadKey: plan.threadKey }
      }, "codex-micro-hid-event");
      if (act === 0) return;
    } else {
      if (act === 0) return;
      this.log(`Task ${plan.threadKey} is outside this host's six native Micro slots; opening its exact thread identity.`);
    }
    await this.ensureThreadActivated(plan.threadKey);
    this.sessionOwnership.markOpened(plan.threadKey);
  }

  private async ensureThreadActivated(threadKey: string): Promise<void> {
    const result = await this.evaluate<"active" | "opened" | "missing" | "failed">(`(async () => {
      const threadKey = ${JSON.stringify(threadKey)};
      const activeThreadKey = () => document.querySelector('[data-above-composer-conversation-id]')
        ?.getAttribute('data-above-composer-conversation-id')
        ?? document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')
          ?.getAttribute('data-app-action-sidebar-thread-id')
        ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')
          ?.getAttribute('data-app-action-sidebar-thread-id')
        ?? null;
      const waitForActive = async (duration) => {
        const deadline = Date.now() + duration;
        while (Date.now() < deadline) {
          if (activeThreadKey() === threadKey) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return activeThreadKey() === threadKey;
      };
      if (await waitForActive(250)) return 'active';
      const item = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .find((element) => element.getAttribute('data-app-action-sidebar-thread-id') === threadKey);
      if (!item) return 'missing';
      const selector = 'button, a, [role="button"], [role="link"]';
      const clickable = item.matches(selector) ? item : item.querySelector(selector) ?? item.closest(selector) ?? item;
      if (typeof clickable.click === 'function') clickable.click();
      else clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return await waitForActive(1500) ? 'opened' : 'failed';
    })()`);
    if (result === "active" || result === "opened") return;
    if (result === "missing") {
      throw new Error("The exact Codex task is not present in this host's loaded sidebar. Open or pin it once in Codex, then retry.");
    }
    throw new Error("Codex received the task selection but did not activate the requested thread.");
  }

  async sendAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
    const key = slot === "ACT10_ACT11" ? "ACT10" : slot;
    await this.dispatch("codex-micro-hid-event", { event: { key, act, slot: null, threadKey: null } }, "codex-micro-hid-event");
  }

  async sendJoystick(direction: MicroDirection, distance: 0 | 1): Promise<void> {
    const angle: Record<MicroDirection, number> = { up: 0.75, right: 0, down: 0.25, left: 0.5 };
    await this.dispatch("codex-micro-joystick-event", { event: { angle: angle[direction], distance } }, "codex-micro-joystick-event");
  }

  async sendEncoder(act: 0 | 1): Promise<void> {
    await this.dispatch("codex-micro-hid-event", { event: { key: "ENC", act, slot: null, threadKey: null } }, "codex-micro-hid-event");
  }

  async adjustReasoning(
    direction: ReasoningAdjustment,
    policy: ReasoningAdjustmentPolicy = { includeUltra: true }
  ): Promise<ReasoningAdjustmentResult> {
    if (direction === "increase" && !policy.includeUltra) return this.runGuardedReasoningIncrease();
    await this.runReasoningCommand(direction === "increase"
      ? "composer.increaseReasoningEffort"
      : "composer.decreaseReasoningEffort");
    return "applied";
  }

  private async runGuardedReasoningIncrease(): Promise<ReasoningAdjustmentResult> {
    await this.ensureConnected();
    const expression = `(async () => {
      const command = 'composer.increaseReasoningEffort';
      const allowedCommands = new Set(${JSON.stringify(REASONING_COMMANDS)});
      if (!allowedCommands.has(command)) throw new Error('Unsupported reasoning command.');
      const isSafeReasoningIdentifier = (${isSafeReasoningIdentifier.toString()});
      const readOwnDataProperty = (${readOwnDataProperty.toString()});
      const normalizeReasoningEffortOrder = (${normalizeReasoningEffortOrder.toString()});
      const isVisibleReasoningTrigger = (${isVisibleReasoningTrigger.toString()});
      const readSelectedReasoningModelId = (${readSelectedReasoningModelId.toString()});
      const findRendererQueryClients = (${findRendererQueryClients.toString()});
      const readReasoningModelEfforts = (${readReasoningModelEfforts.toString()});
      const readActiveReasoningMetadata = (${readActiveReasoningMetadata.toString()});
      const decideReasoningAdjustment = (${decideReasoningAdjustment.toString()});
      const readLiveDecision = () => {
        const root = document.getElementById('root');
        const reactKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactContainer$'));
        const reactRootProperty = root && reactKey ? readOwnDataProperty(root, reactKey) : undefined;
        const metadata = reactRootProperty?.exists ? readActiveReasoningMetadata(document.querySelectorAll(
          '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]'
        ), reactRootProperty.value) : undefined;
        return decideReasoningAdjustment(
          'increase', { includeUltra: false }, metadata?.currentEffort, metadata?.supportedEfforts
        );
      };
      const decision = readLiveDecision();
      if (decision === 'unavailable') return 'metadata-unavailable';
      if (decision === 'blocked-ultra') return 'blocked-ultra';

      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])];
      const bridgeUrl = urls.find((value) => value.includes('/assets/codex-micro-bridge-'));
      if (!bridgeUrl) throw new Error('Codex Micro bridge module is unavailable.');
      const bridgeSource = await (await fetch(bridgeUrl)).text();
      const resolveCommandRunner = (${resolveCommandRunner.toString()});
      const commandRunner = await resolveCommandRunner(bridgeSource, bridgeUrl, (url) => import(url));
      if (typeof commandRunner !== 'function') throw new Error('Codex command runner is unavailable.');
      const finalDecision = readLiveDecision();
      if (finalDecision === 'unavailable') return 'metadata-unavailable';
      if (finalDecision === 'blocked-ultra') return 'blocked-ultra';
      const handled = commandRunner(command, 'codex_micro_hid');
      if (!handled) throw new Error('This Codex command is not active in the current view.');
      return 'applied';
    })()`;
    let result: ReasoningAdjustmentResult | "metadata-unavailable";
    try {
      result = await this.evaluate<ReasoningAdjustmentResult | "metadata-unavailable">(expression);
    } catch (error) {
      this.disconnect();
      throw error;
    }
    if (result === "metadata-unavailable") throw new Error("Codex reasoning metadata is unavailable.");
    return result;
  }

  private async runReasoningCommand(command: ReasoningCommand): Promise<void> {
    if (!REASONING_COMMANDS.includes(command)) throw new Error("Unsupported reasoning command.");
    await this.ensureConnected();
    const expression = `(async () => {
      const command = ${JSON.stringify(command)};
      const allowedCommands = new Set(${JSON.stringify(REASONING_COMMANDS)});
      if (!allowedCommands.has(command)) throw new Error('Unsupported reasoning command.');
      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])];
      const bridgeUrl = urls.find((value) => value.includes('/assets/codex-micro-bridge-'));
      if (!bridgeUrl) throw new Error('Codex Micro bridge module is unavailable.');
      const bridgeSource = await (await fetch(bridgeUrl)).text();
      const resolveCommandRunner = (${resolveCommandRunner.toString()});
      const commandRunner = await resolveCommandRunner(bridgeSource, bridgeUrl, (url) => import(url));
      if (typeof commandRunner !== 'function') throw new Error('Codex command runner is unavailable.');
      const handled = commandRunner(command, 'codex_micro_hid');
      if (!handled) throw new Error('This Codex command is not active in the current view.');
      return true;
    })()`;
    try {
      await this.evaluate(expression);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  async runKeycap(keycapId: OfficialKeycapId): Promise<void> {
    if (!OFFICIAL_KEYCAP_IDS.includes(keycapId)) throw new Error(`Unknown Codex Micro keycap: ${keycapId}`);
    await this.ensureConnected();
    const expression = `(async () => {
      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])];
      const moduleUrl = (prefix) => urls.find((value) => value.includes('/assets/' + prefix));
      const layoutUrl = moduleUrl('codex-micro-layout-');
      const commandsUrl = moduleUrl('run-command-');
      const bridgeUrl = moduleUrl('codex-micro-bridge-');
      const vscodeUrl = moduleUrl('vscode-api-');
      if (!layoutUrl) throw new Error('Codex Micro keycap registry is unavailable.');
      const layout = await import(layoutUrl);
      const keycapGetter = Object.values(layout).find((candidate) => {
        if (typeof candidate !== 'function') return false;
        try { return candidate('FAST')?.id === 'FAST'; } catch { return false; }
      });
      if (typeof keycapGetter !== 'function') throw new Error('Codex Micro keycap registry changed.');
      const keycap = keycapGetter(${JSON.stringify(keycapId)});
      const action = keycap?.action;
      if (!action) throw new Error('The selected Codex Micro keycap has no action.');

      if (action.type === 'command') {
        let commandRunner = null;
        if (commandsUrl) {
          const commands = await import(commandsUrl);
          if (typeof commands.i === 'function') commandRunner = commands.i;
        }
        if (!commandRunner && bridgeUrl) {
          const bridgeSource = await (await fetch(bridgeUrl)).text();
          const runnerMatch = bridgeSource.match(/([A-Za-z_$][\\w$]*)\\(\\s*[A-Za-z_$][\\w$]*\\??\\.command\\s*,["'\\x60]codex_micro_hid["'\\x60]\\)/);
          const runnerLocal = runnerMatch?.[1];
          const importPattern = /import\\s*\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']/g;
          let importMatch;
          while (runnerLocal && (importMatch = importPattern.exec(bridgeSource))) {
            for (const specifier of importMatch[1].split(',')) {
              const parts = specifier.trim().split(/\\s+as\\s+/);
              const exportName = parts[0];
              const localName = parts[1] ?? parts[0];
              if (localName !== runnerLocal) continue;
              const namespace = await import(new URL(importMatch[2], bridgeUrl).href);
              if (typeof namespace[exportName] === 'function') commandRunner = namespace[exportName];
              break;
            }
            if (commandRunner) break;
          }
        }
        if (typeof commandRunner !== 'function') throw new Error('Codex command runner is unavailable.');
        const handled = commandRunner(action.command, 'codex_micro_hid');
        if (!handled) throw new Error('This Codex command is not active in the current view.');
        return true;
      }

      if (!vscodeUrl) throw new Error('Codex VS Code event module is unavailable for this keycap.');
      const vscode = await import(vscodeUrl);
      const bus = [vscode.g, vscode.m, ...Object.values(vscode)].find((candidate) => candidate && typeof candidate === 'object' && (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
      if (!bus) throw new Error('Codex VS Code event bus was not found.');
      if (action.type === 'external-url' && typeof bus.dispatchMessage === 'function') {
        bus.dispatchMessage('open-in-browser', { url: action.url, source: 'manual', initiator: 'open_in_browser_bridge' });
        return true;
      }
      if (action.type === 'composer-text' && typeof bus.dispatchHostMessage === 'function') {
        bus.dispatchHostMessage({ type: 'codex-micro-insert-composer-text', text: action.text });
        return true;
      }
      throw new Error('This Codex Micro keycap action is not supported as a standalone key.');
    })()`;
    try {
      await this.evaluate(expression);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  async consumeRateLimitReset(): Promise<void> {
    await this.ensureConnected();
    const redeemRequestId = randomUUID();
    const expression = `(async () => {
      const hasApplicableResetCredit = (${hasApplicableResetCredit.toString()});
      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
      let client = null;
      for (const url of urls) {
        try {
          const namespace = await import(url);
          client = Object.values(namespace).find((candidate) =>
            candidate && typeof candidate === 'object' &&
            typeof candidate.safeGet === 'function' && typeof candidate.safePost === 'function'
          );
          if (client) break;
        } catch {}
      }
      if (!client) throw new Error('Codex usage client is unavailable.');

      const summary = await client.safeGet('/wham/usage');
      if (!hasApplicableResetCredit(summary?.rate_limit_reset_credits?.applicable_available_count)) {
        throw new Error('No reset credit is currently applicable.');
      }

      const details = await client.safeGet('/wham/rate-limit-reset-credits');
      const credit = Array.isArray(details?.credits)
        ? details.credits.find((candidate) => candidate?.status === 'available' && candidate?.is_supported_by_plan !== false)
        : null;
      if (!credit?.id) throw new Error('No available reset credit was found.');
      const result = await client.safePost('/wham/rate-limit-reset-credits/consume', {
        requestBody: { credit_id: credit.id, redeem_request_id: ${JSON.stringify(redeemRequestId)} }
      });
      if (result?.code !== 'reset' && result?.code !== 'already_redeemed') {
        throw new Error('Codex rejected the reset credit: ' + String(result?.code ?? 'unknown'));
      }

      try {
        const refreshed = await client.safeGet('/wham/usage');
        const root = document.getElementById('root');
        const reactKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactContainer$'));
        const queue = reactKey ? [root[reactKey]] : [];
        const seen = new Set();
        while (queue.length && seen.size < 30000) {
          const fiber = queue.pop();
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          const values = [fiber.memoizedProps?.value];
          let dependency = fiber.dependencies?.firstContext;
          while (dependency) { values.push(dependency.memoizedValue); dependency = dependency.next; }
          const queryClient = values.find((value) =>
            value && typeof value.setQueryData === 'function' && typeof value.invalidateQueries === 'function'
          );
          if (queryClient) {
            queryClient.setQueryData(['rate-limit-status'], refreshed);
            void queryClient.invalidateQueries({ queryKey: ['rate-limit-reset-credits'] });
            break;
          }
          queue.push(fiber.child, fiber.sibling);
        }
      } catch {}
      return result.code;
    })()`;
    try {
      await this.evaluate(expression);
      this.lastSnapshot = undefined;
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  close(): void {
    this.disconnect();
  }

  private async dispatch(type: string, payload: object, requiredHandler: string): Promise<void> {
    await this.ensureConnected();
    const message = { type, ...payload };
    const expression = `(async () => {
      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
      let bus = null;
      for (const url of urls) {
        try {
          const namespace = await import(url);
          bus = Object.values(namespace).find((candidate) => candidate && typeof candidate === 'object' && candidate.handlers instanceof Map && (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
          if (bus) break;
        } catch {}
      }
      if (!bus) throw new Error('Codex VS Code event bus was not found.');
      const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
      if ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0) {
        dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
      }
      const deadline = Date.now() + 1200;
      while ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0) throw new Error('Codex Micro input handler is not active.');
      dispatch.call(bus, ${JSON.stringify(message)});
      return true;
    })()`;
    try {
      await this.evaluate(expression);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try { await this.connecting; }
    finally { this.connecting = undefined; }
  }

  private async connect(): Promise<void> {
    const port = await discoverDebugPort();
    const targets = await fetchJson<DebugTarget[]>(`http://127.0.0.1:${port}/json/list`);
    const target = selectCodexMainTarget(targets);
    if (!target?.webSocketDebuggerUrl) throw new Error("Kein Codex-Hauptfenster mit Debug-Brücke gefunden.");

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Zeitüberschreitung beim Verbinden mit Codex.")), 3000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    socket.on("message", (raw) => this.handleMessage(String(raw)));
    socket.on("close", () => this.disconnect(socket));
    socket.on("error", () => this.disconnect(socket));
    this.socket = socket;
    this.log(`Native Codex-Micro-Brücke verbunden (Port ${port}, ${target.url}).`);
  }

  private evaluate<T = unknown>(expression: string): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Codex-Micro-Brücke ist nicht verbunden."));
    const id = ++this.nextId;
    // CDP may garbage-collect an awaited Runtime.evaluate promise while a
    // renderer handler or dynamic import is still pending. Keep the exact
    // promise reachable from the renderer until after our own timeout.
    const retainedExpression = retainEvaluationPromise(expression, `${this.evaluationNamespace}-${id}`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex-Runtime-Antwort hat zu lange gedauert."));
      }, 5000);
      this.pending.set(id, {
        timer,
        reject,
        resolve: (message) => {
          if (message.error) return reject(new Error(message.error.message ?? "Unbekannter CDP-Fehler."));
          const result = message.result;
          if (result?.exceptionDetails) return reject(new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Codex-Auswertung fehlgeschlagen."));
          resolve(result?.result?.value as T);
        }
      });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: retainedExpression, awaitPromise: true, returnByValue: true } }));
    });
  }

  private handleMessage(raw: string): void {
    let message: CdpResponse;
    try { message = JSON.parse(raw) as CdpResponse; }
    catch { return; }
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private disconnect(expected?: WebSocket): void {
    if (expected && this.socket !== expected) return;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Codex-Micro-Brücke wurde getrennt."));
    }
    this.pending.clear();
  }
}

export function retainEvaluationPromise(expression: string, id: string | number): string {
  const key = `codex-deck-${id}`;
  return `(() => {
    const store = globalThis.__codexDeckPendingEvaluations ??= new Map();
    const pending = Promise.resolve((${expression}));
    store.set(${JSON.stringify(key)}, pending);
    setTimeout(() => store.delete(${JSON.stringify(key)}), 10000);
    return pending;
  })()`;
}

async function discoverDebugPort(): Promise<number> {
  const fromFile = await readPortFile();
  if (fromFile && await isDebugPort(fromFile)) return fromFile;
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="], { timeout: 4000 });
    for (const line of stdout.split("\n")) {
      if (!line.includes(".app/Contents/MacOS/") || !line.includes("--remote-debugging-address=127.0.0.1")) continue;
      const port = Number.parseInt(line.match(/--remote-debugging-port(?:=|\s+)(\d+)/)?.[1] ?? "", 10);
      if (Number.isInteger(port) && await isDebugPort(port)) return port;
    }
    throw new Error("Codex wurde nicht über den macOS-Micro-Aktivierungsstarter geöffnet.");
  }
  if (process.platform !== "win32") throw new Error("Die native Codex-Micro-Brücke wird auf dieser Plattform nicht unterstützt.");

  const command = "$ports = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -match '--remote-debugging-port=(\\d+)' } | ForEach-Object { if ($_.CommandLine -match '--remote-debugging-port=(\\d+)') { $Matches[1] } }; $ports | Select-Object -Unique";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 4000 });
  for (const value of stdout.split(/\s+/)) {
    const port = Number.parseInt(value, 10);
    if (Number.isInteger(port) && await isDebugPort(port)) return port;
  }
  throw new Error("Codex wurde nicht über den Micro-Aktivierungsstarter geöffnet.");
}

async function readPortFile(): Promise<number | null> {
  try {
    const data = JSON.parse(await readFile(PORT_FILE, "utf8")) as { port?: unknown };
    const port = Number(data.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch { return null; }
}

async function isDebugPort(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch { return false; }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Codex-Debug-Endpunkt antwortete mit ${response.status}.`);
  return await response.json() as T;
}
