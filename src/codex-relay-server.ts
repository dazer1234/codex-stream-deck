import { timingSafeEqual, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import Bonjour from "bonjour-service";
import { isAllowedRelayHost, isPrivateLanHost, selectPrivateLanAddress } from "./relay-network.js";
import { WebSocketServer, WebSocket } from "ws";
import type { OfficialKeycapId } from "./keycaps.js";
import type { CodexMicroRendererBridge } from "./codex-micro-renderer-bridge.js";
import {
  RELAY_CAPABILITIES, RELAY_PROTOCOL_VERSION, parseRelayCommand,
  type RelayAuthMessage, type RelayCommand, type RelayCommandMessage, type RelayHealthMessage,
  type RelayResultMessage, type RelaySnapshotMessage
} from "./relay-protocol.js";
import { isSafeReasoningIdentifier, type CodexHost, type ReasoningAdjustmentExecution } from "./types.js";

export type RelayServerConfig = {
  enabled: boolean;
  listenHost: string;
  port: number;
  token: string;
  transport?: "local";
  tls?: {
    certificate: string;
    privateKey: string;
    fingerprintSha256: string;
  };
  discovery?: { enabled: boolean };
};

type RelayControl = Pick<CodexMicroRendererBridge,
  "refresh" | "sendAgent" | "sendAction" | "sendJoystick" | "sendEncoder" | "adjustReasoning" | "runKeycap" |
  "refreshUsage" | "consumeRateLimitReset">;

export class CodexRelayServer {
  private server?: WebSocketServer;
  private httpsServer?: HttpsServer;
  private bonjour?: Bonjour;
  private addressPoll?: NodeJS.Timeout;
  private effectiveListenHost = "";
  private poll?: NodeJS.Timeout;
  private snapshotInFlight?: Promise<RelaySnapshotMessage>;
  private readonly authenticated = new Set<WebSocket>();
  private lastSnapshotError = "";
  private lastSnapshotErrorAt = 0;
  private degraded = false;
  private hasPublishedSnapshot = false;
  private consecutiveSnapshotFailures = 0;

  constructor(
    private readonly config: RelayServerConfig,
    private host: CodexHost,
    private readonly control: RelayControl,
    private readonly log: (message: string) => void
  ) {
    validateRelayServerConfig(config);
  }

  updateHost(host: CodexHost): void {
    if (host.hostId !== this.host.hostId || host.platform !== this.host.platform) {
      throw new Error("Relay host identity cannot change while the server is running.");
    }
    this.host = host;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const host = await this.resolveListenHost();
    await this.startBound(host);
    // Authentication publishes an immediate first snapshot. Starting the
    // periodic poll at its normal cadence avoids racing a duplicate snapshot
    // into a newly connected client.
    this.scheduleSnapshot();
    if (this.config.transport === "local" && this.config.listenHost === "auto") {
      this.addressPoll = setInterval(() => { void this.refreshLocalAddress(); }, 5_000);
      this.addressPoll.unref();
    }
  }

  async close(): Promise<void> {
    if (this.poll) clearTimeout(this.poll);
    this.poll = undefined;
    if (this.addressPoll) clearInterval(this.addressPoll);
    this.addressPoll = undefined;
    await this.closeBound();
  }

  private async resolveListenHost(): Promise<string> {
    return this.config.transport === "local" && this.config.listenHost === "auto"
      ? await selectPrivateLanAddress()
      : this.config.listenHost;
  }

  private async refreshLocalAddress(): Promise<void> {
    try {
      const next = await this.resolveListenHost();
      if (next === this.effectiveListenHost) return;
      this.log(`Nearby address changed from ${this.effectiveListenHost} to ${next}; rebinding without restarting Codex.`);
      await this.closeBound();
      await this.startBound(next);
    } catch (error) {
      this.log(`Nearby address refresh failed: ${String(error)}`);
    }
  }

  private async startBound(host: string): Promise<void> {
    const websocketOptions = { maxPayload: 64 * 1024, perMessageDeflate: false } as const;
    let server: WebSocketServer;
    if (this.config.tls) {
      const httpsServer = createHttpsServer({
        cert: this.config.tls.certificate,
        key: this.config.tls.privateKey,
        minVersion: "TLSv1.2"
      });
      this.httpsServer = httpsServer;
      server = new WebSocketServer({ server: httpsServer, ...websocketOptions });
      await new Promise<void>((resolve, reject) => {
        httpsServer.once("error", reject);
        httpsServer.listen(this.config.port, host, resolve);
      });
    } else {
      server = new WebSocketServer({ host, port: this.config.port, ...websocketOptions });
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    this.server = server;
    this.effectiveListenHost = host;
    server.on("connection", (socket) => this.handleConnection(socket));
    server.on("error", (error) => this.log(`Relay server error: ${String(error)}`));
    this.startAdvertisement(host);
    this.log(`Relay listening on ${host}:${this.config.port}${this.config.tls ? " with pinned TLS" : ""}; CDP remains loopback-only.`);
  }

  private startAdvertisement(host: string): void {
    if (!this.config.discovery?.enabled || !this.config.tls) return;
    const bonjour = new Bonjour({}, (error: unknown) => this.log(`Bonjour error: ${String(error)}`));
    this.bonjour = bonjour;
    const service = bonjour.publish({
      name: `Codex Deck ${this.host.hostName}`,
      type: "codexdeck",
      protocol: "tcp",
      port: this.config.port,
      disableIPv6: true,
      txt: relayDiscoveryTxt(this.config, this.host, host)
    });
    service.on("up", () => this.log(`Nearby discovery advertised for ${this.host.hostName}.`));
    service.on("error", (error) => this.log(`Bonjour advertisement failed: ${String(error)}`));
  }

  private async closeBound(): Promise<void> {
    const bonjour = this.bonjour;
    this.bonjour = undefined;
    if (bonjour) await new Promise<void>((resolve) => bonjour.unpublishAll(() => {
      bonjour.destroy();
      resolve();
    }));
    const server = this.server;
    this.server = undefined;
    for (const socket of server?.clients ?? []) socket.terminate();
    this.authenticated.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const httpsServer = this.httpsServer;
    this.httpsServer = undefined;
    if (httpsServer?.listening) await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    this.effectiveListenHost = "";
  }

  private handleConnection(socket: WebSocket): void {
    const authTimer = setTimeout(() => socket.close(4001, "authentication required"), 3_000);
    socket.once("message", (raw) => {
      clearTimeout(authTimer);
      const auth = safeJson(raw.toString()) as Partial<RelayAuthMessage> | null;
      if (!auth || auth.type !== "auth" || auth.protocol !== RELAY_PROTOCOL_VERSION || !secureEqual(auth.token, this.config.token)) {
        socket.close(4003, "authentication failed");
        return;
      }
      this.authenticated.add(socket);
      socket.send(JSON.stringify({
        type: "ready", protocol: RELAY_PROTOCOL_VERSION, host: this.host,
        capabilities: RELAY_CAPABILITIES, bridge: "native-codex-micro"
      }));
      socket.on("message", (message) => {
        void this.handleMessage(socket, message.toString()).catch((error) => this.reportSnapshotError(error));
      });
      socket.on("close", () => this.authenticated.delete(socket));
      socket.on("error", () => this.authenticated.delete(socket));
      void this.publishSnapshot(socket).catch((error) => this.handleSnapshotFailure(error, socket));
    });
    socket.on("close", () => clearTimeout(authTimer));
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    const message = safeJson(raw) as Partial<RelayCommandMessage> | null;
    if (!message || message.type !== "command" || message.protocol !== RELAY_PROTOCOL_VERSION || typeof message.requestId !== "string") return;
    const command = parseRelayCommand(message.command);
    if (!command) {
      this.sendResult(socket, message.requestId, false, "Invalid relay command.");
      return;
    }
    const startedAt = Date.now();
    const commandLabel = command.kind === "agent"
      ? `agent:${command.slot + 1}:${command.act === 1 ? "down" : "up"}`
      : command.kind;
    this.log(`Relay command ${commandLabel} received.`);
    try {
      const execution = validatedRelayExecution(command, await executeRelayCommand(this.control, command));
      if (command.kind === "usage-refresh") await this.publishSnapshot(undefined, true);
      if (command.kind === "reasoning" && command.includeReasoningFeedback === true) {
        await this.publishSnapshot(undefined, true);
      }
      this.sendResult(socket, message.requestId, true, undefined, execution);
      this.log(`Relay command ${commandLabel} completed in ${Date.now() - startedAt} ms.`);
      if (command.kind !== "usage-refresh" &&
          !(command.kind === "reasoning" && command.includeReasoningFeedback === true)) {
        await this.publishSnapshot();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Relay command ${commandLabel} failed in ${Date.now() - startedAt} ms: ${errorMessage}`);
      this.sendResult(socket, message.requestId, false, errorMessage);
    }
  }

  private sendResult(
    socket: WebSocket,
    requestId: string,
    ok: boolean,
    error?: string,
    execution?: ReasoningAdjustmentExecution
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const result: RelayResultMessage = ok
      ? {
          type: "result", protocol: RELAY_PROTOCOL_VERSION, requestId, ok: true,
          ...(execution === undefined ? {} : { outcome: execution.outcome }),
          ...(execution?.reasoningEffort === undefined ? {} : {
            reasoningEffort: execution.reasoningEffort
          })
        }
      : {
          type: "result", protocol: RELAY_PROTOCOL_VERSION, requestId, ok: false,
          ...(error ? { error } : {})
        };
    socket.send(JSON.stringify(result));
  }

  private scheduleSnapshot(delay = 1_200): void {
    if (!this.server) return;
    this.poll = setTimeout(async () => {
      try { if (this.authenticated.size) await this.publishSnapshot(); }
      catch (error) { this.handleSnapshotFailure(error); }
      finally { this.scheduleSnapshot(); }
    }, delay);
  }

  private reportSnapshotError(error: unknown): void {
    const message = String(error);
    const now = Date.now();
    if (message === this.lastSnapshotError && now - this.lastSnapshotErrorAt < 60_000) return;
    this.lastSnapshotError = message;
    this.lastSnapshotErrorAt = now;
    this.log(`Relay snapshot unavailable: ${message}`);
  }

  private handleSnapshotFailure(error: unknown, only?: WebSocket): void {
    this.reportSnapshotError(error);
    this.consecutiveSnapshotFailures += 1;
    if (!relaySnapshotFailureShouldDegrade(
      this.hasPublishedSnapshot, this.consecutiveSnapshotFailures
    )) return;
    const health: RelayHealthMessage = {
      type: "health",
      protocol: RELAY_PROTOCOL_VERSION,
      host: this.host,
      state: "degraded",
      reason: "native-signals-unavailable",
      observedAt: Date.now()
    };
    const encoded = JSON.stringify(health);
    const recipients = !this.degraded ? this.authenticated : only ? new Set([only]) : [];
    this.degraded = true;
    for (const socket of recipients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
  }

  private async publishSnapshot(only?: WebSocket, forceFresh = false): Promise<void> {
    const message = await this.currentSnapshotMessage(forceFresh);
    if (this.consecutiveSnapshotFailures > 0) {
      this.log(`Relay snapshot recovered after ${this.consecutiveSnapshotFailures} transient failure${this.consecutiveSnapshotFailures === 1 ? "" : "s"}.`);
    }
    this.consecutiveSnapshotFailures = 0;
    this.hasPublishedSnapshot = true;
    this.degraded = false;
    this.lastSnapshotError = "";
    this.lastSnapshotErrorAt = 0;
    const encoded = JSON.stringify(message);
    for (const socket of only ? [only] : this.authenticated) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
  }

  private async currentSnapshotMessage(forceFresh = false): Promise<RelaySnapshotMessage> {
    const previous = this.snapshotInFlight;
    if (previous && !forceFresh) return previous;
    const pending = (async (): Promise<RelaySnapshotMessage> => {
      if (previous) {
        try { await previous; } catch {}
      }
      const snapshot = await this.control.refresh();
      return {
        type: "snapshot",
        protocol: RELAY_PROTOCOL_VERSION,
        host: this.host,
        observedAt: Date.now(),
        snapshot
      };
    })();
    this.snapshotInFlight = pending;
    try { return await pending; }
    finally { if (this.snapshotInFlight === pending) this.snapshotInFlight = undefined; }
  }
}

export function relaySnapshotFailureShouldDegrade(
  hasPublishedSnapshot: boolean, consecutiveFailures: number
): boolean {
  return !hasPublishedSnapshot || consecutiveFailures >= 2;
}

export function validateRelayServerConfig(config: RelayServerConfig): void {
  if (!config.enabled) throw new Error("Relay server config is disabled.");
  const host = config.listenHost.trim();
  const localHost = config.transport === "local" && (host === "auto" || isPrivateLanHost(host));
  if (!host || (!isAllowedRelayHost(host) && !localHost)) {
    throw new Error("Relay listenHost must be loopback or a specific Tailscale address, unless secure auto local mode is enabled.");
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65_535) throw new Error("Relay port must be between 1024 and 65535.");
  if (typeof config.token !== "string" || Buffer.byteLength(config.token, "utf8") < 32) throw new Error("Relay token must contain at least 32 bytes.");
  if (config.transport === "local") {
    if (!config.tls?.certificate || !config.tls.privateKey || !config.discovery?.enabled) {
      throw new Error("Local relay mode requires pinned TLS and Bonjour discovery.");
    }
    const actual = normalizeFingerprint(new X509Certificate(config.tls.certificate).fingerprint256);
    if (actual !== normalizeFingerprint(config.tls.fingerprintSha256)) {
      throw new Error("Local relay certificate fingerprint does not match its certificate.");
    }
  }
}

export async function readRelayServerConfig(path: string): Promise<RelayServerConfig | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as RelayServerConfig;
    if (!value.enabled) return null;
    validateRelayServerConfig(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function relayDiscoveryTxt(
  config: RelayServerConfig, host: CodexHost, address: string
): Record<string, string> {
  if (config.transport !== "local" || !config.tls || !isPrivateLanHost(address)) {
    throw new Error("Discovery metadata is available only for a secure private local relay.");
  }
  return {
    protocol: String(RELAY_PROTOCOL_VERSION),
    hostId: host.hostId,
    hostName: host.hostName,
    platform: host.platform,
    address,
    port: String(config.port),
    secure: "1",
    fingerprint: normalizeFingerprint(config.tls.fingerprintSha256)
  };
}

async function executeRelayCommand(
  control: RelayControl,
  command: RelayCommand
): Promise<unknown> {
  if (command.kind === "agent") {
    await control.sendAgent(command.slot, command.act, command.threadKey);
    return undefined;
  }
  if (command.kind === "action") {
    await control.sendAction(command.slot, command.act);
    return undefined;
  }
  if (command.kind === "joystick") {
    await control.sendJoystick(command.direction, command.distance);
    return undefined;
  }
  if (command.kind === "encoder") {
    await control.sendEncoder(command.act);
    return undefined;
  }
  if (command.kind === "reasoning") {
    return control.adjustReasoning(command.direction, { includeUltra: command.includeUltra });
  }
  if (command.kind === "usage-refresh") {
    await control.refreshUsage();
    return undefined;
  }
  if (command.kind === "rate-limit-reset") {
    await control.consumeRateLimitReset();
    return undefined;
  }
  await control.runKeycap(command.keycapId as OfficialKeycapId);
  return undefined;
}

function validatedRelayExecution(
  command: RelayCommand,
  value: unknown
): ReasoningAdjustmentExecution | undefined {
  if (command.kind === "reasoning") {
    let outcome: unknown;
    let reasoningEffort: unknown;
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid reasoning adjustment result.");
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Invalid reasoning adjustment result.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const expectedKeys = ["outcome", ...(Object.prototype.hasOwnProperty.call(descriptors, "reasoningEffort")
        ? ["reasoningEffort"] : [])];
      if (keys.length !== expectedKeys.length || keys.some((key) =>
        typeof key !== "string" || !expectedKeys.includes(key))) {
        throw new Error("Invalid reasoning adjustment result.");
      }
      const outcomeProperty = descriptors.outcome;
      const effortProperty = descriptors.reasoningEffort;
      if (!outcomeProperty || outcomeProperty.enumerable !== true || !("value" in outcomeProperty) ||
          (effortProperty && (effortProperty.enumerable !== true || !("value" in effortProperty)))) {
        throw new Error("Invalid reasoning adjustment result.");
      }
      outcome = outcomeProperty.value;
      reasoningEffort = effortProperty?.value;
    } catch {
      throw new Error("Invalid reasoning adjustment result.");
    }
    if (outcome === "applied" || outcome === "blocked-ultra") {
      if (command.includeReasoningFeedback === true && reasoningEffort === undefined) {
        throw new Error("Invalid reasoning adjustment result.");
      }
      if (reasoningEffort !== undefined && !isSafeReasoningIdentifier(reasoningEffort)) {
        throw new Error("Invalid reasoning adjustment result.");
      }
      return {
        outcome,
        ...(command.includeReasoningFeedback === true && reasoningEffort !== undefined
          ? { reasoningEffort } : {})
      };
    }
  }
  if (command.kind !== "reasoning" && value === undefined) return undefined;
  throw new Error("Invalid reasoning adjustment result.");
}

function secureEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return null; }
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").trim().toLowerCase();
}
