import { OFFICIAL_KEYCAP_IDS, type OfficialKeycapId } from "./keycaps.js";
import { isSafeReasoningIdentifier } from "./types.js";
import type {
  CodexHost, HostSessionPresence, MicroActionSlot, MicroDirection, MicroSnapshot, ReasoningAdjustment,
  ReasoningAdjustmentResult, RoutedAgentSlot
} from "./types.js";

export const RELAY_PROTOCOL_VERSION = 1;

export type RelayCommand =
  | { kind: "agent"; slot: number; threadKey: string; act: 0 | 1 }
  | { kind: "action"; slot: MicroActionSlot; act: 0 | 1 }
  | { kind: "joystick"; direction: MicroDirection; distance: 0 | 1 }
  | { kind: "encoder"; act: 0 | 1 }
  | {
      kind: "reasoning";
      direction: ReasoningAdjustment;
      includeUltra: boolean;
      includeReasoningFeedback?: true;
    }
  | { kind: "usage-refresh" }
  | { kind: "rate-limit-reset" }
  | { kind: "keycap"; keycapId: OfficialKeycapId };

export type RelayAuthMessage = { type: "auth"; protocol: 1; token: string };
export const RELAY_REASONING_POLICY_CAPABILITY = "reasoning-policy";
export const RELAY_REASONING_FEEDBACK_CAPABILITY = "reasoning-feedback";
export const RELAY_CAPABILITIES = [
  "agent", "action", "joystick", "encoder", "reasoning", RELAY_REASONING_POLICY_CAPABILITY,
  RELAY_REASONING_FEEDBACK_CAPABILITY,
  "keycap", "usage", "usage-refresh", "rate-limit-reset"
] as const;
export type RelayReadyMessage = {
  type: "ready";
  protocol: 1;
  host: CodexHost;
  capabilities?: readonly string[];
  bridge?: "native-codex-micro";
};
export type RelaySnapshotMessage = {
  type: "snapshot";
  protocol: 1;
  host: CodexHost;
  observedAt: number;
  snapshot: MicroSnapshot;
};
export type RelayHealthMessage = {
  type: "health";
  protocol: 1;
  host: CodexHost;
  state: "degraded";
  reason: "native-signals-unavailable";
  observedAt: number;
};
export type RelayCommandMessage = { type: "command"; protocol: 1; requestId: string; command: RelayCommand };
export type RelayResultMessage =
  | {
      type: "result";
      protocol: 1;
      requestId: string;
      ok: true;
      outcome?: ReasoningAdjustmentResult;
      reasoningEffort?: string;
    }
  | { type: "result"; protocol: 1; requestId: string; ok: false; error?: string };
export type RelayServerMessage = RelayReadyMessage | RelaySnapshotMessage | RelayHealthMessage | RelayResultMessage;

export type HostSnapshot = { host: CodexHost; snapshot: MicroSnapshot; observedAt: number };

export function normalizeHostSnapshotAtReceipt(
  input: HostSnapshot,
  receivedAt = Date.now()
): HostSnapshot {
  if (!Number.isFinite(receivedAt) || receivedAt <= 0 || !Number.isFinite(input.observedAt) || input.observedAt <= 0) {
    return input;
  }
  const offset = receivedAt - input.observedAt;
  const shift = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) return value;
    return Math.max(1, value + offset);
  };
  const usage = input.snapshot.usage
    ? {
        ...input.snapshot.usage,
        observedAt: shift(input.snapshot.usage.observedAt)!,
        windows: input.snapshot.usage.windows.map((window) => ({
          ...window,
          resetsAt: window.resetsAt == null ? null : shift(window.resetsAt)
        }))
      }
    : undefined;
  return {
    host: input.host,
    observedAt: receivedAt,
    snapshot: {
      ...input.snapshot,
      slots: input.snapshot.slots.map((slot) => ({
        ...slot,
        activityAt: slot.activityAt == null ? undefined : shift(slot.activityAt)
      })),
      hostSessions: input.snapshot.hostSessions?.map((session) => ({
        ...session,
        activityAt: shift(session.activityAt)!
      })),
      usage
    }
  };
}

type ActivityRecord = { activityAt: number; signature: string; lastSeenAt: number };
type SessionOwner = { input: HostSnapshot; session: HostSessionPresence };
type TemporaryAliasRecord = { identity: string; lastSeenAt: number };
const MIRROR_STATUS_FRESHNESS_MS = 5_000;
const SESSION_COMPLETION_FALLBACK_MS = 5 * 60_000;
const TEMPORARY_ALIAS_RETENTION_MS = 24 * 60 * 60_000;

export class HostActivityIndex {
  private readonly activity = new Map<string, ActivityRecord>();
  private readonly acknowledgedCompletions = new Map<string, number>();
  private readonly temporaryAliases = new Map<string, TemporaryAliasRecord>();

  merge(inputs: HostSnapshot[], now = Date.now(), authoritativeHostId?: string): RoutedAgentSlot[] {
    const aliases = temporaryThreadAliases(inputs, this.temporaryAliases, now);
    const routed: RoutedAgentSlot[] = [];
    for (const input of inputs) {
      for (const slot of input.snapshot.slots) {
        if (!slot.threadKey) continue;
        const key = `${input.host.hostId}:${threadIdentity(slot.threadKey)}`;
        const signature = `${slot.status}:${slot.selected}:${slot.title ?? ""}`;
        const prior = this.activity.get(key);
        const explicit = validTimestamp(slot.activityAt);
        const changed = prior != null && prior.signature !== signature;
        // A snapshot observation is not task activity. In particular, a newly
        // connected host must not make all six of its historical slots appear
        // newer than an already connected host. Only native timestamps or an
        // actually observed slot change establish cross-host recency.
        const activityAt = changed
          ? Math.max(explicit ?? 0, input.observedAt)
          : explicit ?? prior?.activityAt ?? 0;
        this.activity.set(key, { activityAt, signature, lastSeenAt: now });
        routed.push({ ...slot, activityAt, host: input.host, sourceSlot: slot.id, observedAt: input.observedAt });
      }
    }
    for (const [key, value] of this.activity) {
      if (now - value.lastSeenAt > 86_400_000) this.activity.delete(key);
    }
    if (inputs.length === 0) return [];
    if (inputs.length === 1) return nativeSlotOrder(inputs[0]!, routed);

    const mirrors = new Map<string, RoutedAgentSlot[]>();
    for (const slot of routed) {
      const identity = resolvedThreadIdentity(slot.threadKey!, slot.host, aliases);
      const candidates = mirrors.get(identity) ?? [];
      candidates.push(slot);
      mirrors.set(identity, candidates);
    }
    const sessionOwners = sessionOwnerIndex(inputs);
    const activeThreads = new Set([
      ...inputs.flatMap((input) => input.snapshot.activeThreadKey
        ? [resolvedThreadIdentity(input.snapshot.activeThreadKey, input.host, aliases)] : []),
      ...routed.filter((slot) => slot.selected && slot.threadKey)
        .map((slot) => resolvedThreadIdentity(slot.threadKey!, slot.host, aliases))
    ]);
    const merged = [...mirrors.entries()].map(([identity, candidates]) =>
      mergeMirrors(identity, candidates, sessionOwners.get(identity), this.acknowledgedCompletions, activeThreads.has(identity)));
    const byThread = new Map(merged.map((slot) => [
      resolvedThreadIdentity(slot.threadKey!, slot.host, aliases), slot
    ]));
    const authority = inputs.find((input) => input.host.hostId === authoritativeHostId) ?? inputs[0]!;

    if (authority.snapshot.agentSource === "pinned") return pinnedSlotOrder(authority, inputs, byThread, aliases);
    if (authority.snapshot.agentSource === "custom") return customSlotOrder(authority, inputs, byThread, aliases);
    return merged
      .sort(authority.snapshot.agentSource === "priority" ? comparePriority : compareActivity)
      .slice(0, 6)
      .map((slot, id) => ({ ...slot, id }));
  }
}

function nativeSlotOrder(input: HostSnapshot, routed: RoutedAgentSlot[]): RoutedAgentSlot[] {
  const bySourceSlot = new Map(
    routed.filter((candidate) => candidate.host.hostId === input.host.hostId)
      .map((candidate) => [candidate.sourceSlot, candidate])
  );
  return input.snapshot.slots.map((slot, id) => {
    const candidate = bySourceSlot.get(slot.id);
    return candidate ? { ...candidate, id } : emptyRoutedSlot(input, slot, id);
  });
}

function pinnedSlotOrder(
  authority: HostSnapshot,
  inputs: HostSnapshot[],
  byThread: Map<string, RoutedAgentSlot>,
  aliases: Map<string, string>
): RoutedAgentSlot[] {
  const sources = [
    authority,
    ...inputs.filter((input) => input.host.hostId !== authority.host.hostId && input.snapshot.agentSource === "pinned")
  ];
  const result: RoutedAgentSlot[] = [];
  const used = new Set<string>();
  for (let sourceSlot = 0; sourceSlot < 6 && result.length < 6; sourceSlot += 1) {
    for (const source of sources) {
      const slot = source.snapshot.slots[sourceSlot];
      if (!slot?.threadKey) continue;
      const identity = resolvedThreadIdentity(slot.threadKey, source.host, aliases);
      if (used.has(identity)) continue;
      used.add(identity);
      const routed = byThread.get(identity);
      if (routed) result.push({ ...routed, id: result.length });
      if (result.length === 6) break;
    }
  }
  while (result.length < 6) result.push(emptyRoutedPosition(authority, result.length));
  return result;
}

function customSlotOrder(
  authority: HostSnapshot,
  inputs: HostSnapshot[],
  byThread: Map<string, RoutedAgentSlot>,
  aliases: Map<string, string>
): RoutedAgentSlot[] {
  const remoteSources = inputs.filter((input) =>
    input.host.hostId !== authority.host.hostId && input.snapshot.agentSource === "custom"
  );
  const used = new Set<string>();
  return authority.snapshot.slots.map((localSlot, id) => {
    const candidates = [
      { source: authority, slot: localSlot },
      ...remoteSources.map((source) => ({ source, slot: source.snapshot.slots[id]! }))
    ];
    for (const candidate of candidates) {
      if (!candidate.slot?.threadKey) continue;
      const identity = resolvedThreadIdentity(
        candidate.slot.threadKey, candidate.source.host, aliases);
      if (used.has(identity)) continue;
      used.add(identity);
      const routed = byThread.get(identity);
      return routed ? { ...routed, id } : emptyRoutedSlot(candidate.source, candidate.slot, id);
    }
    return emptyRoutedPosition(authority, id);
  });
}

function emptyRoutedSlot(input: HostSnapshot, slot: MicroSnapshot["slots"][number], id: number): RoutedAgentSlot {
  return { ...slot, id, host: input.host, sourceSlot: slot.id, observedAt: input.observedAt };
}

function emptyRoutedPosition(input: HostSnapshot, id: number): RoutedAgentSlot {
  return {
    id, threadKey: null, title: null, status: "off", selected: false,
    host: input.host, sourceSlot: id, observedAt: input.observedAt
  };
}

export function parseRelayServerMessage(value: unknown): RelayServerMessage | null {
  const message = snapshotOwnDataRecord(value);
  if (!message || message.protocol !== RELAY_PROTOCOL_VERSION || typeof message.type !== "string") return null;
  if (message.type === "ready" && isHost(message.host) &&
      (message.bridge === undefined || message.bridge === "native-codex-micro") &&
      (message.capabilities === undefined || (Array.isArray(message.capabilities) && message.capabilities.length <= 32 &&
        message.capabilities.every((item) => boundedNonblankString(item, 64))))) {
    return message as RelayReadyMessage;
  }
  if (message.type === "snapshot" && isHost(message.host) && validProtocolTimestamp(message.observedAt) != null && isSnapshot(message.snapshot)) {
    return message as RelaySnapshotMessage;
  }
  if (message.type === "health" && isHost(message.host) && message.state === "degraded" &&
      message.reason === "native-signals-unavailable" && validProtocolTimestamp(message.observedAt) != null) {
    return message as RelayHealthMessage;
  }
  if (message.type === "result" && boundedNonblankString(message.requestId, 128)) {
    const hasOutcome = message.outcome !== undefined;
    const hasReasoningEffort = message.reasoningEffort !== undefined;
    if (message.ok === true &&
        (!hasOutcome || message.outcome === "applied" || message.outcome === "blocked-ultra") &&
        (!hasReasoningEffort || (hasOutcome && isSafeReasoningIdentifier(message.reasoningEffort))) &&
        exactOwnDataKeys(message, [
          "type", "protocol", "requestId", "ok",
          ...(hasOutcome ? ["outcome"] : []),
          ...(hasReasoningEffort ? ["reasoningEffort"] : [])
        ])) {
      return message as RelayResultMessage;
    }
    if (message.ok === false &&
        (message.error === undefined || (typeof message.error === "string" && message.error.length <= 512)) &&
        exactOwnDataKeys(message, Object.prototype.hasOwnProperty.call(message, "error")
          ? ["type", "protocol", "requestId", "ok", "error"]
          : ["type", "protocol", "requestId", "ok"])) {
      return message as RelayResultMessage;
    }
  }
  return null;
}

export function parseRelayCommand(value: unknown): RelayCommand | null {
  const command = snapshotOwnDataRecord(value);
  if (!command || typeof command.kind !== "string") return null;
  if (command.kind === "agent" && integerIn(command.slot, 0, 5) && isThreadKey(command.threadKey) && binary(command.act)) return command as RelayCommand;
  if (command.kind === "action" && typeof command.slot === "string" &&
      ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"].includes(command.slot) && binary(command.act)) return command as RelayCommand;
  if (command.kind === "joystick" && typeof command.direction === "string" &&
      ["up", "right", "down", "left"].includes(command.direction) && binary(command.distance)) return command as RelayCommand;
  if (command.kind === "encoder" && binary(command.act)) return command as RelayCommand;
  if (command.kind === "reasoning" && (command.direction === "decrease" || command.direction === "increase") &&
      typeof command.includeUltra === "boolean" &&
      (command.includeReasoningFeedback === undefined || command.includeReasoningFeedback === true) &&
      exactOwnDataKeys(command, ["kind", "direction", "includeUltra",
        ...(command.includeReasoningFeedback === true ? ["includeReasoningFeedback"] : [])])) {
    return command as RelayCommand;
  }
  if (command.kind === "usage-refresh" && exactOwnDataKeys(command, ["kind"])) return command as RelayCommand;
  if (command.kind === "rate-limit-reset" && exactOwnDataKeys(command, ["kind"])) return command as RelayCommand;
  if (command.kind === "keycap" && typeof command.keycapId === "string" && OFFICIAL_KEYCAP_IDS.includes(command.keycapId as OfficialKeycapId)) return command as RelayCommand;
  return null;
}

function isSnapshot(value: unknown): value is MicroSnapshot {
  const snapshot = snapshotOwnDataRecord(value);
  if (!snapshot || !Array.isArray(snapshot.slots) || snapshot.slots.length !== 6 || !isLayout(snapshot.layout)) return false;
  if (!snapshot.slots.every((slot, index) => isRecord(slot) && slot.id === index &&
    (slot.threadKey === null || isThreadKey(slot.threadKey)) &&
    (slot.title === null || (typeof slot.title === "string" && slot.title.length <= 240)) &&
    boundedNonblankString(slot.status, 64) && typeof slot.selected === "boolean" &&
    (slot.activityAt === undefined || validProtocolTimestamp(slot.activityAt) != null) &&
    (slot.ownedByHost === undefined || typeof slot.ownedByHost === "boolean") &&
    (slot.contextUsedPercent === undefined || finitePercent(slot.contextUsedPercent)))) return false;
  if (!(["pinned", "recent", "priority", "custom"] as const).includes(snapshot.agentSource as never)) return false;
  if (!boundedNonblankString(snapshot.lightingAutoOff, 64) || !(["light", "dark"] as const).includes(snapshot.theme as never)) return false;
  if (snapshot.activeThreadKey !== undefined && !isThreadKey(snapshot.activeThreadKey)) return false;
  if (snapshot.activeThreadTitle !== undefined && (typeof snapshot.activeThreadTitle !== "string" || snapshot.activeThreadTitle.length > 240)) return false;
  if (snapshot.reasoningEffort !== undefined && !isSafeReasoningIdentifier(snapshot.reasoningEffort)) return false;
  if (snapshot.fastModeEnabled !== undefined && typeof snapshot.fastModeEnabled !== "boolean") return false;
  const hasActiveModelId = Object.prototype.hasOwnProperty.call(snapshot, "activeModelId");
  const hasActiveModelDisplayName = Object.prototype.hasOwnProperty.call(snapshot, "activeModelDisplayName");
  const hasModelCatalog = Object.prototype.hasOwnProperty.call(snapshot, "modelCatalog");
  if (!(hasActiveModelId === hasActiveModelDisplayName && hasActiveModelId === hasModelCatalog)) return false;
  if (hasModelCatalog && snapshot.reasoningEffort === undefined) return false;
  if (hasModelCatalog && !isActiveModelCatalog(
    snapshot.activeModelId, snapshot.activeModelDisplayName, snapshot.modelCatalog
  )) return false;
  if (snapshot.usage !== undefined && !isUsageSnapshot(snapshot.usage)) return false;
  if (snapshot.hostSessions === undefined) return true;
  return Array.isArray(snapshot.hostSessions) && snapshot.hostSessions.length <= 128 && snapshot.hostSessions.every((session) =>
    isRecord(session) && isThreadKey(session.threadId) && validProtocolTimestamp(session.activityAt) != null &&
    typeof session.status === "string" && ["idle", "working", "complete"].includes(session.status) &&
    (session.completionRevision === undefined || integerIn(session.completionRevision, 0, Number.MAX_SAFE_INTEGER)) &&
    (session.contextUsedPercent === undefined || finitePercent(session.contextUsedPercent))
  );
}

function isActiveModelCatalog(activeModelId: unknown, activeDisplayName: unknown, value: unknown): boolean {
  if (!isSafeReasoningIdentifier(activeModelId, 128) || !boundedNonblankString(activeDisplayName, 80)) return false;
  const catalog = snapshotOwnDataArray(value, 32);
  if (!catalog || catalog.length === 0) return false;
  const seenModels = new Set<string>();
  let activeMatch = false;
  for (const rawEntry of catalog) {
    const entry = snapshotOwnDataRecord(rawEntry);
    if (!entry || !exactOwnDataKeys(entry, ["modelId", "displayName", "supportedReasoningEfforts"]) ||
        !isSafeReasoningIdentifier(entry.modelId, 128) || !boundedNonblankString(entry.displayName, 80) ||
        seenModels.has(entry.modelId)) return false;
    const efforts = snapshotOwnDataArray(entry.supportedReasoningEfforts, 16);
    if (!efforts || efforts.length === 0) return false;
    const seenEfforts = new Set<string>();
    for (const effort of efforts) {
      if (!isSafeReasoningIdentifier(effort) || seenEfforts.has(effort)) return false;
      seenEfforts.add(effort);
    }
    seenModels.add(entry.modelId);
    if (entry.modelId === activeModelId) {
      if (entry.displayName !== activeDisplayName) return false;
      activeMatch = true;
    }
  }
  return activeMatch;
}

function isLayout(value: unknown): value is MicroSnapshot["layout"] {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.slots) || !isRecord(value.analogStick)) return false;
  const slots = value.slots;
  const actionSlots: readonly MicroActionSlot[] = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"];
  if (!actionSlots.every((key) => {
    const slot = slots[key];
    return isRecord(slot) && typeof slot.keycapId === "string" &&
      OFFICIAL_KEYCAP_IDS.includes(slot.keycapId as OfficialKeycapId) &&
      (slot.commandId === undefined || (typeof slot.commandId === "string" && slot.commandId.length <= 128));
  })) return false;
  return (["up", "right", "down", "left"] as const).every((key) =>
    Object.prototype.hasOwnProperty.call(value.analogStick, key));
}

function isUsageSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.windows) || value.windows.length > 8 || validProtocolTimestamp(value.observedAt) == null) return false;
  if (value.resetCreditsAvailable !== null && !integerIn(value.resetCreditsAvailable, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (value.resetCreditsApplicable !== null && !integerIn(value.resetCreditsApplicable, 0, Number.MAX_SAFE_INTEGER)) return false;
  return value.windows.every((window) => isRecord(window) && boundedNonblankString(window.id, 64) &&
    typeof window.kind === "string" && ["five-hour", "weekly", "other"].includes(window.kind) &&
    finitePercent(window.usedPercent) && finitePercent(window.remainingPercent) &&
    (window.windowDurationMins === null || positiveBoundedNumber(window.windowDurationMins)) &&
    (window.resetsAt === null || validProtocolTimestamp(window.resetsAt) != null));
}

function isHost(value: unknown): value is CodexHost {
  return isRecord(value) && boundedNonblankString(value.hostId, 128) && boundedNonblankString(value.hostName, 128) &&
    typeof value.platform === "string" && ["win32", "darwin"].includes(value.platform) &&
    (value.codexVersion === undefined || boundedNonblankString(value.codexVersion, 64));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function snapshotOwnDataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!isRecord(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotOwnDataArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    const arrayLength: unknown = lengthDescriptor?.value;
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
        !Number.isSafeInteger(arrayLength) || Number(arrayLength) < 0 || Number(arrayLength) > maximum) return null;
    const result: unknown[] = [];
    for (let index = 0; index < Number(arrayLength); index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) return null;
      result.push(descriptor.value);
    }
    const expectedKeys = new Set(["length", ...result.map((_, index) => String(index))]);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !expectedKeys.has(key))) return null;
    return result;
  } catch {
    return null;
  }
}

function exactOwnDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) =>
    typeof key === "string" && expected.includes(key));
}

function binary(value: unknown): value is 0 | 1 { return value === 0 || value === 1; }
function boundedNonblankString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}
function finitePercent(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function validTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function validProtocolTimestamp(value: unknown): number | null {
  return positiveBoundedNumber(value) ? value : null;
}
function positiveBoundedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

function compareOwnership(left: RoutedAgentSlot, right: RoutedAgentSlot): number {
  const ownership = Number(right.ownedByHost === true) - Number(left.ownedByHost === true);
  if (ownership) return ownership;
  const status = hostStatusPriority(right.status) - hostStatusPriority(left.status);
  if (status) return status;
  if (left.selected !== right.selected) return left.selected ? -1 : 1;
  return compareActivity(left, right);
}

function mergeMirrors(
  identity: string,
  candidates: RoutedAgentSlot[],
  sessionOwner: SessionOwner | undefined,
  acknowledgedCompletions: Map<string, number>,
  activeOnAnyHost: boolean
): RoutedAgentSlot {
  const newestObservation = Math.max(...candidates.map((candidate) => candidate.observedAt));
  const statusCandidates = candidates.filter(
    (candidate) => newestObservation - candidate.observedAt <= MIRROR_STATUS_FRESHNESS_MS);
  const statusSessionOwner = sessionOwner &&
    newestObservation - sessionOwner.input.observedAt <= MIRROR_STATUS_FRESHNESS_MS
    ? sessionOwner
    : undefined;
  let owner = candidates[0]!;
  const explicitOwner = sessionOwner && candidates.find((candidate) => candidate.host.hostId === sessionOwner.input.host.hostId);
  if (explicitOwner) owner = explicitOwner;
  else {
    for (const candidate of candidates.slice(1)) {
      if (compareOwnership(candidate, owner) < 0) owner = candidate;
    }
  }
  const strongest = [...statusCandidates].sort((left, right) =>
    mirrorStatusPriority(right.status) - mirrorStatusPriority(left.status) ||
    Number(right.selected) - Number(left.selected)
  )[0]!;
  const ownedCandidates = candidates.filter((candidate) => candidate.ownedByHost === true);
  const recencyCandidates = ownedCandidates.length ? ownedCandidates : candidates;
  const sessionStatus = statusSessionOwner?.session.status;
  const completionRevision = statusSessionOwner?.session.completionRevision;
  const completionKey = statusSessionOwner ? `${statusSessionOwner.input.host.hostId}:${identity}` : identity;
  const strongestIsWorking = ["working", "thinking"].includes(strongest.status);
  if (sessionStatus === "complete" && completionRevision != null &&
    activeOnAnyHost && !strongestIsWorking) {
    acknowledgedCompletions.set(completionKey, completionRevision);
  }
  const completionAcknowledged = sessionStatus === "complete" && completionRevision != null &&
    acknowledgedCompletions.get(completionKey) === completionRevision;
  const completionIsRecent = sessionStatus === "complete" && statusSessionOwner != null &&
    newestObservation - statusSessionOwner.session.activityAt <= SESSION_COMPLETION_FALLBACK_MS;
  const attention = ["approval", "awaiting-approval", "awaiting-response", "error"];
  const attentionStatus = attention.find((status) => statusCandidates.some((candidate) => candidate.status === status));
  const completionLike = ["complete", "completed", "done"];
  const status = attentionStatus
    ? attentionStatus
    : strongestIsWorking
      ? strongest.status
      : sessionStatus === "working"
      ? "working"
      : sessionStatus === "complete" && completionIsRecent && !completionAcknowledged
        ? (completionLike.includes(strongest.status) || strongest.status === "unread" ? strongest.status : "complete")
        : completionAcknowledged
          ? "idle"
          : strongest.status;
  const routedOwner = sessionOwner?.input.host ?? owner.host;
  const contextCandidate = candidates.find((candidate) =>
    candidate.ownedByHost === true && candidate.contextUsedPercent != null)
    ?? candidates.find((candidate) => candidate.contextUsedPercent != null);
  const titleCandidate = candidates.find((candidate) => normalizedTitle(candidate.title));
  return {
    ...owner,
    host: routedOwner,
    ownedByHost: sessionOwner ? true : owner.ownedByHost,
    title: normalizedTitle(owner.title) ? owner.title : titleCandidate?.title ?? null,
    status,
    selected: statusCandidates.some((candidate) => candidate.selected),
    contextUsedPercent: sessionOwner?.session.contextUsedPercent ?? contextCandidate?.contextUsedPercent,
    // A delayed status update in a cloud/SSH mirror must not make the task look
    // newly active or cause two simultaneously working keys to swap places.
    // Status and selection remain aggregated, but recency follows the backing
    // rollout owner whenever ownership is known.
    activityAt: Math.max(sessionOwner?.session.activityAt ?? 0, ...recencyCandidates.map((candidate) => candidate.activityAt ?? 0)),
    observedAt: newestObservation
  };
}

function sessionOwnerIndex(inputs: HostSnapshot[]): Map<string, SessionOwner> {
  const owners = new Map<string, SessionOwner>();
  for (const input of inputs) {
    for (const session of input.snapshot.hostSessions ?? []) {
      const identity = threadIdentity(session.threadId);
      const prior = owners.get(identity);
      if (!prior || session.activityAt > prior.session.activityAt) owners.set(identity, { input, session });
    }
  }
  return owners;
}

function compareActivity(left: RoutedAgentSlot, right: RoutedAgentSlot): number {
  if (left.selected !== right.selected) return left.selected ? -1 : 1;
  const status = hostStatusPriority(right.status) - hostStatusPriority(left.status);
  if (status) return status;
  return (right.activityAt ?? 0) - (left.activityAt ?? 0) || left.sourceSlot - right.sourceSlot;
}

function comparePriority(left: RoutedAgentSlot, right: RoutedAgentSlot): number {
  return priorityModeStatus(right.status) - priorityModeStatus(left.status) ||
    Number(right.selected) - Number(left.selected) ||
    (right.activityAt ?? 0) - (left.activityAt ?? 0) ||
    left.sourceSlot - right.sourceSlot;
}

function priorityModeStatus(status: string): number {
  if (["approval", "awaiting-approval", "awaiting-response"].includes(status)) return 4;
  if (["unread", "error", "complete", "completed", "done"].includes(status)) return 3;
  if (["working", "thinking"].includes(status)) return 2;
  if (status === "idle") return 1;
  return 0;
}

function hostStatusPriority(status: string): number {
  if (["working", "thinking", "approval", "awaiting-approval", "awaiting-response"].includes(status)) return 3;
  if (["unread", "error", "complete", "completed", "done"].includes(status)) return 2;
  if (status === "idle") return 1;
  return 0;
}

function mirrorStatusPriority(status: string): number {
  if (["working", "thinking", "approval", "awaiting-approval", "awaiting-response"].includes(status)) return 4;
  if (["unread", "error"].includes(status)) return 3;
  if (["complete", "completed", "done"].includes(status)) return 2;
  if (status === "idle") return 1;
  return 0;
}
function isThreadKey(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-z][a-z0-9_-]{0,31}:){0,3}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function threadIdentity(value: string): string {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0]?.toLowerCase() ?? value;
}

function temporaryThreadAliases(
  inputs: HostSnapshot[],
  remembered: Map<string, TemporaryAliasRecord>,
  now: number
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const input of inputs) {
    const ownedSessions = new Set(
      (input.snapshot.hostSessions ?? []).map((session) => threadIdentity(session.threadId)));
    if (!ownedSessions.size) continue;

    for (const slot of input.snapshot.slots) {
      if (!slot.threadKey?.toLowerCase().includes(":client-new-thread:")) continue;
      const temporaryKey = aliasKey(input.host, threadIdentity(slot.threadKey));
      const prior = remembered.get(temporaryKey);
      if (prior && now - prior.lastSeenAt <= TEMPORARY_ALIAS_RETENTION_MS) {
        aliases.set(temporaryKey, prior.identity);
        prior.lastSeenAt = now;
      }
      const activeIdentity = input.snapshot.activeThreadKey
        ? threadIdentity(input.snapshot.activeThreadKey) : null;
      if (slot.selected && activeIdentity && ownedSessions.has(activeIdentity) &&
        !input.snapshot.activeThreadKey?.toLowerCase().includes(":client-new-thread:")) {
        aliases.set(temporaryKey, activeIdentity);
        remembered.set(temporaryKey, { identity: activeIdentity, lastSeenAt: now });
        continue;
      }
      const title = normalizedTitle(slot.title);
      if (!title) continue;
      const matches = new Set<string>();
      for (const remote of inputs) {
        if (remote.host.hostId === input.host.hostId) continue;
        for (const candidate of remote.snapshot.slots) {
          if (!candidate.threadKey || normalizedTitle(candidate.title) !== title) continue;
          const identity = threadIdentity(candidate.threadKey);
          if (ownedSessions.has(identity)) matches.add(identity);
        }
      }
      if (matches.size !== 1) continue;
      const identity = [...matches][0]!;
      aliases.set(temporaryKey, identity);
      remembered.set(temporaryKey, { identity, lastSeenAt: now });
    }
  }
  for (const [key, record] of remembered) {
    if (now - record.lastSeenAt > TEMPORARY_ALIAS_RETENTION_MS) remembered.delete(key);
  }
  return aliases;
}

function resolvedThreadIdentity(
  threadKey: string,
  host: CodexHost,
  aliases: Map<string, string>
): string {
  const identity = threadIdentity(threadKey);
  return aliases.get(aliasKey(host, identity)) ?? identity;
}

function aliasKey(host: CodexHost, identity: string): string {
  return `${host.hostId}:${identity}`;
}

function normalizedTitle(title: string | null | undefined): string | null {
  const value = title?.trim().toLocaleLowerCase();
  return value ? value : null;
}
