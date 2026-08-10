import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { codexDeckStateRoot } from "./codex-deck-paths.js";
import { isAllowedRelayHost } from "./relay-network.js";
import {
  RELAY_PROTOCOL_VERSION, normalizeHostSnapshotAtReceipt, parseRelayServerMessage,
  type HostSnapshot, type RelayCommand, type RelayResultMessage
} from "./relay-protocol.js";
import type { CodexHost, HostHealth, ReasoningAdjustmentResult } from "./types.js";

export type RelayClientConfig = { enabled: boolean; url: string; token: string };

const CONFIG_PATH = join(codexDeckStateRoot(), "relay-client.json");
export const RELAY_SNAPSHOT_STALE_MS = 5_000;
export const RELAY_COMMAND_TIMEOUT_MS = 10_000;

export function resolveRelayHealth(health: HostHealth, hasSnapshot: boolean, lastSnapshotReceivedAt: number, now = Date.now()): HostHealth {
  if (health.state === "ready" && (!hasSnapshot || now - lastSnapshotReceivedAt > RELAY_SNAPSHOT_STALE_MS)) {
    return { state: "degraded", reason: "snapshot-stale", changedAt: lastSnapshotReceivedAt || health.changedAt };
  }
  return health;
}

export class CodexRelayClient {
  private socket?: WebSocket;
  private reconnect?: NodeJS.Timeout;
  private stopped = false;
  private connecting = false;
  private host?: CodexHost;
  private snapshot?: HostSnapshot;
  private lastSnapshotReceivedAt = 0;
  private capabilities = new Set<string>();
  private connectionGeneration = 0;
  private readyGeneration = 0;
  private readyHostId?: string;
  private snapshotGeneration = 0;
  private health: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private readonly pending = new Map<string, {
    resolve: (outcome: ReasoningAdjustmentResult | undefined) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly config: RelayClientConfig,
    private readonly onSnapshot: (snapshot: HostSnapshot) => void,
    private readonly log: (message: string) => void
  ) { validateRelayClientConfig(config); }

  start(): void { this.stopped = false; void this.connect(); }

  close(): void {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.socket?.close(1000, "client stopping");
    this.socket = undefined;
    this.capabilities.clear();
    this.readyGeneration = 0;
    this.readyHostId = undefined;
    this.health = { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
    this.rejectPending("Remote Codex relay disconnected.");
  }

  currentHost(): CodexHost | undefined { return this.host; }
  currentSnapshot(): HostSnapshot | undefined { return this.snapshot; }
  currentHealth(now = Date.now()): HostHealth {
    return resolveRelayHealth(this.health, this.snapshot != null, this.lastSnapshotReceivedAt, now);
  }
  isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN && this.host != null; }
  supportsCapability(capability: string): boolean { return this.capabilities.has(capability); }
  supportsCapabilityForSnapshot(capability: string, hostId: string): boolean {
    return this.socket?.readyState === WebSocket.OPEN &&
      this.currentHealth().state === "ready" &&
      this.readyGeneration === this.connectionGeneration &&
      this.snapshotGeneration === this.connectionGeneration &&
      this.readyHostId === hostId &&
      this.host?.hostId === hostId &&
      this.snapshot?.host.hostId === hostId &&
      this.capabilities.has(capability);
  }

  async send(command: RelayCommand): Promise<ReasoningAdjustmentResult | undefined> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN ||
        this.readyGeneration !== this.connectionGeneration || this.readyHostId == null ||
        this.host?.hostId !== this.readyHostId) {
      throw new Error("Remote Codex host is offline.");
    }
    const requestId = randomUUID();
    return new Promise<ReasoningAdjustmentResult | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Remote Codex command timed out."));
      }, RELAY_COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "command", protocol: RELAY_PROTOCOL_VERSION, requestId, command }));
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = true;
    this.health = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
    try {
      const generation = ++this.connectionGeneration;
      const socket = new WebSocket(this.config.url, { handshakeTimeout: 4_000, maxPayload: 64 * 1024, perMessageDeflate: false });
      this.socket = socket;
      socket.on("open", () => socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: this.config.token })));
      socket.on("message", (raw) => this.handleMessage(raw.toString(), generation));
      socket.on("close", () => this.disconnected(socket));
      socket.on("error", () => this.disconnected(socket));
    } catch (error) {
      this.health = { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
      this.log(`Remote relay connection failed: ${String(error)}`);
      this.scheduleReconnect();
    } finally { this.connecting = false; }
  }

  private handleMessage(raw: string, generation: number): void {
    if (generation !== this.connectionGeneration) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return; }
    const message = parseRelayServerMessage(parsed);
    if (!message) return;
    if (message.type === "ready") {
      if (this.readyGeneration === generation && this.readyHostId !== message.host.hostId) return;
      this.readyHostId = message.host.hostId;
      this.host = message.host;
      this.capabilities = new Set(message.capabilities ?? []);
      this.readyGeneration = generation;
      this.health = { state: "degraded", reason: "awaiting-snapshot", changedAt: Date.now() };
      this.log(`Remote Codex host connected: ${message.host.hostName} (${message.host.platform}).`);
    } else if (message.type === "snapshot") {
      if (this.readyGeneration !== generation || this.readyHostId !== message.host.hostId) return;
      const receivedAt = Date.now();
      this.host = message.host;
      this.snapshot = normalizeHostSnapshotAtReceipt(
        { host: message.host, snapshot: message.snapshot, observedAt: message.observedAt },
        receivedAt
      );
      this.lastSnapshotReceivedAt = receivedAt;
      this.snapshotGeneration = generation;
      this.health = { state: "ready", changedAt: receivedAt };
      this.onSnapshot(this.snapshot);
    } else if (message.type === "health") {
      if (this.readyGeneration !== generation || this.readyHostId !== message.host.hostId) return;
      this.host = message.host;
      this.health = { state: "degraded", reason: message.reason, changedAt: Date.now() };
    } else this.handleResult(message);
  }

  private handleResult(message: RelayResultMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.outcome);
    else pending.reject(new Error(message.error || "Remote Codex command failed."));
  }

  private disconnected(expected: WebSocket): void {
    if (this.socket !== expected) return;
    this.socket = undefined;
    this.capabilities.clear();
    this.readyGeneration = 0;
    this.readyHostId = undefined;
    this.health = { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
    this.rejectPending("Remote Codex relay disconnected.");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.connect();
    }, 2_000);
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

export async function readRelayClientConfig(path = CONFIG_PATH): Promise<RelayClientConfig | null> {
  try {
    const config = JSON.parse(await readFile(path, "utf8")) as RelayClientConfig;
    if (!config.enabled) return null;
    validateRelayClientConfig(config);
    return config;
  } catch { return null; }
}

export function validateRelayClientConfig(config: RelayClientConfig): void {
  if (!config.enabled) throw new Error("Relay client config is disabled.");
  let url: URL;
  try { url = new URL(config.url); }
  catch { throw new Error("Relay URL is invalid."); }
  if (url.protocol !== "ws:") throw new Error("Relay URL must use ws:// inside the encrypted SSH or Tailscale transport.");
  if (!isAllowedRelayHost(url.hostname)) throw new Error("Relay URL must target loopback or a Tailscale address.");
  if (typeof config.token !== "string" || Buffer.byteLength(config.token, "utf8") < 32) throw new Error("Relay token must contain at least 32 bytes.");
}
