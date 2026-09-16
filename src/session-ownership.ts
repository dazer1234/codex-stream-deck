import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { HostSessionPresence, MicroSnapshot } from "./types.js";

const SESSION_FILENAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const THREAD_KEY = /(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COMPLETION_FRESHNESS_MS = 5 * 60_000;

export class CodexSessionOwnershipIndex {
  private sessionIds = new Set<string>();
  private projectNames = new Map<string, string>();
  private recentSessions: HostSessionPresence[] = [];
  private acknowledgedCompletions = new Map<string, number>();
  private contextParsedSessions = new Set<string>();
  private refreshedAt = 0;
  private refreshInFlight?: Promise<void>;

  constructor(
    private readonly roots = defaultSessionRoots(),
    private readonly refreshIntervalMs = 5_000
  ) {}

  async annotate(snapshot: MicroSnapshot, now = Date.now()): Promise<MicroSnapshot> {
    const trackedSessions = new Set(snapshot.slots
      .map((slot) => sessionIdFromThreadKey(slot.threadKey))
      .filter((sessionId): sessionId is string => sessionId != null));
    const activeSessionId = sessionIdFromThreadKey(snapshot.activeThreadKey ?? null);
    if (activeSessionId) trackedSessions.add(activeSessionId);
    await this.refreshIfNeeded(now, trackedSessions);
    const selectedSessions = new Set(snapshot.slots
      .filter((slot) => slot.selected)
      .map((slot) => sessionIdFromThreadKey(slot.threadKey))
      .filter((sessionId): sessionId is string => sessionId != null));
    if (activeSessionId) selectedSessions.add(activeSessionId);
    for (const session of this.recentSessions) {
      if (session.status === "complete" && session.completionRevision != null && selectedSessions.has(session.threadId)) {
        this.acknowledgedCompletions.set(session.threadId, session.completionRevision);
      }
    }
    const visibleSessions = new Map(this.recentSessions.map((session) => {
      const completionIsAcknowledged = session.status === "complete" && session.completionRevision != null &&
        this.acknowledgedCompletions.get(session.threadId) === session.completionRevision;
      const completionIsStale = session.status === "complete" && now - session.activityAt > COMPLETION_FRESHNESS_MS;
      return [session.threadId, {
        ...session,
        status: completionIsAcknowledged || completionIsStale ? "idle" as const : session.status
      }];
    }));
    return {
      ...snapshot,
      hostSessions: [...visibleSessions.values()],
      slots: snapshot.slots.map((slot) => {
        const sessionId = sessionIdFromThreadKey(slot.threadKey);
        const session = sessionId ? visibleSessions.get(sessionId) : undefined;
        const ownedByHost = sessionId != null && this.sessionIds.has(sessionId);
        return {
          ...slot,
          ...(sessionId != null && this.projectNames.get(sessionId)
            ? { projectName: this.projectNames.get(sessionId) }
            : {}),
          ownedByHost,
          status: ownedByHost && session ? reconcileOwnedStatus(slot.status, session.status) : slot.status,
          ...(session?.contextUsedPercent != null
            ? { contextUsedPercent: session.contextUsedPercent }
            : {})
        };
      })
    };
  }

  markOpened(threadKey: string, _now = Date.now()): void {
    const sessionId = sessionIdFromThreadKey(threadKey);
    if (!sessionId) return;
    const session = this.recentSessions.find((candidate) => candidate.threadId === sessionId);
    if (session?.status === "complete" && session.completionRevision != null) {
      this.acknowledgedCompletions.set(sessionId, session.completionRevision);
    }
  }

  private async refreshIfNeeded(now: number, trackedSessions: Set<string>): Promise<void> {
    const needsContext = [...trackedSessions].some((sessionId) => !this.contextParsedSessions.has(sessionId));
    if (!needsContext && now - this.refreshedAt < this.refreshIntervalMs) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refresh(now, trackedSessions);
    this.refreshInFlight = pending;
    try { await pending; }
    finally { if (this.refreshInFlight === pending) this.refreshInFlight = undefined; }
  }

  private async refresh(now: number, trackedSessions: Set<string>): Promise<void> {
    const next = new Set<string>();
    const sessionFiles: Array<{ threadId: string; path: string }> = [];
    const files: Array<{ threadId: string; path: string; activityAt: number }> = [];
    for (const root of this.roots) {
      try {
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const sessionId = sessionIdFromRolloutFilename(entry.name);
          if (!sessionId) continue;
          next.add(sessionId);
          const parentPath = (entry as typeof entry & { parentPath?: string; path?: string }).parentPath
            ?? (entry as typeof entry & { path?: string }).path;
          if (!parentPath) continue;
          sessionFiles.push({ threadId: sessionId, path: join(parentPath, entry.name) });
        }
      }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
    }
    for (let index = 0; index < sessionFiles.length; index += 32) {
      const batch = sessionFiles.slice(index, index + 32);
      const resolved = await Promise.all(batch.map(async ({ threadId, path }) => {
        try {
          const info = await stat(path);
          return { threadId, path, activityAt: info.mtimeMs };
        } catch { return null; }
      }));
      files.push(...resolved.filter((value): value is NonNullable<typeof value> => value != null));
    }
    this.sessionIds = next;
    const uniqueRecent = new Map<string, typeof files[number]>();
    for (const file of files.sort((left, right) => right.activityAt - left.activityAt)) {
      if (!uniqueRecent.has(file.threadId)) uniqueRecent.set(file.threadId, file);
    }
    const recent = [...uniqueRecent.values()].slice(0, 128);
    const contextParsed = new Set<string>();
    const parsedSessions = await Promise.all(recent.map(async ({ threadId, path, activityAt: fileActivityAt }) => {
      const shouldRead = now - fileActivityAt <= 15 * 60_000 || trackedSessions.has(threadId);
      const [recentStatus, projectName] = shouldRead
        ? await Promise.all([readRecentSessionStatus(path), readSessionProjectName(path)])
        : [{ status: "idle" as const }, undefined] as const;
      if (shouldRead) contextParsed.add(threadId);
      const { activityAt, ...status } = recentStatus;
      return { threadId, projectName, presence: { threadId, activityAt: activityAt ?? fileActivityAt, ...status } };
    }));
    this.recentSessions = parsedSessions.map(({ presence }) => presence);
    this.projectNames = new Map(parsedSessions.flatMap(({ threadId, projectName }) =>
      projectName ? [[threadId, projectName] as const] : []));
    this.contextParsedSessions = contextParsed;
    const currentIds = new Set(this.recentSessions.map((session) => session.threadId));
    for (const threadId of this.acknowledgedCompletions.keys()) {
      if (!currentIds.has(threadId)) this.acknowledgedCompletions.delete(threadId);
    }
    this.refreshedAt = now;
  }
}

async function readSessionProjectName(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLineEnd = buffer.indexOf(0x0a, 0);
      if (firstLineEnd < 0 || firstLineEnd > bytesRead) return undefined;
      const event = JSON.parse(buffer.subarray(0, firstLineEnd).toString("utf8")) as {
        type?: string;
        payload?: { cwd?: unknown };
      };
      if (event.type !== "session_meta" || typeof event.payload?.cwd !== "string") return undefined;
      const label = basename(event.payload.cwd.trim());
      return label && label.length <= 80 ? label : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export function sessionIdFromRolloutFilename(filename: string): string | null {
  return filename.match(SESSION_FILENAME)?.[1]?.toLowerCase() ?? null;
}

export function sessionIdFromThreadKey(threadKey: string | null): string | null {
  return threadKey?.match(THREAD_KEY)?.[1]?.toLowerCase() ?? null;
}

function defaultSessionRoots(): string[] {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
}

async function readRecentSessionStatus(
  path: string
): Promise<Pick<HostSessionPresence, "status" | "completionRevision" | "contextUsedPercent"> & { activityAt?: number }> {
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      const length = Math.min(info.size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, info.size - length));
      const tail = buffer.toString("utf8");
      const baseOffset = info.size - length;
      let lifecycle: "working" | "complete" | undefined;
      let completionRevision: number | undefined;
      let activityAt: number | undefined;
      let lineStart = baseOffset === 0 ? 0 : buffer.indexOf(0x0a) + 1;
      while (lineStart < buffer.length) {
        const newline = buffer.indexOf(0x0a, lineStart);
        const lineEnd = newline < 0 ? buffer.length : newline;
        try {
          const event = JSON.parse(buffer.subarray(lineStart, lineEnd).toString("utf8")) as {
            type?: string;
            timestamp?: string;
            payload?: { type?: string; role?: string };
          };
          const eventType = event.type === "event_msg" ? event.payload?.type : undefined;
          const responseType = event.type === "response_item" ? event.payload?.type : undefined;
          const eventTime = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
          if (eventType === "task_started" || eventType === "agent_reasoning" || eventType === "function_call") {
            lifecycle = "working";
            if (Number.isFinite(eventTime)) activityAt = eventTime;
          } else if (eventType === "task_complete") {
            lifecycle = "complete";
            completionRevision = baseOffset + lineStart;
            if (Number.isFinite(eventTime)) activityAt = eventTime;
          } else if (["reasoning", "custom_tool_call", "custom_tool_call_output"].includes(responseType ?? "") ||
            (responseType === "message" && event.payload?.role === "assistant")) {
            // Current Codex builds record active reasoning and tool work as
            // response_item entries. Long-lived threads can push the original
            // task_started record beyond this bounded tail read.
            lifecycle = "working";
            if (Number.isFinite(eventTime)) activityAt = eventTime;
          }
        } catch { /* Ignore a truncated first or last JSONL record. */ }
        if (newline < 0) break;
        lineStart = newline + 1;
      }
      const contextUsedPercent = readContextUsedPercent(tail);
      if (lifecycle === "working") return {
        status: "working", ...(activityAt != null ? { activityAt } : {}),
        ...(contextUsedPercent != null ? { contextUsedPercent } : {})
      };
      if (lifecycle === "complete" && completionRevision != null) return {
        status: "complete", completionRevision, ...(activityAt != null ? { activityAt } : {}),
        ...(contextUsedPercent != null ? { contextUsedPercent } : {})
      };
      return { status: "idle", ...(contextUsedPercent != null ? { contextUsedPercent } : {}) };
    } finally {
      await handle.close();
    }
  } catch {
    return { status: "idle" };
  }
}

function reconcileOwnedStatus(nativeStatus: string, sessionStatus: HostSessionPresence["status"]): string {
  if (["approval", "awaiting-approval", "awaiting-response", "error"].includes(nativeStatus)) return nativeStatus;
  if (sessionStatus === "working") return "working";
  if (sessionStatus === "complete") return ["unread", "complete", "completed", "done"].includes(nativeStatus)
    ? nativeStatus
    : "complete";
  return "idle";
}

function readContextUsedPercent(tail: string): number | null {
  let offset = tail.lastIndexOf('"type":"token_count"');
  while (offset >= 0) {
    const start = tail.lastIndexOf("\n", offset) + 1;
    const nextLine = tail.indexOf("\n", offset);
    const end = nextLine < 0 ? tail.length : nextLine;
    try {
      const event = JSON.parse(tail.slice(start, end)) as {
        type?: string;
        payload?: {
          type?: string;
          info?: { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown };
        };
      };
      const total = event.payload?.info?.last_token_usage?.total_tokens;
      const window = event.payload?.info?.model_context_window;
      if (event.type === "event_msg" && event.payload?.type === "token_count" &&
        typeof total === "number" && Number.isFinite(total) && total >= 0 &&
        typeof window === "number" && Number.isFinite(window) && window > 0) {
        return Math.max(0, Math.min(100, Math.round(total / window * 100)));
      }
    } catch { /* Ignore a truncated first or last JSONL record. */ }
    offset = tail.lastIndexOf('"type":"token_count"', start - 1);
  }
  return null;
}
