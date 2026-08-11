import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { codexDeckStateRoot } from "./codex-deck-paths.js";
import { isAllowedRelayHost } from "./relay-network.js";
import {
  RELAY_MODEL_PRESETS_CAPABILITY, RELAY_PROTOCOL_VERSION, RELAY_REASONING_FEEDBACK_CAPABILITY,
  RELAY_REASONING_POLICY_CAPABILITY,
  normalizeHostSnapshotAtReceipt, parseRelayServerMessage,
  type HostSnapshot, type RelayCommand, type RelayResultMessage
} from "./relay-protocol.js";
import type {
  CodexHost, HostHealth, ModelPresetExecution, ReasoningAdjustmentExecution, ReasoningAdjustmentResult
} from "./types.js";

export type RelayClientConfig = { enabled: boolean; url: string; token: string };

const CONFIG_PATH = join(codexDeckStateRoot(), "relay-client.json");
export const RELAY_SNAPSHOT_STALE_MS = 5_000;
export const RELAY_COMMAND_TIMEOUT_MS = 10_000;
export const RELAY_MAX_PENDING_COMMANDS = 128;

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
  private readyPlatform?: CodexHost["platform"];
  private identityViolationGeneration = 0;
  private snapshotGeneration = 0;
  private snapshotRevision = 0;
  private health: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private readonly pending = new Map<string, {
    commandKind: RelayCommand["kind"];
    legacyUnrestrictedReasoning: boolean;
    reasoningFeedbackOptIn: boolean;
    requestedModelPreset?: ModelPresetExecution;
    snapshotRevision: number;
    connectionGeneration: number;
    readyHostId: string;
    readyPlatform: CodexHost["platform"];
    resolve: (outcome: ReasoningAdjustmentResult | ReasoningAdjustmentExecution | ModelPresetExecution | undefined) => void;
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
    this.readyPlatform = undefined;
    this.snapshotRevision = 0;
    this.identityViolationGeneration = 0;
    this.health = { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
    this.rejectPending("Remote Codex relay disconnected.");
  }

  currentHost(): CodexHost | undefined { return this.host; }
  currentSnapshot(): HostSnapshot | undefined { return this.snapshot; }
  currentHealth(now = Date.now()): HostHealth {
    return resolveRelayHealth(this.health, this.snapshot != null, this.lastSnapshotReceivedAt, now);
  }
  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN &&
      this.identityViolationGeneration !== this.connectionGeneration &&
      this.readyGeneration === this.connectionGeneration &&
      this.readyHostId != null && this.readyPlatform != null &&
      this.host?.hostId === this.readyHostId && this.host.platform === this.readyPlatform;
  }
  supportsCapability(capability: string): boolean { return this.capabilities.has(capability); }
  supportsCurrentReadyCapability(capability: string): boolean {
    return this.socket?.readyState === WebSocket.OPEN &&
      this.identityViolationGeneration !== this.connectionGeneration &&
      this.readyGeneration === this.connectionGeneration &&
      this.readyHostId != null && this.readyPlatform != null &&
      this.host?.hostId === this.readyHostId && this.host.platform === this.readyPlatform &&
      this.capabilities.has(capability);
  }
  supportsCapabilityForSnapshot(
    capability: string,
    hostId: string,
    platform: CodexHost["platform"]
  ): boolean {
    return this.socket?.readyState === WebSocket.OPEN &&
      this.currentHealth().state === "ready" &&
      this.identityViolationGeneration !== this.connectionGeneration &&
      this.readyGeneration === this.connectionGeneration &&
      this.snapshotGeneration === this.connectionGeneration &&
      this.readyHostId === hostId && this.readyPlatform === platform &&
      this.host?.hostId === hostId && this.host.platform === platform &&
      this.snapshot?.host.hostId === hostId && this.snapshot.host.platform === platform &&
      this.capabilities.has(capability);
  }

  async send(
    command: RelayCommand
  ): Promise<ReasoningAdjustmentResult | ReasoningAdjustmentExecution | ModelPresetExecution | undefined> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN ||
        this.identityViolationGeneration === this.connectionGeneration ||
        this.readyGeneration !== this.connectionGeneration ||
        this.readyHostId == null || this.readyPlatform == null ||
        this.host?.hostId !== this.readyHostId || this.host.platform !== this.readyPlatform) {
      throw new Error("Remote Codex host is offline.");
    }
    if (this.pending.size >= RELAY_MAX_PENDING_COMMANDS) {
      throw new Error("Remote Codex relay has too many pending commands.");
    }
    const supportsReasoningPolicy = this.capabilities.has(RELAY_REASONING_POLICY_CAPABILITY);
    if (command.kind === "model-preset" &&
        !this.supportsCapabilityForSnapshot(
          RELAY_MODEL_PRESETS_CAPABILITY, this.readyHostId, this.readyPlatform
        )) {
      throw new Error("Remote Codex host does not support model preset controls.");
    }
    if (command.kind === "reasoning" && !command.includeUltra && !supportsReasoningPolicy) {
      throw new Error("Remote Codex host does not support reasoning policy controls.");
    }
    const legacyUnrestrictedReasoning = command.kind === "reasoning" &&
      command.includeUltra && !supportsReasoningPolicy;
    const reasoningFeedbackOptIn = command.kind === "reasoning" &&
      command.includeReasoningFeedback === true &&
      this.capabilities.has(RELAY_REASONING_FEEDBACK_CAPABILITY);
    const wireCommand: RelayCommand = command.kind === "reasoning" && !reasoningFeedbackOptIn
      ? {
          kind: "reasoning", direction: command.direction,
          includeUltra: command.includeUltra
        }
      : command;
    const requestId = randomUUID();
    return new Promise<ReasoningAdjustmentResult | ReasoningAdjustmentExecution | ModelPresetExecution | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Remote Codex command timed out."));
      }, RELAY_COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, {
        commandKind: command.kind, legacyUnrestrictedReasoning, reasoningFeedbackOptIn,
        requestedModelPreset: command.kind === "model-preset"
          ? { modelId: command.modelId, reasoningEffort: command.reasoningEffort }
          : undefined,
        snapshotRevision: this.snapshotRevision,
        connectionGeneration: this.connectionGeneration,
        readyHostId: this.readyHostId!,
        readyPlatform: this.readyPlatform!,
        resolve, reject, timer
      });
      try {
        socket.send(JSON.stringify({
          type: "command", protocol: RELAY_PROTOCOL_VERSION, requestId, command: wireCommand
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
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
    if (this.identityViolationGeneration === generation) return;
    if (message.type === "ready") {
      if (this.readyGeneration === generation &&
          (this.readyHostId !== message.host.hostId ||
            this.readyPlatform !== message.host.platform)) {
        this.invalidateIdentity(generation);
        return;
      }
      this.readyHostId = message.host.hostId;
      this.readyPlatform = message.host.platform;
      this.host = message.host;
      this.capabilities = new Set(message.capabilities ?? []);
      this.readyGeneration = generation;
      this.health = { state: "degraded", reason: "awaiting-snapshot", changedAt: Date.now() };
      this.log(`Remote Codex host connected: ${message.host.hostName} (${message.host.platform}).`);
    } else if (message.type === "snapshot") {
      if (this.readyGeneration !== generation) return;
      if (this.readyHostId !== message.host.hostId ||
          this.readyPlatform !== message.host.platform) {
        this.invalidateIdentity(generation);
        return;
      }
      const receivedAt = Date.now();
      this.host = message.host;
      this.snapshot = normalizeHostSnapshotAtReceipt(
        { host: message.host, snapshot: message.snapshot, observedAt: message.observedAt },
        receivedAt
      );
      this.lastSnapshotReceivedAt = receivedAt;
      this.snapshotGeneration = generation;
      this.snapshotRevision += 1;
      this.health = { state: "ready", changedAt: receivedAt };
      this.onSnapshot(this.snapshot);
    } else if (message.type === "health") {
      if (this.readyGeneration !== generation) return;
      if (this.readyHostId !== message.host.hostId ||
          this.readyPlatform !== message.host.platform) {
        this.invalidateIdentity(generation);
        return;
      }
      this.host = message.host;
      this.health = { state: "degraded", reason: message.reason, changedAt: Date.now() };
    } else this.handleResult(message);
  }

  private handleResult(message: RelayResultMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (!message.ok) {
      pending.reject(new Error(message.error || "Remote Codex command failed."));
      return;
    }
    if ("modelId" in message) {
      const requested = pending.requestedModelPreset;
      if (pending.commandKind !== "model-preset" || !requested ||
          message.modelId !== requested.modelId ||
          message.reasoningEffort !== requested.reasoningEffort) {
        pending.reject(new Error("Remote Codex returned unexpected model preset feedback."));
        return;
      }
      if (pending.connectionGeneration !== this.connectionGeneration ||
          pending.connectionGeneration !== this.readyGeneration ||
          pending.readyHostId !== this.readyHostId ||
          pending.readyPlatform !== this.readyPlatform ||
          pending.readyHostId !== this.host?.hostId ||
          pending.readyPlatform !== this.host?.platform ||
          this.currentHealth().state !== "ready" ||
          !this.capabilities.has(RELAY_MODEL_PRESETS_CAPABILITY) ||
          this.snapshotGeneration !== this.connectionGeneration ||
          this.snapshotRevision <= pending.snapshotRevision ||
          this.snapshot?.host.hostId !== pending.readyHostId ||
          this.snapshot.host.platform !== pending.readyPlatform) {
        pending.reject(new Error("Remote Codex returned stale model preset feedback."));
        return;
      }
      const current = this.snapshot;
      if (current.snapshot.activeModelId !== message.modelId ||
          current.snapshot.reasoningEffort !== message.reasoningEffort) {
        pending.reject(new Error(
          "Remote Codex model preset result disagrees with the authoritative post-command snapshot."
        ));
        return;
      }
      const catalogEntry = current.snapshot.modelCatalog?.find((entry) =>
        entry.modelId === message.modelId &&
        entry.supportedReasoningEfforts.includes(message.reasoningEffort));
      if (!catalogEntry) {
        pending.reject(new Error("Remote Codex model preset is absent from the authoritative catalog."));
        return;
      }
      this.snapshot = {
        ...current,
        snapshot: {
          ...current.snapshot,
          activeModelId: message.modelId,
          activeModelDisplayName: catalogEntry.displayName,
          reasoningEffort: message.reasoningEffort
        }
      };
      this.onSnapshot(this.snapshot);
      pending.resolve({ modelId: message.modelId, reasoningEffort: message.reasoningEffort });
      return;
    }
    if (pending.commandKind === "model-preset") {
      pending.reject(new Error("Remote Codex omitted requested model preset feedback."));
      return;
    }
    if (message.reasoningEffort !== undefined) {
      if (pending.commandKind !== "reasoning" || !pending.reasoningFeedbackOptIn) {
        pending.reject(new Error("Remote Codex returned unexpected reasoning feedback."));
        return;
      }
      if (pending.connectionGeneration !== this.connectionGeneration ||
          pending.connectionGeneration !== this.readyGeneration ||
          pending.readyHostId !== this.readyHostId ||
          pending.readyPlatform !== this.readyPlatform ||
          pending.readyHostId !== this.host?.hostId ||
          pending.readyPlatform !== this.host?.platform ||
          this.snapshotGeneration !== this.connectionGeneration ||
          this.snapshot?.host.hostId !== pending.readyHostId ||
          this.snapshot.host.platform !== pending.readyPlatform) {
        pending.reject(new Error("Remote Codex returned stale reasoning feedback."));
        return;
      }
    }
    if (pending.commandKind === "reasoning" &&
        message.outcome !== "applied" && message.outcome !== "blocked-ultra") {
      if (pending.legacyUnrestrictedReasoning && message.outcome === undefined) {
        pending.resolve("applied");
        return;
      }
      pending.reject(new Error("Remote Codex returned an invalid reasoning adjustment result."));
      return;
    }
    if (pending.reasoningFeedbackOptIn && message.reasoningEffort === undefined) {
      pending.reject(new Error("Remote Codex omitted requested reasoning feedback."));
      return;
    }
    if (message.reasoningEffort !== undefined) {
      const current = this.snapshot!;
      this.snapshot = {
        ...current,
        snapshot: { ...current.snapshot, reasoningEffort: message.reasoningEffort }
      };
      this.onSnapshot(this.snapshot);
      pending.resolve({
        outcome: message.outcome!, reasoningEffort: message.reasoningEffort
      });
      return;
    }
    pending.resolve(message.outcome);
  }

  private invalidateIdentity(generation: number): void {
    if (generation !== this.connectionGeneration ||
        this.identityViolationGeneration === generation) return;
    this.identityViolationGeneration = generation;
    this.capabilities.clear();
    this.health = { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
    this.rejectPending("Remote Codex relay identity changed.");
  }

  private disconnected(expected: WebSocket): void {
    if (this.socket !== expected) return;
    this.socket = undefined;
    this.capabilities.clear();
    this.readyGeneration = 0;
    this.readyHostId = undefined;
    this.readyPlatform = undefined;
    this.snapshotRevision = 0;
    this.identityViolationGeneration = 0;
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
