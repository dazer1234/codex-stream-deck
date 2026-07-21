import { OFFICIAL_KEYCAP_IDS, type OfficialKeycapId } from "./keycaps.js";
import type {
  CodexHost, HostSessionPresence, MicroActionSlot, MicroDirection, MicroSnapshot, ReasoningAdjustment, RoutedAgentSlot
} from "./types.js";

export const RELAY_PROTOCOL_VERSION = 1;

export type RelayCommand =
  | { kind: "agent"; slot: number; threadKey: string; act: 0 | 1 }
  | { kind: "action"; slot: MicroActionSlot; act: 0 | 1 }
  | { kind: "joystick"; direction: MicroDirection; distance: 0 | 1 }
  | { kind: "encoder"; act: 0 | 1 }
  | { kind: "reasoning"; direction: ReasoningAdjustment }
  | { kind: "rate-limit-reset" }
  | { kind: "keycap"; keycapId: OfficialKeycapId };

export type RelayAuthMessage = { type: "auth"; protocol: 1; token: string };
export const RELAY_CAPABILITIES = [
  "agent", "action", "joystick", "encoder", "reasoning", "keycap", "usage", "rate-limit-reset"
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
export type RelayResultMessage = { type: "result"; protocol: 1; requestId: string; ok: boolean; error?: string };
export type RelayServerMessage = RelayReadyMessage | RelaySnapshotMessage | RelayHealthMessage | RelayResultMessage;

export type HostSnapshot = { host: CodexHost; snapshot: MicroSnapshot; observedAt: number };

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
  if (!isRecord(value) || value.protocol !== RELAY_PROTOCOL_VERSION || typeof value.type !== "string") return null;
  if (value.type === "ready" && isHost(value.host)) return value as RelayReadyMessage;
  if (value.type === "snapshot" && isHost(value.host) && Number.isFinite(value.observedAt) && isSnapshot(value.snapshot)) {
    return value as RelaySnapshotMessage;
  }
  if (value.type === "health" && isHost(value.host) && value.state === "degraded" &&
      value.reason === "native-signals-unavailable" && Number.isFinite(value.observedAt)) {
    return value as RelayHealthMessage;
  }
  if (value.type === "result" && typeof value.requestId === "string" && typeof value.ok === "boolean") {
    return value as RelayResultMessage;
  }
  return null;
}

export function parseRelayCommand(value: unknown): RelayCommand | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "agent" && integerIn(value.slot, 0, 5) && isThreadKey(value.threadKey) && binary(value.act)) return value as RelayCommand;
  if (value.kind === "action" && ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"].includes(String(value.slot)) && binary(value.act)) return value as RelayCommand;
  if (value.kind === "joystick" && ["up", "right", "down", "left"].includes(String(value.direction)) && binary(value.distance)) return value as RelayCommand;
  if (value.kind === "encoder" && binary(value.act)) return value as RelayCommand;
  if (value.kind === "reasoning" && ["decrease", "increase"].includes(String(value.direction))) return value as RelayCommand;
  if (value.kind === "rate-limit-reset") return value as RelayCommand;
  if (value.kind === "keycap" && typeof value.keycapId === "string" && OFFICIAL_KEYCAP_IDS.includes(value.keycapId as OfficialKeycapId)) return value as RelayCommand;
  return null;
}

function isSnapshot(value: unknown): value is MicroSnapshot {
  if (!isRecord(value) || !Array.isArray(value.slots) || value.slots.length !== 6 || !isRecord(value.layout)) return false;
  if (!value.slots.every((slot, index) => isRecord(slot) && slot.id === index && typeof slot.status === "string" &&
    (slot.contextUsedPercent == null || finitePercent(slot.contextUsedPercent)))) return false;
  if (value.activeThreadKey != null && !isThreadKey(value.activeThreadKey)) return false;
  if (value.activeThreadTitle != null && (typeof value.activeThreadTitle !== "string" || value.activeThreadTitle.length > 240)) return false;
  if (value.usage != null && !isUsageSnapshot(value.usage)) return false;
  if (value.hostSessions == null) return true;
  return Array.isArray(value.hostSessions) && value.hostSessions.length <= 128 && value.hostSessions.every((session) =>
    isRecord(session) && isThreadKey(session.threadId) && validTimestamp(session.activityAt) != null &&
    ["idle", "working", "complete"].includes(String(session.status)) &&
    (session.completionRevision == null || integerIn(session.completionRevision, 0, Number.MAX_SAFE_INTEGER)) &&
    (session.contextUsedPercent == null || finitePercent(session.contextUsedPercent))
  );
}

function isUsageSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.windows) || value.windows.length > 8 || validTimestamp(value.observedAt) == null) return false;
  if (value.resetCreditsAvailable != null && !integerIn(value.resetCreditsAvailable, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (value.resetCreditsApplicable != null && !integerIn(value.resetCreditsApplicable, 0, Number.MAX_SAFE_INTEGER)) return false;
  return value.windows.every((window) => isRecord(window) && typeof window.id === "string" && window.id.length <= 64 &&
    ["five-hour", "weekly", "other"].includes(String(window.kind)) &&
    finitePercent(window.usedPercent) && finitePercent(window.remainingPercent) &&
    (window.windowDurationMins == null || (typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0)) &&
    (window.resetsAt == null || validTimestamp(window.resetsAt) != null));
}

function isHost(value: unknown): value is CodexHost {
  return isRecord(value) && typeof value.hostId === "string" && typeof value.hostName === "string" &&
    ["win32", "darwin"].includes(String(value.platform)) &&
    (value.codexVersion == null || (typeof value.codexVersion === "string" && value.codexVersion.length <= 64));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function binary(value: unknown): value is 0 | 1 { return value === 0 || value === 1; }
function finitePercent(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function validTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
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
