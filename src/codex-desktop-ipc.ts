import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { MicroSnapshot } from "./types.js";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_FRAME = 32 * 1024 * 1024;
const ROOT = process.env.CODEX_HOME ?? join(homedir(), ".codex");
type Thread = { id: string; title: string; activityAt: number };
type Live = { title: string; status: string; revision: number; owner: string; state: Record<string, any> };
type Options = { socketPath: string; readThreads: () => Promise<Thread[]>; verifyApp: () => Promise<void> };

export function encodeIpcFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME) throw new Error("Codex IPC frame too large");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length); body.copy(frame, 4);
  return frame;
}

export class IpcFrameReader {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body?: Buffer;
  private bodyBytes = 0;
  push(chunk: Buffer): unknown[] {
    const messages: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count; offset += count;
        if (this.headerBytes < 4) break;
        const size = this.header.readUInt32LE(0);
        if (size === 0 || size > MAX_FRAME) throw new Error("Codex IPC frame too large or empty");
        this.body = Buffer.allocUnsafe(size); this.bodyBytes = 0; this.headerBytes = 0;
      }
      const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + count);
      this.bodyBytes += count; offset += count;
      if (this.bodyBytes === this.body.length) {
        messages.push(JSON.parse(this.body.toString("utf8")));
        this.body = undefined; this.bodyBytes = 0;
      }
    }
    return messages;
  }
}

export function projectIpcStatus(state: Record<string, any>): string {
  if (Array.isArray(state.requests) && state.requests.length) return "awaiting-response";
  const type = state.threadRuntimeStatus?.type;
  if (type === "active") {
    const flags = state.threadRuntimeStatus.activeFlags;
    if (Array.isArray(flags) && flags.some(flag => /approval|input/i.test(String(flag)))) return "awaiting-response";
    return "working";
  }
  if (type === "idle" || type === "notLoaded") return state.hasUnreadTurn ? "unread" : "idle";
  return "error";
}

async function readRecentThreads(): Promise<Thread[]> {
  // Read only the indexed catalog, never task messages, credentials, or database writes.
  const { stdout } = await exec("/usr/bin/sqlite3", ["-readonly", "-json", join(ROOT, "state_5.sqlite"),
    "SELECT id, substr(COALESCE(name,title),1,240) AS title, recency_at_ms AS activityAt FROM threads WHERE archived=0 AND preview<>'' AND agent_path IS NULL ORDER BY recency_at_ms DESC,id DESC LIMIT 6;"
  ], { timeout: 2000, maxBuffer: 32768 });
  const rows: unknown = JSON.parse(stdout || "[]");
  if (!Array.isArray(rows) || rows.length > 6 || rows.some(row => !row || !UUID.test(row.id) ||
    typeof row.title !== "string" || !Number.isFinite(row.activityAt))) throw new Error("Unsupported Codex task catalog");
  return rows;
}

async function verifyCodexApp(): Promise<void> {
  const { stdout } = await exec("/bin/ps", ["-axo", "comm="], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  if (!stdout.split("\n").some(line => /\/Codex\.app\/Contents\/MacOS\/ChatGPT$/.test(line.trim()))) {
    throw new Error("Codex is not running");
  }
}

/** Task status/navigation transport. Deliberately does not claim active composer authority. */
export class CodexDesktopIpcBridge {
  private socket?: net.Socket;
  private connecting?: Promise<void>;
  private clientId?: string;
  private live = new Map<string, Live>();
  private subscribed = new Set<string>();
  private requestedAt = new Map<string, number>();
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private options: Options;
  private blockedUntil = 0;

  constructor(private log: (message: string) => void, options: Partial<Options> = {}) {
    this.options = { socketPath: join(ROOT, "ipc", "ipc.sock"), readThreads: readRecentThreads,
      verifyApp: verifyCodexApp, ...options };
  }

  async refresh(): Promise<MicroSnapshot> {
    await this.options.verifyApp();
    const threads = await this.options.readThreads();
    if (threads.length > 6 || threads.some(t => !UUID.test(t.id))) throw new Error("Invalid Codex IPC task list");
    await this.connect();
    // Round-trip to the existing router: an open but wedged socket is not healthy.
    await this.initialize();
    const wanted = new Set(threads.map(t => t.id));
    for (const id of this.subscribed) if (!wanted.has(id)) {
      this.follow(id, false); this.subscribed.delete(id); this.live.delete(id); this.requestedAt.delete(id);
    }
    let requested = false;
    for (const id of wanted) {
      if (!this.subscribed.has(id) || (!this.live.has(id) && Date.now() - (this.requestedAt.get(id) ?? 0) > 5000)) {
        this.subscribed.add(id); this.follow(id, true); requested = true;
      }
    }
    // A second ordered round-trip lets promptly returned initial snapshots arrive without a fixed sleep.
    if (requested) await this.initialize();
    if (!this.socket || this.socket.destroyed) throw new Error("Codex IPC disconnected");
    return {
      transport: "desktop-ipc", agentSource: "recent", lightingAutoOff: "never", theme: "dark",
      layout: { version: 1, slots: {
        ACT06: { keycapId: "UNAVAILABLE" }, ACT07: { keycapId: "UNAVAILABLE" },
        ACT08: { keycapId: "UNAVAILABLE" }, ACT09: { keycapId: "UNAVAILABLE" },
        ACT10_ACT11: { keycapId: "UNAVAILABLE" }, ACT12: { keycapId: "UNAVAILABLE" }
      }, analogStick: { up: null, down: null, left: null, right: null } },
      slots: Array.from({ length: 6 }, (_, index) => {
        const thread = threads[index], live = thread && this.live.get(thread.id);
        return { id: index, threadKey: thread?.id ?? null, title: live?.title || thread?.title || null,
          status: thread ? live?.status ?? "error" : "off", selected: false, ownedByHost: true,
          activityAt: thread?.activityAt };
      })
    };
  }

  close(): void {
    const socket = this.socket; this.socket = undefined; this.clientId = undefined;
    this.live.clear(); this.subscribed.clear(); this.requestedAt.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex IPC disconnected")); }
    this.pending.clear(); socket?.destroy();
  }

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.blockedUntil) throw new Error("Codex IPC retry cooling down");
    this.connecting = this.connectOnce();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }

  private async connectOnce(): Promise<void> {
    const [parent, entry] = await Promise.all([lstat(dirname(this.options.socketPath)), lstat(this.options.socketPath)]);
    const uid = process.getuid?.();
    if (uid == null || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0 ||
      !entry.isSocket() || entry.uid !== uid) throw new Error("Unsafe Codex IPC socket ownership");
    const socket = net.createConnection(this.options.socketPath);
    this.socket = socket;
    const reader = new IpcFrameReader();
    socket.on("data", chunk => {
      if (this.socket !== socket) return;
      try { for (const message of reader.push(chunk)) this.onMessage(message); }
      catch { this.log("Codex IPC input is malformed or exceeds the supported frame limit."); this.blockedUntil = Date.now() + 30000; this.close(); }
    });
    socket.on("error", () => { if (this.socket === socket) this.close(); });
    socket.on("close", () => { if (this.socket === socket) this.close(); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error("Codex IPC connection timed out")); }, 2000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("close", () => { clearTimeout(timer); reject(new Error("Codex IPC connection closed")); });
    });
    this.log("Connected to Codex desktop IPC; task status and navigation available without debug flags.");
  }

  private initialize(): Promise<void> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Codex IPC did not respond")); this.close(); }, 2000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: "request", requestId, method: "initialize", version: 0, params: { clientType: "codex-deck" } }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  private send(message: unknown): void {
    if (!this.socket || this.socket.destroyed) throw new Error("Codex IPC disconnected");
    this.socket.write(encodeIpcFrame(message));
  }

  private follow(id: string, following: boolean): void {
    this.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: this.clientId, params: { conversationId: id, hostId: "local", following } });
    this.requestedAt.set(id, Date.now());
  }

  private onMessage(value: unknown): void {
    if (!value || typeof value !== "object") throw new Error("Invalid Codex IPC message");
    const m = value as Record<string, any>;
    if (m.type === "response") {
      const pending = this.pending.get(m.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(m.requestId);
      if (m.resultType !== "success" || typeof m.result?.clientId !== "string") pending.reject(new Error("Codex IPC initialization failed"));
      else { this.clientId = m.result.clientId; pending.resolve(); }
      return;
    }
    if (m.type === "client-discovery-request") {
      this.send({ type: "client-discovery-response", requestId: m.requestId, response: { canHandle: false } }); return;
    }
    if (m.type !== "broadcast") return;
    if (m.method === "ipc-connection-reset") { this.close(); return; }
    if (m.method === "client-status-changed" && m.params?.status === "disconnected") {
      for (const [id, live] of this.live) if (live.owner === m.params.clientId) this.live.delete(id);
      return;
    }
    const p = m.params, id = p?.conversationId;
    if (p?.hostId !== "local" || !this.subscribed.has(id)) return;
    if (m.method === "thread-read-state-changed") { this.live.delete(id); return; }
    if (m.method === "thread-stream-following-status-requested" && m.version === 1) { this.follow(id, true); return; }
    if (m.method !== "thread-stream-state-changed") return;
    const change = p.change;
    if (m.version !== 11 || !change || !Number.isSafeInteger(change.revision)) { this.live.delete(id); return; }
    if (change.type === "snapshot") {
      const state = change.conversationState;
      if (!state || typeof state !== "object" || typeof m.sourceClientId !== "string") { this.live.delete(id); return; }
      // Retain only the content-free projection. Full turns and messages are discarded.
      const projection = { threadRuntimeStatus: state.threadRuntimeStatus,
        requests: Array.isArray(state.requests) && state.requests.length ? [true] : [], hasUnreadTurn: state.hasUnreadTurn };
      this.live.set(id, { title: typeof state.title === "string" ? state.title.slice(0, 240) : "",
        status: projectIpcStatus(projection), state: projection, revision: change.revision, owner: m.sourceClientId });
      return;
    }
    const live = this.live.get(id);
    if (!live || change.type !== "patches" || live.owner !== m.sourceClientId || change.baseRevision !== live.revision ||
      change.revision <= live.revision || !Array.isArray(change.patches)) { this.live.delete(id); return; }
    for (const patch of change.patches) {
      if (!Array.isArray(patch.path) || patch.path.length === 0) { this.live.delete(id); return; }
      const field = patch.path[0];
      if (!["threadRuntimeStatus", "requests", "hasUnreadTurn", "title"].includes(field)) continue;
      // Nested mutations need a fresh snapshot; do not reconstruct or retain message/request payloads.
      if (patch.path.length !== 1 || !["add", "replace"].includes(patch.op)) { this.live.delete(id); return; }
      if (field === "title") live.title = typeof patch.value === "string" ? patch.value.slice(0, 240) : "";
      else live.state[field] = field === "requests" ? (Array.isArray(patch.value) && patch.value.length ? [true] : []) : patch.value;
    }
    live.revision = change.revision; live.status = projectIpcStatus(live.state);
  }
}
