import streamDeck, { type DialAction, type KeyAction } from "@elgato/streamdeck";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexDeckStateRoot } from "./codex-deck-paths.js";
import {
  isRemoteControlRequest, readControlTarget, resolveStartupControlTarget, writeControlTarget,
  type HostPlatform as ControlTarget
} from "./control-target.js";
import { CodexRelayClient, readRelayClientConfig } from "./codex-relay-client.js";
import { CodexRelayServer, readRelayServerConfig } from "./codex-relay-server.js";
import { CodexMicroRendererBridge } from "./codex-micro-renderer-bridge.js";
import { getOrCreateHostIdentity } from "./host-identity.js";
import { ADDITIONAL_KEYCAPS, type OfficialKeycapId } from "./keycaps.js";
import {
  DialCommandQueue,
  bindingLifecycle,
  deriveDialFeedback,
  dialBindingLabel,
  initialDialRuntimeState,
  isDialBindingId,
  normalizeDialSettings,
  reconcileSelector,
  reduceDialRotation,
  selectedItem,
  selectorItems
} from "./dial-domain.js";
import type {
  CodexDialSettings,
  DialBindingId,
  DialRuntimeState,
  DialRuntimeView,
  DialSelectorItem
} from "./dial-types.js";
import { HostActivityIndex, type HostSnapshot, type RelayCommand } from "./relay-protocol.js";
import {
  renderAgentKey, renderBuiltinKeycap, renderFallbackKeycap, renderHostTargetKey, renderImportedKeycap,
  renderRateLimitResetKey, renderUsageLimitKey, renderUsageOverviewKey, type BuiltinIconName
} from "./render.js";
import { openCodexThread } from "./codex-open.js";
import { visualStatusFromMicro } from "./status.js";
import type {
  CodexHost, HostHealth, MicroActionSlot, MicroDirection, MicroSnapshot, ReasoningAdjustment,
  RoutedAgentSlot, UsageLimitMode, UsageWindowKind
} from "./types.js";
import { selectAccountUsageSource, selectUsageWindow, type AccountUsageSource } from "./usage.js";

export type FixedIconSource =
  | { kind: "local"; keycapId: string }
  | { kind: "builtin"; name: BuiltinIconName };

type FixedIconRegistration = { action: KeyAction; source: FixedIconSource };
type AgentRegistration = { action: KeyAction; slot: number };
type MicroActionRegistration = { action: KeyAction; slot: MicroActionSlot };
type UsageLimitRegistration = { action: KeyAction; mode: UsageLimitMode };
type ActionIdentity = { id: string };
type ContextRingSettings = { showContextRings?: boolean };
type CodexDialAction = DialAction<CodexDialSettings>;
type DialRegistration = {
  action: CodexDialAction;
  settings: CodexDialSettings;
  state: DialRuntimeState;
  queue: DialCommandQueue;
  pressed?: { binding: DialBindingId; item?: DialSelectorItem };
  lastFeedback?: string;
  renderAgain?: boolean;
  rendering?: Promise<void>;
};

const USER_ICON_ROOT = join(codexDeckStateRoot(), "icons");
const LOCAL_MOBILE_CONFIG = "mobile-local-relay-server.json";
const RESET_HOLD_MS = 1_200;

export class DeckController {
  private readonly microBridge = new CodexMicroRendererBridge((message) => streamDeck.logger.info(message));
  private readonly agents = new Map<string, AgentRegistration>();
  private readonly microActions = new Map<string, MicroActionRegistration>();
  private readonly fixedActions = new Map<string, FixedIconRegistration>();
  private readonly keycapImages = new Map<string, Promise<string | null>>();
  private readonly lastImages = new Map<string, string>();
  private readonly hostToggleActions = new Map<string, KeyAction>();
  private readonly usageLimitActions = new Map<string, UsageLimitRegistration>();
  private readonly usageOverviewActions = new Map<string, KeyAction>();
  private readonly rateLimitResetActions = new Map<string, KeyAction>();
  private readonly dials = new Map<string, DialRegistration>();
  private readonly resetHolds = new Map<string, number>();
  private readonly dialDescriptionErrors = new Set<string>();
  private readonly dialRenderErrors = new Set<string>();
  private readonly activityIndex = new HostActivityIndex();
  private readonly pressedAgents = new Map<number, RoutedAgentSlot>();
  private readonly pressedControlTargets = new Map<string, string>();
  private relayClient?: CodexRelayClient;
  private mobileRelayServer?: CodexRelayServer;
  private localMobileRelayServer?: CodexRelayServer;
  private localHost?: CodexHost;
  private localSnapshot?: HostSnapshot;
  private routedSlots: RoutedAgentSlot[] = [];
  private targetHostId?: string;
  private targetPlatform: ControlTarget = "win32";
  private localHealth: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private poll?: NodeJS.Timeout;
  private animation?: NodeJS.Timeout;
  private refreshInFlight?: Promise<void>;
  private localSnapshotGeneration = 0;
  private stopped = false;
  private animationFrame = 0;
  private lastError = "";
  private lastAssignmentSignature = "";
  private lastStatusSignature = "";
  private lastLayoutSignature = "";
  private lastAgentSourceSignature = "";
  private lastHostHealthSignature = "";
  private showContextRings = true;

  async start(): Promise<void> {
    this.stopped = false;
    try {
      const settings = await streamDeck.settings.getGlobalSettings<ContextRingSettings>();
      this.showContextRings = settings.showContextRings !== false;
    } catch (error) {
      streamDeck.logger.warn(`Context-ring settings were unavailable; using enabled by default: ${String(error)}`);
    }
    this.localHost = await getOrCreateHostIdentity();
    const persistedTarget = await readControlTarget(undefined, this.localHost.platform);
    const relayConfig = await readRelayClientConfig();
    this.targetPlatform = resolveStartupControlTarget(
      persistedTarget, this.localHost.platform, relayConfig != null);
    if (this.targetPlatform !== persistedTarget) await writeControlTarget(this.targetPlatform);
    if (this.targetPlatform === this.localHost.platform) this.targetHostId = this.localHost.hostId;
    if (relayConfig) {
      this.relayClient = new CodexRelayClient(
        relayConfig,
        () => { void this.refreshDisplay(); },
        (message) => streamDeck.logger.info(message)
      );
      this.relayClient.start();
    }
    try {
      const [mobileRelayConfig, localMobileRelayConfig] = await Promise.all([
        readRelayServerConfig(join(codexDeckStateRoot(), "mobile-relay-server.json")),
        readRelayServerConfig(join(codexDeckStateRoot(), LOCAL_MOBILE_CONFIG))
      ]);
      if (mobileRelayConfig || localMobileRelayConfig) {
        let mobileSnapshotDirty = false;
        const runAndInvalidate = async (operation: () => Promise<void>): Promise<void> => {
          await operation();
          // The relay server publishes a fresh snapshot after the command.
          mobileSnapshotDirty = true;
        };
        const mobileControl = {
          refresh: async () => {
            if (!mobileSnapshotDirty && this.localHealth.state === "ready" && this.localSnapshot && Date.now() - this.localSnapshot.observedAt < 1_800) {
              return this.localSnapshot.snapshot;
            }
            await this.refresh();
            if (this.localHealth.state !== "ready" || !this.localSnapshot) {
              throw new Error("Codex Micro snapshot is temporarily unavailable.");
            }
            mobileSnapshotDirty = false;
            return this.localSnapshot.snapshot;
          },
          sendAgent: (slot: number, act: 0 | 1, threadKey?: string) => runAndInvalidate(
            () => this.microBridge.sendAgent(slot, act, threadKey)),
          sendAction: (slot: MicroActionSlot, act: 0 | 1) => runAndInvalidate(
            () => this.microBridge.sendAction(slot, act)),
          sendJoystick: (direction: MicroDirection, distance: 0 | 1) => runAndInvalidate(
            () => this.microBridge.sendJoystick(direction, distance)),
          sendEncoder: (act: 0 | 1) => runAndInvalidate(() => this.microBridge.sendEncoder(act)),
          adjustReasoning: (direction: ReasoningAdjustment) => runAndInvalidate(
            () => this.microBridge.adjustReasoning(direction)),
          runKeycap: (keycapId: OfficialKeycapId) => runAndInvalidate(
            () => this.microBridge.runKeycap(keycapId)),
          refreshUsage: async () => {
            await this.refreshLocalUsage();
            mobileSnapshotDirty = false;
          },
          consumeRateLimitReset: () => runAndInvalidate(() => this.microBridge.consumeRateLimitReset())
        };
        if (mobileRelayConfig) {
          this.mobileRelayServer = new CodexRelayServer(
            mobileRelayConfig, this.localHost, mobileControl,
            (message) => streamDeck.logger.info(`Mobile relay: ${message}`)
          );
          await this.mobileRelayServer.start();
        }
        if (localMobileRelayConfig) {
          this.localMobileRelayServer = new CodexRelayServer(
            localMobileRelayConfig, this.localHost, mobileControl,
            (message) => streamDeck.logger.info(`Nearby mobile relay: ${message}`)
          );
          await this.localMobileRelayServer.start();
        }
      }
    } catch (error) {
      this.mobileRelayServer = undefined;
      this.localMobileRelayServer = undefined;
      streamDeck.logger.error(`Optional mobile relay was not started: ${String(error)}`);
    }
    await this.refresh();
    this.scheduleRefresh();
    this.scheduleAnimation();
  }

  stop(): void {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.animation) clearInterval(this.animation);
    this.relayClient?.close();
    void this.mobileRelayServer?.close();
    void this.localMobileRelayServer?.close();
    this.microBridge.close();
  }

  registerAgent(slot: number, action: KeyAction): void {
    this.agents.set(action.id, { action, slot });
    void this.renderAgent({ action, slot });
  }

  unregisterAgent(action: ActionIdentity): void {
    this.unregister(action, this.agents);
  }

  setContextRingVisibility(visible: boolean): void {
    if (this.showContextRings === visible) return;
    this.showContextRings = visible;
    void Promise.all([...this.agents.values()].map((registration) => this.renderAgent(registration)));
  }

  registerMicroAction(slot: MicroActionSlot, action: KeyAction): void {
    this.microActions.set(action.id, { action, slot });
    void this.renderMicroAction({ action, slot });
  }

  unregisterMicroAction(action: ActionIdentity): void {
    this.unregister(action, this.microActions);
  }

  registerFixedAction(id: string, action: KeyAction, source: FixedIconSource): void {
    this.fixedActions.set(action.id, { action, source });
    void this.renderFixedAction({ action, source });
  }

  unregisterFixedAction(action: ActionIdentity): void {
    this.unregister(action, this.fixedActions);
  }

  registerHostToggle(action: KeyAction): void {
    this.hostToggleActions.set(action.id, action);
    void this.renderHostToggle(action);
  }

  unregisterHostToggle(action: ActionIdentity): void {
    this.hostToggleActions.delete(action.id);
    this.lastImages.delete(action.id);
  }

  registerDial(action: CodexDialAction, input: unknown): void {
    const registration: DialRegistration = {
      action,
      settings: normalizeDialSettings(input),
      state: initialDialRuntimeState(),
      queue: new DialCommandQueue()
    };
    this.dials.set(action.id, registration);
    this.updateDialDescription(registration);
    void this.renderDialSafely(registration);
  }

  updateDialSettings(action: CodexDialAction, input: unknown): void {
    const settings = normalizeDialSettings(input);
    const existing = this.dials.get(action.id);
    const registration: DialRegistration = existing ?? {
      action,
      settings,
      state: initialDialRuntimeState(),
      queue: new DialCommandQueue()
    };
    registration.action = action;
    registration.settings = settings;
    this.dials.set(action.id, registration);
    this.updateDialDescription(registration);
    void this.renderDialSafely(registration);
  }

  unregisterDial(action: ActionIdentity): void {
    this.dials.delete(action.id);
    this.resetHolds.delete(action.id);
  }

  rotateDial(action: CodexDialAction, ticks: number): void {
    const registration = this.dials.get(action.id);
    if (!registration) return;
    registration.settings = normalizeDialSettings(registration.settings);
    const reduced = reduceDialRotation(
      registration.settings,
      registration.state,
      this.dialRuntimeView(registration.settings, registration.state),
      ticks
    );
    registration.state = reduced.state;
    if (registration.settings.rotation.kind === "selector") {
      void this.renderDialSafely(registration);
    }
    for (const binding of reduced.bindings) {
      this.enqueueDialCommand(registration, () => this.dispatchDialTap(registration, binding));
    }
  }

  beginDialPress(action: CodexDialAction): Promise<void> {
    const registration = this.dials.get(action.id);
    if (!registration) return Promise.resolve();
    if (registration.pressed) return registration.queue.idle();
    registration.settings = normalizeDialSettings(registration.settings);
    const pressed = this.resolveDialPress(registration);
    registration.pressed = pressed;
    this.enqueueDialCommand(
      registration,
      () => this.dispatchDialDown(registration, pressed.binding, pressed.item)
    );
    return registration.queue.idle();
  }

  finishDialPress(action: CodexDialAction): Promise<void> {
    const registration = this.dials.get(action.id);
    if (!registration) return Promise.resolve();
    const pressed = registration.pressed;
    registration.pressed = undefined;
    if (!pressed) return registration.queue.idle();
    this.enqueueDialCommand(
      registration,
      () => this.dispatchDialUp(registration, pressed.binding, pressed.item)
    );
    return registration.queue.idle();
  }

  touchDial(action: CodexDialAction): Promise<void> {
    const registration = this.dials.get(action.id);
    if (!registration) return Promise.resolve();
    registration.settings = normalizeDialSettings(registration.settings);
    const binding = registration.settings.touchTap;
    this.enqueueDialCommand(registration, () => this.dispatchDialTap(registration, binding));
    return registration.queue.idle();
  }

  registerUsageLimit(action: KeyAction, mode: UsageLimitMode): void {
    const registration = { action, mode };
    this.usageLimitActions.set(action.id, registration);
    this.renderUsageAction("Usage limit", action, () => this.renderUsageLimit(registration));
  }

  updateUsageLimitMode(action: KeyAction, mode: UsageLimitMode): void {
    const registration = { action, mode };
    this.usageLimitActions.set(action.id, registration);
    this.renderUsageAction("Usage limit", action, () => this.renderUsageLimit(registration));
  }

  unregisterUsageLimit(action: ActionIdentity): void {
    this.unregister(action, this.usageLimitActions);
  }

  registerUsageOverview(action: KeyAction): void {
    this.usageOverviewActions.set(action.id, action);
    this.renderUsageAction("Usage overview", action, () => this.renderUsageOverview(action));
  }

  unregisterUsageOverview(action: ActionIdentity): void {
    this.unregister(action, this.usageOverviewActions);
  }

  registerRateLimitReset(action: KeyAction): void {
    this.rateLimitResetActions.set(action.id, action);
    this.renderUsageAction("Rate-limit reset", action, () => this.renderRateLimitReset(action));
  }

  unregisterRateLimitReset(action: ActionIdentity): void {
    this.resetHolds.delete(action.id);
    this.unregister(action, this.rateLimitResetActions);
  }

  beginRateLimitReset(action: ActionIdentity): void {
    this.resetHolds.set(action.id, Date.now());
    const registered = this.rateLimitResetActions.get(action.id);
    if (registered) void this.renderRateLimitReset(registered);
  }

  async finishRateLimitReset(action: ActionIdentity): Promise<boolean> {
    const startedAt = this.resetHolds.get(action.id);
    this.resetHolds.delete(action.id);
    const registered = this.rateLimitResetActions.get(action.id);
    if (registered) await this.renderRateLimitReset(registered);
    if (startedAt == null || Date.now() - startedAt < RESET_HOLD_MS) return false;
    const source = this.accountUsageSource();
    const usage = source.snapshot?.usage;
    if ((usage?.resetCreditsAvailable ?? 0) <= 0) throw new Error("No rate-limit reset credit is available.");
    if (usage?.resetCreditsApplicable === 0) throw new Error("No rate-limit reset credit is currently applicable.");
    await this.sendToHost(source.hostId, { kind: "rate-limit-reset" }, () => this.microBridge.consumeRateLimitReset());
    await this.refresh();
    return true;
  }

  async toggleTargetHost(): Promise<void> {
    const remote = this.relayClient?.currentHost();
    if (!this.localHost) throw new Error("The local Codex host is not ready.");
    if (this.targetPlatform === this.localHost.platform) {
      if (!remote) throw new Error("No remote Codex host is connected.");
      this.targetPlatform = remote.platform;
      this.targetHostId = remote.hostId;
    } else {
      this.targetPlatform = this.localHost.platform;
      this.targetHostId = this.localHost.hostId;
    }
    await writeControlTarget(this.targetPlatform);
    await this.renderAll();
  }

  async sendAgent(slot: number, act: 0 | 1, expectedThreadKey?: string): Promise<void> {
    const assignment = act === 0 ? this.pressedAgents.get(slot) : this.routedSlots[slot];
    if (!assignment) throw new Error(`No Codex task is assigned to global agent slot ${slot + 1}.`);
    if (!assignment.threadKey) throw new Error("The selected Codex task has no stable thread identity.");
    if (expectedThreadKey != null && assignment.threadKey !== expectedThreadKey) {
      throw new Error("The selected Codex task no longer matches the highlighted task.");
    }
    if (act === 1) this.pressedAgents.set(slot, assignment);
    else this.pressedAgents.delete(slot);
    if (assignment.host.hostId === this.localHost?.hostId) {
      await this.microBridge.sendAgent(assignment.sourceSlot, act, assignment.threadKey);
    } else await this.sendRemote({ kind: "agent", slot: assignment.sourceSlot, threadKey: assignment.threadKey, act });
    if (act === 0) void this.refresh();
  }

  async sendMicroAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
    const target = this.pressTarget(`action:${slot}`, act);
    await this.sendToHost(target, { kind: "action", slot, act }, () => this.microBridge.sendAction(slot, act));
  }

  async sendJoystick(direction: MicroDirection, distance: 0 | 1): Promise<void> {
    const target = this.pressTarget(`joystick:${direction}`, distance);
    await this.sendToHost(target, { kind: "joystick", direction, distance }, () => this.microBridge.sendJoystick(direction, distance));
  }

  async sendEncoder(act: 0 | 1): Promise<void> {
    const target = this.pressTarget("encoder", act);
    await this.sendToHost(target, { kind: "encoder", act }, () => this.microBridge.sendEncoder(act));
  }

  async adjustReasoning(direction: ReasoningAdjustment): Promise<void> {
    await this.sendToTarget({ kind: "reasoning", direction }, () => this.microBridge.adjustReasoning(direction));
  }

  async runKeycap(keycapId: OfficialKeycapId): Promise<void> {
    await this.sendToTarget({ kind: "keycap", keycapId }, () => this.microBridge.runKeycap(keycapId));
  }

  async createTask(): Promise<void> {
    if (this.isRemoteTarget()) await this.sendRemote({ kind: "keycap", keycapId: "NEW" });
    else await openCodexThread("new");
  }

  async refreshUsage(): Promise<void> {
    const source = this.accountUsageSource();
    if (source.hostId != null && source.hostId !== this.localHost?.hostId) {
      if (!this.relayClient?.supportsCapabilityForSnapshot("usage-refresh", source.hostId)) {
        throw new Error("Remote Codex host does not support usage refresh.");
      }
      await this.relayClient.send({ kind: "usage-refresh" });
      return;
    }

    await this.refreshLocalUsage();
  }

  private async refreshLocalUsage(): Promise<MicroSnapshot> {
    const generation = ++this.localSnapshotGeneration;
    let snapshot: MicroSnapshot;
    try {
      const host = this.localHost ?? await getOrCreateHostIdentity();
      snapshot = await this.microBridge.requestUsageRefresh();
      if (generation !== this.localSnapshotGeneration) {
        throw new Error("Codex usage refresh was superseded by a newer refresh.");
      }
      const observedAt = Date.now();
      this.localHost = host;
      this.mobileRelayServer?.updateHost(host);
      this.localMobileRelayServer?.updateHost(host);
      this.localSnapshot = { host, snapshot, observedAt };
      this.localHealth = { state: "ready", changedAt: observedAt };
      this.lastError = "";
    } catch (error) {
      if (generation !== this.localSnapshotGeneration) throw error;
      this.localHealth = { state: "degraded", reason: "local-bridge-unavailable", changedAt: Date.now() };
      const message = String(error);
      if (message !== this.lastError) {
        this.lastError = message;
        streamDeck.logger.warn(`Codex usage refresh unavailable: ${message}`);
      }
      await this.refreshDisplay();
      throw error;
    }
    await this.refreshDisplay();
    return snapshot;
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refreshOnce();
    this.refreshInFlight = pending;
    try { await pending; }
    finally { if (this.refreshInFlight === pending) this.refreshInFlight = undefined; }
  }

  private async refreshOnce(): Promise<void> {
    const generation = this.localSnapshotGeneration;
    try {
      const snapshot = await this.microBridge.refresh();
      if (generation !== this.localSnapshotGeneration) return;
      const host = await getOrCreateHostIdentity();
      if (generation !== this.localSnapshotGeneration) return;
      this.localHost = host;
      this.mobileRelayServer?.updateHost(host);
      this.localMobileRelayServer?.updateHost(host);
      this.localSnapshot = { host, snapshot, observedAt: Date.now() };
      this.localHealth = { state: "ready", changedAt: Date.now() };
      this.lastError = "";
    } catch (error) {
      if (generation !== this.localSnapshotGeneration) return;
      this.localHealth = { state: "degraded", reason: "local-bridge-unavailable", changedAt: Date.now() };
      const message = String(error);
      if (message !== this.lastError) {
        this.lastError = message;
        streamDeck.logger.warn(`Codex Micro bridge unavailable: ${message}`);
      }
    }
    await this.refreshDisplay();
  }

  private async refreshDisplay(): Promise<void> {
    const remoteSnapshot = this.relayClient?.currentSnapshot();
    if (this.localHost && this.targetPlatform !== this.localHost.platform && remoteSnapshot) this.targetHostId = remoteSnapshot.host.hostId;
    else if (this.localHost && this.targetPlatform === this.localHost.platform) this.targetHostId = this.localHost.hostId;
    const inputs = [this.localSnapshot, remoteSnapshot].filter((value): value is HostSnapshot => value != null);
    const remoteHealth: HostHealth = this.relayClient?.currentHealth() ?? {
      state: "offline",
      reason: "relay-disconnected",
      changedAt: Date.now()
    };
    const healthSignature = `local=${this.localHealth.state}:${this.localHealth.reason ?? ""},remote=${remoteHealth.state}:${remoteHealth.reason ?? ""}`;
    if (healthSignature !== this.lastHostHealthSignature) {
      this.lastHostHealthSignature = healthSignature;
      streamDeck.logger.info(`Codex host health: ${healthSignature}`);
    }
    const agentSources = inputs.map((input) => `${input.host.platform}=${input.snapshot.agentSource}`);
    const agentSourceSignature = agentSources.join(",");
    if (agentSourceSignature !== this.lastAgentSourceSignature) {
      this.lastAgentSourceSignature = agentSourceSignature;
      if (new Set(inputs.map((input) => input.snapshot.agentSource)).size > 1) {
        streamDeck.logger.warn(`Codex agent sources differ (${agentSources.join(" ")}). The Windows controller mode determines the combined list; Pinned and Individual assignments merge only hosts using that mode.`);
      }
    }
    this.routedSlots = this.activityIndex.merge(inputs, Date.now(), this.localHost?.hostId);

    const assignments = this.routedSlots.map((slot) => `${slot.id}=${slot.host.platform}:${slot.threadKey ?? "empty"}`).join(" ");
    if (assignments !== this.lastAssignmentSignature) {
      this.lastAssignmentSignature = assignments;
      streamDeck.logger.info(`Codex multi-host slots: ${assignments || "empty"}`);
    }

    const statuses = this.routedSlots.map((slot) => `${slot.host.hostId}:${slot.threadKey}:${slot.status}:${slot.selected}`).join(",");
    if (statuses !== this.lastStatusSignature) {
      this.lastStatusSignature = statuses;
      streamDeck.logger.info(`Codex multi-host states: ${this.routedSlots.map((slot) => `${slot.id + 1}=${slot.status}`).join(" ") || "empty"}`);
    }

    const target = this.targetSnapshot();
    const layout = JSON.stringify({ target: this.targetHostId, theme: target?.theme, slots: target?.layout.slots });
    if (layout !== this.lastLayoutSignature) {
      this.lastLayoutSignature = layout;
      this.keycapImages.clear();
      if (target) streamDeck.logger.info(`Codex Micro layout synchronized (${target.agentSource}, ${target.theme} theme).`);
    }
    await this.renderAll();
  }

  private async renderAll(): Promise<void> {
    await Promise.all([
      ...[...this.agents.values()].map((registration) => this.renderAgent(registration)),
      ...[...this.microActions.values()].map((registration) => this.renderMicroAction(registration)),
      ...[...this.fixedActions.values()].map((registration) => this.renderFixedAction(registration)),
      ...[...this.hostToggleActions.values()].map((action) => this.renderHostToggle(action)),
      ...[...this.usageLimitActions.values()].map((registration) => this.renderUsageLimit(registration)),
      ...[...this.usageOverviewActions.values()].map((action) => this.renderUsageOverview(action)),
      ...[...this.rateLimitResetActions.values()].map((action) => this.renderRateLimitReset(action)),
      ...[...this.dials.values()].map((registration) => this.renderDialSafely(registration))
    ]);
  }

  private dialRuntimeView(
    settings: CodexDialSettings,
    state: DialRuntimeState
  ): DialRuntimeView {
    const targetSnapshot = this.targetSnapshot();
    const usageSource = this.accountUsageSource();
    const usage = usageSource.snapshot?.usage;
    const selectedUsage = selectUsageWindow(usage, state.usageMode);
    const fiveHour = selectUsageWindow(usage, "five-hour");
    const weekly = selectUsageWindow(usage, "weekly");
    const feedbackUsesUsage = settings.feedback === "usage" ||
      (settings.feedback === "auto" && settings.rotation.kind === "selector" &&
        settings.rotation.source === "usage");
    const actionLabels: DialRuntimeView["actionLabels"] = {};
    for (const [slot, value] of Object.entries(targetSnapshot?.layout.slots ?? {})) {
      const keycapId = value.keycapId;
      const label = ADDITIONAL_KEYCAPS.find(({ id }) => id === keycapId)?.name ?? keycapId;
      const binding = `micro.${slot}`;
      if (isDialBindingId(binding, "selector")) actionLabels[binding] = label;
    }
    for (const keycap of ADDITIONAL_KEYCAPS) actionLabels[`keycap.${keycap.id}`] = keycap.name;
    return {
      health: (feedbackUsesUsage ? usageSource.health : this.targetHealth()).state,
      reasoningEffort: targetSnapshot?.reasoningEffort,
      agents: this.routedSlots
        .filter((slot): slot is RoutedAgentSlot & { threadKey: string } => slot.threadKey != null)
        .map((slot) => ({
          id: slot.id,
          identity: `${slot.host.hostId}:${slot.threadKey}`,
          threadKey: slot.threadKey,
          title: slot.title ?? `Agent ${slot.id + 1}`,
          status: slot.status,
          ...(slot.contextUsedPercent == null ? {} : { contextUsedPercent: slot.contextUsedPercent })
        })),
      actionLabels,
      ...(usage == null ? {} : {
        usage: {
          mode: selectedUsage?.kind === "five-hour" || selectedUsage?.kind === "weekly"
            ? selectedUsage.kind
            : "auto",
          remainingPercent: selectedUsage?.remainingPercent,
          resetsAt: selectedUsage?.resetsAt,
          observedAt: usage.observedAt,
          fiveHourRemaining: fiveHour?.remainingPercent,
          weeklyRemaining: weekly?.remainingPercent
        }
      }),
      now: Date.now()
    };
  }

  private async renderDial(registration: DialRegistration): Promise<void> {
    registration.settings = normalizeDialSettings(registration.settings);
    const view = this.dialRuntimeView(registration.settings, registration.state);
    if (registration.settings.rotation.kind === "selector") {
      registration.state = reconcileSelector(
        registration.state,
        selectorItems(registration.settings, view)
      );
    }
    const feedback = deriveDialFeedback(registration.settings, registration.state, view);
    const signature = JSON.stringify(feedback);
    if (registration.lastFeedback === signature) return;
    await registration.action.setFeedback({
      title: feedback.title,
      value: feedback.value,
      detail: feedback.detail,
      indicator: feedback.indicator,
      accent: { value: 100, bar_fill_c: feedback.accent }
    });
    registration.lastFeedback = signature;
  }

  private async renderDialSafely(registration: DialRegistration): Promise<void> {
    if (registration.rendering) {
      registration.renderAgain = true;
      await registration.rendering;
      return;
    }
    const rendering = (async () => {
      do {
        registration.renderAgain = false;
        try {
          await this.renderDial(registration);
        } catch (error) {
          const message = String(error);
          if (!this.dialRenderErrors.has(message)) {
            this.dialRenderErrors.add(message);
            streamDeck.logger.error(`Codex dial feedback unavailable: ${message}`);
          }
        }
      } while (registration.renderAgain);
    })();
    registration.rendering = rendering;
    try { await rendering; }
    finally {
      if (registration.rendering === rendering) registration.rendering = undefined;
    }
  }

  private updateDialDescription(registration: DialRegistration): void {
    const { settings, action } = registration;
    const rotate = settings.rotation.kind === "paired" ? "Adjust" : "Select";
    const push = dialBindingLabel(settings.press);
    const touch = dialBindingLabel(settings.touchTap);
    void action.setTriggerDescription({ rotate, push, touch }).catch((error) => {
      const message = String(error);
      if (this.dialDescriptionErrors.has(message)) return;
      this.dialDescriptionErrors.add(message);
      streamDeck.logger.warn(`Codex dial trigger descriptions unavailable: ${message}`);
    });
  }

  private resolveDialPress(
    registration: DialRegistration
  ): { binding: DialBindingId; item?: DialSelectorItem } {
    const binding = registration.settings.press;
    if (binding !== "selector.activate") return { binding };
    const item = selectedItem(
      registration.settings,
      registration.state,
      this.dialRuntimeView(registration.settings, registration.state)
    );
    return item ? { binding, item } : { binding };
  }

  private enqueueDialCommand(
    registration: DialRegistration,
    operation: () => Promise<void>
  ): void {
    registration.queue.enqueue(async () => {
      try {
        await operation();
      } catch (error) {
        streamDeck.logger.error(`Codex dial command failed (${registration.action.id}): ${String(error)}`);
        try { await registration.action.showAlert(); }
        catch (alertError) {
          streamDeck.logger.error(`Codex dial alert failed (${registration.action.id}): ${String(alertError)}`);
        }
      }
    });
  }

  private async dispatchDialTap(
    registration: DialRegistration,
    binding: DialBindingId,
    item?: DialSelectorItem
  ): Promise<void> {
    const lifecycle = bindingLifecycle(binding);
    if (lifecycle === "momentary" || binding === "selector.activate") {
      await this.dispatchDialBinding(registration, binding, 1, item);
      await this.dispatchDialBinding(registration, binding, 0, item);
      return;
    }
    if (lifecycle === "hold") throw new Error("Rate-limit reset requires a dial press and hold.");
    await this.dispatchDialBinding(registration, binding, 1, item);
  }

  private async dispatchDialDown(
    registration: DialRegistration,
    binding: DialBindingId,
    item?: DialSelectorItem
  ): Promise<void> {
    if (bindingLifecycle(binding) === "hold") {
      this.beginRateLimitReset(registration.action);
      return;
    }
    await this.dispatchDialBinding(registration, binding, 1, item);
  }

  private async dispatchDialUp(
    registration: DialRegistration,
    binding: DialBindingId,
    item?: DialSelectorItem
  ): Promise<void> {
    if (bindingLifecycle(binding) === "hold") {
      const reset = await this.finishRateLimitReset(registration.action);
      if (reset) {
        const action = registration.action as CodexDialAction & {
          showOk?: () => Promise<void>;
        };
        await action.showOk?.();
      }
      return;
    }
    if (bindingLifecycle(binding) === "momentary" || binding === "selector.activate") {
      await this.dispatchDialBinding(registration, binding, 0, item);
    }
  }

  private async dispatchDialBinding(
    registration: DialRegistration,
    binding: DialBindingId,
    act: 0 | 1,
    item?: DialSelectorItem
  ): Promise<void> {
    if (!isDialBindingId(binding, "press")) throw new Error("Unsupported Codex dial binding.");
    if (binding === "none") return;
    if (binding === "selector.activate") {
      if (item?.agentSlot != null && item.threadKey) {
        await this.sendAgent(item.agentSlot, act, item.threadKey);
        return;
      }
      if (item?.binding && isDialBindingId(item.binding, "selector")) {
        await this.dispatchDialBinding(registration, item.binding, act);
        return;
      }
      throw new Error("No Codex dial selection is available.");
    }
    const lifecycle = bindingLifecycle(binding);
    if (act === 0 && lifecycle !== "momentary") return;
    if (binding === "reasoning.decrease") return this.adjustReasoning("decrease");
    if (binding === "reasoning.increase") return this.adjustReasoning("increase");
    if (binding === "new-task") return this.createTask();
    if (binding === "host.toggle") return this.toggleTargetHost();
    if (binding === "usage.refresh") return this.refreshUsage();
    if (binding === "usage.toggle-overview") {
      registration.state = {
        ...registration.state,
        usageOverview: !registration.state.usageOverview
      };
      await this.renderDialSafely(registration);
      return;
    }
    if (binding === "usage.rate-limit-reset") {
      throw new Error("Rate-limit reset requires a dial press and hold.");
    }
    if (binding.startsWith("micro.")) {
      return this.sendMicroAction(binding.slice(6) as MicroActionSlot, act);
    }
    if (binding.startsWith("joystick.")) {
      return this.sendJoystick(binding.slice(9) as MicroDirection, act);
    }
    if (binding.startsWith("keycap.") && act === 1) {
      return this.runKeycap(binding.slice(7) as OfficialKeycapId);
    }
    throw new Error("Unsupported Codex dial binding.");
  }

  private async renderAgent({ action, slot }: AgentRegistration): Promise<void> {
    const agent = this.routedSlots[slot];
    const health = agent ? this.healthForHost(agent.host) : this.targetHealth();
    const unavailableTitle = health.state === "degraded" ? "Signals uncertain"
      : health.state === "offline" ? "Host offline"
        : health.state === "connecting" ? "Connecting" : "Not assigned";
    const title = agent?.title ?? (agent?.threadKey && health.state === "ready" ? "New chat" : unavailableTitle);
    const status = agent ? visualStatusFromMicro(agent.status) : "empty";
    const theme = this.targetSnapshot()?.theme ?? this.localSnapshot?.snapshot.theme ?? "dark";
    const hostBadge = agent && this.relayClient ? (agent.host.platform === "darwin" ? "M" : "W") : undefined;
    await this.setImage(action, renderAgentKey(
      slot, title, status, agent?.selected ?? false, this.animationFrame, theme, hostBadge,
      health.state, agent?.contextUsedPercent, this.showContextRings));
  }

  private async renderAnimatedAgents(): Promise<void> {
    const registrations = [...this.agents.values()].filter(({ slot }) => {
      const agent = this.routedSlots[slot];
      if (!agent) return false;
      const status = visualStatusFromMicro(agent.status);
      return status === "thinking" || status === "input";
    });
    await Promise.all(registrations.map((registration) => this.renderAgent(registration).catch((error) =>
      streamDeck.logger.error(`Agent animation ${registration.slot + 1} failed: ${String(error)}`)
    )));
  }

  private async renderMicroAction({ action, slot }: MicroActionRegistration): Promise<void> {
    const snapshot = this.targetSnapshot();
    const keycapId = snapshot?.layout.slots[slot]?.keycapId;
    if (!keycapId) return;
    const image = await this.keycapImage(keycapId, snapshot?.theme ?? "dark");
    if (image) await this.setImage(action, image);
  }

  private async renderFixedAction(registration: FixedIconRegistration): Promise<void> {
    const theme = this.targetSnapshot()?.theme ?? "dark";
    const image = registration.source.kind === "builtin"
      ? renderBuiltinKeycap(registration.source.name, theme)
      : await this.keycapImage(registration.source.keycapId, theme);
    if (image) await this.setImage(registration.action, image);
  }

  private async renderHostToggle(action: KeyAction): Promise<void> {
    const label = this.targetPlatform === "darwin" ? "MAC" : "WIN";
    const theme = this.targetSnapshot()?.theme ?? "dark";
    await this.setImage(action, renderHostTargetKey(label, this.targetHealth().state, theme));
  }

  private async renderUsageLimit({ action, mode }: UsageLimitRegistration): Promise<void> {
    const source = this.accountUsageSource();
    const snapshot = source.snapshot;
    const window = selectUsageWindow(snapshot?.usage, mode);
    const requestedKind: UsageWindowKind = mode === "auto" ? (window?.kind ?? "other") : mode;
    await this.setImage(action, renderUsageLimitKey(window, requestedKind, snapshot?.theme ?? "dark", source.health.state));
  }

  private async renderUsageOverview(action: KeyAction): Promise<void> {
    const source = this.accountUsageSource();
    await this.setImage(action, renderUsageOverviewKey(source.snapshot?.usage?.windows ?? [], source.snapshot?.theme ?? "dark", source.health.state));
  }

  private async renderRateLimitReset(action: KeyAction): Promise<void> {
    const source = this.accountUsageSource();
    const snapshot = source.snapshot;
    const startedAt = this.resetHolds.get(action.id);
    const progress = startedAt == null ? 0 : Math.min(1, (Date.now() - startedAt) / RESET_HOLD_MS);
    await this.setImage(action, renderRateLimitResetKey(
      snapshot?.usage?.resetCreditsAvailable ?? null,
      progress,
      snapshot?.theme ?? "dark",
      source.health.state
    ));
  }

  private async renderResetHolds(): Promise<void> {
    await Promise.all([...this.resetHolds.keys()].map(async (id) => {
      const action = this.rateLimitResetActions.get(id);
      if (action) await this.renderRateLimitReset(action);
    }));
  }

  private targetHealth(): HostHealth {
    if (!this.localHost || this.targetPlatform === this.localHost.platform) return this.localHealth;
    return this.relayClient?.currentHealth() ?? { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
  }

  private healthForHost(host: CodexHost): HostHealth {
    if (host.hostId === this.localHost?.hostId) return this.localHealth;
    if (host.hostId === this.relayClient?.currentHost()?.hostId) return this.relayClient!.currentHealth();
    return { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
  }

  private targetSnapshot(): MicroSnapshot | undefined {
    const remote = this.relayClient?.currentSnapshot();
    if (this.localHost && this.targetPlatform !== this.localHost.platform) return remote?.snapshot;
    return this.localSnapshot?.snapshot;
  }

  private accountUsageSource(): AccountUsageSource {
    const local: AccountUsageSource = {
      health: this.localHealth,
      hostId: this.localHost?.hostId,
      snapshot: this.localSnapshot?.snapshot
    };
    const remoteSnapshot = this.relayClient?.currentSnapshot();
    const remote: AccountUsageSource | undefined = remoteSnapshot ? {
      health: this.relayClient?.currentHealth() ?? { state: "offline", reason: "relay-disconnected", changedAt: Date.now() },
      hostId: remoteSnapshot.host.hostId,
      snapshot: remoteSnapshot.snapshot
    } : undefined;
    return selectAccountUsageSource(local, remote);
  }

  private isRemoteTarget(): boolean {
    return this.localHost != null && this.targetPlatform !== this.localHost.platform;
  }

  private async sendRemote(command: RelayCommand): Promise<void> {
    if (!this.relayClient) throw new Error("Remote Codex relay is not configured.");
    await this.relayClient.send(command);
  }

  private async sendToTarget(command: RelayCommand, local: () => Promise<void>): Promise<void> {
    await this.sendToHost(this.targetHostId, command, local);
  }

  private async sendToHost(hostId: string | undefined, command: RelayCommand, local: () => Promise<void>): Promise<void> {
    const localHostId = this.localHost?.hostId;
    const remoteRequested = isRemoteControlRequest(this.targetPlatform, this.localHost?.platform ?? "win32", hostId, localHostId);
    if (remoteRequested) await this.sendRemote(command);
    else await local();
  }

  private pressTarget(key: string, pressed: 0 | 1): string | undefined {
    if (pressed === 1) {
      const target = this.targetHostId;
      if (target) this.pressedControlTargets.set(key, target);
      return target;
    }
    const target = this.pressedControlTargets.get(key) ?? this.targetHostId;
    this.pressedControlTargets.delete(key);
    return target;
  }

  private async setImage(action: KeyAction, image: string): Promise<void> {
    if (this.lastImages.get(action.id) === image) return;
    await Promise.all([action.setImage(image), action.setTitle("")]);
    this.lastImages.set(action.id, image);
  }

  private renderUsageAction(label: string, action: KeyAction, render: () => Promise<void>): void {
    void render()
      .then(() => streamDeck.logger.info(`${label} action rendered (${action.id}).`))
      .catch((error) => streamDeck.logger.error(`${label} action render failed (${action.id}): ${String(error)}`));
  }

  private unregister<T>(action: ActionIdentity, registrations: Map<string, T>): void {
    registrations.delete(action.id);
    this.lastImages.delete(action.id);
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    this.poll = setTimeout(async () => {
      try { await this.refresh(); }
      finally { this.scheduleRefresh(); }
    }, 1_200);
  }

  private scheduleAnimation(): void {
    if (this.stopped) return;
    this.animation = setTimeout(async () => {
      this.animationFrame = (this.animationFrame + 1) % 12;
      try { await Promise.all([this.renderAnimatedAgents(), this.renderResetHolds()]); }
      finally { this.scheduleAnimation(); }
    }, 200);
  }

  private keycapImage(keycapId: string, theme: "light" | "dark"): Promise<string | null> {
    const cacheKey = `${theme}:${keycapId}`;
    let pending = this.keycapImages.get(cacheKey);
    if (pending) return pending;
    pending = readFile(join(USER_ICON_ROOT, `${keycapId}.svg`), "utf8")
      .then((svg) => renderImportedKeycap(svg, theme))
      .catch(() => renderFallbackKeycap(keycapId, theme));
    this.keycapImages.set(cacheKey, pending);
    return pending;
  }
}
