import streamDeck, { type DialAction, type KeyAction } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
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
  MAX_DIAL_QUEUE_PENDING,
  bindingLifecycle,
  deriveDialFeedback,
  dialBindingLabel,
  initialDialRuntimeState,
  isDialTickCount,
  isDialBindingId,
  normalizeDialSettings,
  reconcileSelector,
  reduceDialRotation,
  resolveModelPresetDirection,
  selectedItem,
  selectorItems
} from "./dial-domain.js";
import type {
  CodexDialSettings,
  DialBindingId,
  DialRuntimeState,
  DialRuntimeView,
  DialSelectorItem,
  ModelPresetDirection
} from "./dial-types.js";
import {
  HostActivityIndex, RELAY_REASONING_POLICY_CAPABILITY,
  type HostSnapshot, type RelayCommand
} from "./relay-protocol.js";
import {
  renderAgentKey, renderBuiltinKeycap, renderFallbackKeycap, renderHostTargetKey, renderImportedKeycap,
  renderRateLimitResetKey, renderUsageLimitKey, renderUsageOverviewKey, type BuiltinIconName
} from "./render.js";
import { openCodexThread } from "./codex-open.js";
import { visualStatusFromMicro } from "./status.js";
import { isSafeReasoningIdentifier } from "./types.js";
import type {
  CodexHost, CodexModelCatalogEntry, HostHealth, MicroActionSlot, MicroDirection, MicroSnapshot,
  ModelPresetExecution, ModelPresetRequest, ReasoningAdjustment, ReasoningAdjustmentExecution,
  ReasoningAdjustmentPolicy, ReasoningAdjustmentResult, RoutedAgentSlot, UsageLimitMode, UsageWindowKind
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
type CodexDialAction = DialAction<CodexDialSettings> & {
  sendToPropertyInspector?(payload: JsonValue): Promise<void>;
};
type DialHostRoute = { kind: "host"; hostId?: string; platform: ControlTarget };
type DialAgentRoute = {
  kind: "agent";
  assignment: RoutedAgentSlot;
  identity: string;
};
type AgentSendOutcome = { ok: true } | { ok: false; error: unknown };
type KeypadAgentGesture = {
  assignment: RoutedAgentSlot;
  outcome: Promise<AgentSendOutcome>;
};
type DialInvalidAgentRoute = { kind: "invalid-agent" };
type DialRoute = DialHostRoute | DialAgentRoute | DialInvalidAgentRoute;
type DialGesturePhase = "pending" | "active" | "completed" | "failed" | "releasing" | "released" | "canceled";
type DialGesture = {
  binding: DialBindingId;
  route: DialRoute;
  includeUltraReasoning: boolean;
  lifecycle: ReturnType<typeof bindingLifecycle>;
  startedAt: number;
  endedAt?: number;
  phase: DialGesturePhase;
  modelReasoningReservation?: ModelReasoningMutationReservation;
};
type ModelReasoningMutationReservation = { released: boolean };
type DialRegistration = {
  action: CodexDialAction;
  settings: CodexDialSettings;
  state: DialRuntimeState;
  queue: DialCommandQueue;
  generation: number;
  disposed: boolean;
  pressed?: DialGesture;
  lastFeedback?: string;
  renderAgain?: boolean;
  rendering?: Promise<void>;
  noticeActive?: boolean;
  noticeTimer?: NodeJS.Timeout;
  noticeRevision: number;
};
type DialInspectorRegistration = {
  action: CodexDialAction;
  generation: number;
  lastSignature?: string;
};
type ModelCatalogResponse = {
  kind: "model-catalog";
  requestGeneration: number;
  catalogRevision: number;
  available: boolean;
  hostId?: string;
  platform?: ControlTarget;
  snapshotGeneration?: number;
  activeModelId?: string;
  activeModelDisplayName?: string;
  reasoningEffort?: string;
  modelCatalog?: CodexModelCatalogEntry[];
};
type DialNotice = {
  title: string;
  value: string;
  detail: string;
  indicator: number;
  accent: { value: number; bar_fill_c: string };
};
type ResetHold = { startedAt: number; sourceHostId?: string };

const USER_ICON_ROOT = join(codexDeckStateRoot(), "icons");
const LOCAL_MOBILE_CONFIG = "mobile-local-relay-server.json";
const RESET_HOLD_MS = 1_200;
const DIAL_SUCCESS_MS = 350;
const DIAL_ULTRA_NOTICE_MS = 1_200;
const MAX_DIAL_ERROR_DEDUPE = 100;

function rememberDialError(errors: Set<string>, message: string): boolean {
  if (errors.has(message)) return false;
  if (errors.size >= MAX_DIAL_ERROR_DEDUPE) {
    const oldest = errors.values().next().value as string | undefined;
    if (oldest != null) errors.delete(oldest);
  }
  errors.add(message);
  return true;
}

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
  private readonly dialInspectors = new Map<string, DialInspectorRegistration>();
  private readonly resetHolds = new Map<string, ResetHold>();
  private readonly dialDescriptionErrors = new Set<string>();
  private readonly dialRenderErrors = new Set<string>();
  private readonly dialSuccessErrors = new Set<string>();
  private readonly activityIndex = new HostActivityIndex();
  private readonly pressedAgents = new Map<number, KeypadAgentGesture>();
  private readonly failedAgentUps = new Map<number, string>();
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
  private modelReasoningMutationTail: Promise<void> = Promise.resolve();
  private modelReasoningMutationPending = 0;
  private localSnapshotGeneration = 0;
  private controllerLifecycleGeneration = 0;
  private stopped = false;
  private animationFrame = 0;
  private lastError = "";
  private lastAssignmentSignature = "";
  private lastStatusSignature = "";
  private lastLayoutSignature = "";
  private lastAgentSourceSignature = "";
  private lastHostHealthSignature = "";
  private showContextRings = true;
  private nextDialGeneration = 0;
  private nextDialInspectorGeneration = 0;
  private catalogRevision = 0;

  async start(): Promise<void> {
    this.controllerLifecycleGeneration += 1;
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
        () => { void this.refreshDisplayAfterRelaySnapshot(); },
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
        const runAndInvalidate = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
          const result = await operation();
          // The relay server publishes a fresh snapshot after the command.
          mobileSnapshotDirty = true;
          return result;
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
          adjustReasoning: (direction: ReasoningAdjustment, policy?: ReasoningAdjustmentPolicy) => runAndInvalidate(
            () => this.adjustLocalReasoningFromRelay(direction, policy)),
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
    this.controllerLifecycleGeneration += 1;
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.animation) clearInterval(this.animation);
    for (const registration of [...this.dials.values()]) {
      this.disposeDialRegistration(registration, false);
    }
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
    const prior = this.dials.get(action.id);
    if (prior) this.disposeDialRegistration(prior);
    const registration: DialRegistration = {
      action,
      settings: normalizeDialSettings(input),
      state: initialDialRuntimeState(),
      queue: new DialCommandQueue(),
      generation: ++this.nextDialGeneration,
      disposed: false,
      noticeRevision: 0
    };
    this.dials.set(action.id, registration);
    this.updateDialDescription(registration);
    void this.renderDialSafely(registration);
  }

  updateDialSettings(action: CodexDialAction, input: unknown): void {
    const settings = normalizeDialSettings(input);
    let existing = this.dials.get(action.id);
    if (existing && existing.action !== action) {
      this.disposeDialRegistration(existing);
      existing = undefined;
    }
    const registration: DialRegistration = existing ?? {
      action,
      settings,
      state: initialDialRuntimeState(),
      queue: new DialCommandQueue(),
      generation: ++this.nextDialGeneration,
      disposed: false,
      noticeRevision: 0
    };
    this.clearDialNotice(registration);
    registration.action = action;
    registration.settings = settings;
    this.dials.set(action.id, registration);
    this.updateDialDescription(registration);
    void this.renderDialSafely(registration);
  }

  unregisterDial(action: ActionIdentity): void {
    const registration = this.dials.get(action.id);
    if (!registration) return;
    this.disposeDialRegistration(registration);
  }

  registerDialPropertyInspector(action: CodexDialAction): void {
    const prior = this.dialInspectors.get(action.id);
    if (prior) prior.generation = -Math.abs(prior.generation);
    const registration: DialInspectorRegistration = {
      action,
      generation: ++this.nextDialInspectorGeneration
    };
    this.dialInspectors.set(action.id, registration);
    void this.sendModelCatalogToInspector(registration, 0, true);
  }

  unregisterDialPropertyInspector(action: ActionIdentity): void {
    const registration = this.dialInspectors.get(action.id);
    if (!registration || registration.action !== action) return;
    registration.generation = -Math.abs(registration.generation);
    this.dialInspectors.delete(action.id);
  }

  handleDialPropertyInspectorMessage(action: CodexDialAction, input: unknown): void {
    const requestGeneration = this.readModelCatalogRequest(input);
    if (requestGeneration == null) return;
    const registration = this.dialInspectors.get(action.id);
    if (!registration || registration.action !== action || registration.generation <= 0) return;
    void this.sendModelCatalogToInspector(registration, requestGeneration, true);
  }

  private readModelCatalogRequest(input: unknown): number | undefined {
    try {
      if (typeof input !== "object" || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
        return undefined;
      }
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Object.getOwnPropertySymbols(input).length !== 0 || Object.keys(descriptors).sort().join(",") !== "kind,requestGeneration") {
        return undefined;
      }
      const kind = descriptors.kind;
      const generation = descriptors.requestGeneration;
      if (!kind || !generation || !("value" in kind) || !("value" in generation) || kind.value !== "request-model-catalog" ||
          !Number.isSafeInteger(generation.value) || generation.value < 0) return undefined;
      return generation.value as number;
    } catch { return undefined; }
  }

  private currentModelCatalogResponse(requestGeneration: number): Omit<ModelCatalogResponse, "catalogRevision"> {
    const target = this.targetSnapshot();
    const isLocal = this.localHost != null && this.targetPlatform === this.localHost.platform;
    const health = isLocal ? this.localHealth : this.relayClient?.currentHealth();
    const hostSnapshot = isLocal ? this.localSnapshot : this.relayClient?.currentSnapshot();
    const host = hostSnapshot?.host;
    if (health?.state !== "ready" || !target || !host || host.hostId !== this.targetHostId ||
        target.activeModelId == null || target.activeModelDisplayName == null ||
        target.reasoningEffort == null || target.modelCatalog == null) {
      return { kind: "model-catalog", requestGeneration, available: false };
    }
    return {
      kind: "model-catalog",
      requestGeneration,
      available: true,
      hostId: host.hostId,
      platform: host.platform,
      snapshotGeneration: isLocal ? this.localSnapshotGeneration : hostSnapshot.observedAt,
      activeModelId: target.activeModelId,
      activeModelDisplayName: target.activeModelDisplayName,
      reasoningEffort: target.reasoningEffort,
      modelCatalog: target.modelCatalog.map((entry) => ({
        modelId: entry.modelId,
        displayName: entry.displayName,
        supportedReasoningEfforts: [...entry.supportedReasoningEfforts]
      }))
    };
  }

  private async sendModelCatalogToInspector(
    registration: DialInspectorRegistration,
    requestGeneration: number,
    force: boolean
  ): Promise<void> {
    if (this.dialInspectors.get(registration.action.id) !== registration || registration.generation <= 0) return;
    const base = this.currentModelCatalogResponse(requestGeneration);
    const signature = JSON.stringify({ ...base, requestGeneration: 0 });
    if (!force && signature === registration.lastSignature) return;
    registration.lastSignature = signature;
    const payload: ModelCatalogResponse = { ...base, catalogRevision: ++this.catalogRevision };
    try {
      if (registration.action.sendToPropertyInspector) {
        await registration.action.sendToPropertyInspector(payload as unknown as JsonValue);
      } else {
        const visible = streamDeck.ui.action;
        if (visible !== registration.action) return;
        await streamDeck.ui.sendToPropertyInspector(payload as unknown as JsonValue);
      }
    }
    catch (error) {
      if (this.dialInspectors.get(registration.action.id) === registration && registration.lastSignature === signature) {
        registration.lastSignature = undefined;
      }
      streamDeck.logger.warn(`Codex Dial property inspector update failed: ${String(error)}`);
    }
  }

  private async pushModelCatalogs(): Promise<void> {
    await Promise.all([...this.dialInspectors.values()].map((registration) =>
      this.sendModelCatalogToInspector(registration, 0, false)));
  }

  private disposeDialRegistration(
    registration: DialRegistration,
    releaseActiveMomentary = true
  ): void {
    if (registration.disposed) return;
    registration.disposed = true;
    registration.generation = -Math.abs(registration.generation);
    registration.renderAgain = false;
    this.clearDialNotice(registration);
    this.resetHolds.delete(registration.action.id);
    if (this.dials.get(registration.action.id) === registration) {
      this.dials.delete(registration.action.id);
    }
    const pressed = registration.pressed;
    registration.pressed = undefined;
    if (!pressed) return;
    if (pressed.phase === "active" && pressed.lifecycle === "momentary" && releaseActiveMomentary) {
      const release = () => this.releaseDialGesture(registration, pressed, false);
      if (!registration.queue.enqueue(release)) registration.queue.enqueueCleanup(release);
    } else {
      pressed.phase = "canceled";
    }
  }

  private isCurrentDialRegistration(registration: DialRegistration): boolean {
    return !registration.disposed && registration.generation > 0 &&
      this.dials.get(registration.action.id) === registration;
  }

  private serializeModelReasoningMutation<Result>(
    operation: () => Promise<Result>,
    reserved?: ModelReasoningMutationReservation
  ): Promise<Result> {
    const reservation = reserved ?? this.reserveModelReasoningMutations(1)?.[0];
    if (!reservation) {
      return Promise.reject(new Error("Model and reasoning mutation queue is full."));
    }
    const lifecycleGeneration = this.controllerLifecycleGeneration;
    const guardedOperation = async (): Promise<Result> => {
      this.assertControllerLifecycle(lifecycleGeneration);
      const result = await operation();
      this.assertControllerLifecycle(lifecycleGeneration);
      return result;
    };
    const ordered = this.modelReasoningMutationTail.then(guardedOperation, guardedOperation);
    const result = ordered.finally(() => this.releaseModelReasoningMutation(reservation));
    this.modelReasoningMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private reserveModelReasoningMutations(
    count: number
  ): ModelReasoningMutationReservation[] | undefined {
    if (!Number.isSafeInteger(count) || count < 0 ||
        this.modelReasoningMutationPending + count > MAX_DIAL_QUEUE_PENDING) {
      return undefined;
    }
    this.modelReasoningMutationPending += count;
    return Array.from(
      { length: count },
      (): ModelReasoningMutationReservation => ({ released: false })
    );
  }

  private releaseModelReasoningMutation(reservation: ModelReasoningMutationReservation): void {
    if (reservation.released) return;
    reservation.released = true;
    this.modelReasoningMutationPending -= 1;
  }

  private reserveDialGestureMutation(gesture: DialGesture): boolean {
    if (gesture.binding !== "reasoning.decrease" && gesture.binding !== "reasoning.increase") {
      return true;
    }
    const reservation = this.reserveModelReasoningMutations(1)?.[0];
    if (!reservation) return false;
    gesture.modelReasoningReservation = reservation;
    return true;
  }

  private releaseDialGestureMutation(gesture: DialGesture): void {
    if (!gesture.modelReasoningReservation) return;
    this.releaseModelReasoningMutation(gesture.modelReasoningReservation);
    gesture.modelReasoningReservation = undefined;
  }

  private takeDialGestureMutation(
    gesture: DialGesture
  ): ModelReasoningMutationReservation | undefined {
    const reservation = gesture.modelReasoningReservation;
    gesture.modelReasoningReservation = undefined;
    return reservation;
  }

  private assertControllerLifecycle(lifecycleGeneration: number): void {
    if (this.stopped || lifecycleGeneration !== this.controllerLifecycleGeneration) {
      throw new Error("Codex controller lifecycle was stopped or superseded.");
    }
  }

  private adjustLocalReasoningFromRelay(
    direction: ReasoningAdjustment,
    policy?: ReasoningAdjustmentPolicy
  ): Promise<ReasoningAdjustmentExecution> {
    return this.serializeModelReasoningMutation(
      () => this.adjustLocalReasoning(direction, policy));
  }

  private async adjustLocalReasoning(
    direction: ReasoningAdjustment,
    policy?: ReasoningAdjustmentPolicy
  ): Promise<ReasoningAdjustmentExecution> {
    const lifecycleGeneration = this.controllerLifecycleGeneration;
    const operationHost = this.localHost;
    const mutationGeneration = ++this.localSnapshotGeneration;
    const rawExecution = await this.microBridge.adjustReasoning(direction, policy);
    this.assertControllerLifecycle(lifecycleGeneration);
    let execution = parseReasoningExecution(rawExecution);
    if (!execution) {
      if (!isAppliedReasoningExecutionWithUnconfirmedEffort(rawExecution)) {
        throw new Error("Codex returned an invalid reasoning adjustment result.");
      }
      execution = await this.reconcileUnconfirmedLocalReasoning(lifecycleGeneration);
    } else if (execution.outcome === "applied" && execution.reasoningEffort === undefined) {
      execution = await this.reconcileUnconfirmedLocalReasoning(lifecycleGeneration);
    }
    if (execution.outcome === "applied" && this.localSnapshotGeneration !== mutationGeneration) {
      const authoritativeEffort = this.authoritativeLocalReasoningEffort(operationHost);
      if (authoritativeEffort !== undefined) {
        return { outcome: "applied", reasoningEffort: authoritativeEffort };
      }
      return this.reconcileUnconfirmedLocalReasoning(lifecycleGeneration);
    }
    const current = this.localSnapshot;
    if (execution.reasoningEffort !== undefined && operationHost != null &&
        this.localSnapshotGeneration === mutationGeneration &&
        this.localHost?.hostId === operationHost.hostId &&
        this.localHost.platform === operationHost.platform && current != null &&
        current.host.hostId === operationHost.hostId && current.host.platform === operationHost.platform &&
        current.snapshot.reasoningEffort !== execution.reasoningEffort) {
      this.localSnapshot = {
        ...current,
        snapshot: { ...current.snapshot, reasoningEffort: execution.reasoningEffort }
      };
    }
    return execution;
  }

  private authoritativeLocalReasoningEffort(operationHost?: CodexHost): string | undefined {
    const current = this.localSnapshot;
    const effort = current?.snapshot.reasoningEffort;
    if (this.localHealth.state !== "ready" || operationHost == null || current == null ||
        this.localHost?.hostId !== operationHost.hostId ||
        this.localHost.platform !== operationHost.platform ||
        current.host.hostId !== operationHost.hostId ||
        current.host.platform !== operationHost.platform ||
        !isSafeReasoningIdentifier(effort)) {
      return undefined;
    }
    return effort;
  }

  private async reconcileUnconfirmedLocalReasoning(
    lifecycleGeneration = this.controllerLifecycleGeneration
  ): Promise<ReasoningAdjustmentExecution> {
    if (this.refreshInFlight) {
      try { await this.refreshInFlight; }
      catch { /* A fresh refresh is still attempted below. */ }
    }
    this.assertControllerLifecycle(lifecycleGeneration);
    const priorSnapshot = this.localSnapshot;
    let refreshCompleted = false;
    try {
      await this.refresh();
      this.assertControllerLifecycle(lifecycleGeneration);
      refreshCompleted = true;
    } catch { /* Authority is checked below so overridden/test refresh paths fail closed identically. */ }
    const localHost = this.localHost;
    const current = this.localSnapshot;
    const reasoningEffort = current?.snapshot.reasoningEffort;
    if (refreshCompleted && current !== priorSnapshot && this.localHealth.state === "ready" &&
        localHost != null && current != null &&
        current.host.hostId === localHost.hostId && current.host.platform === localHost.platform &&
        isSafeReasoningIdentifier(reasoningEffort)) {
      return { outcome: "applied", reasoningEffort };
    }
    this.localHealth = {
      state: "degraded",
      reason: "local-bridge-unavailable",
      changedAt: Date.now()
    };
    throw new Error("Authoritative reasoning state is unavailable after the applied adjustment.");
  }

  rotateDial(action: CodexDialAction, ticks: number): void {
    const registration = this.dials.get(action.id);
    if (!registration) return;
    if (!isDialTickCount(ticks)) {
      void this.reportDialCommandError(
        registration,
        new Error("Dial rotation ignored: invalid or excessive tick count.")
      );
      return;
    }
    registration.settings = normalizeDialSettings(registration.settings);
    if (registration.settings.rotation.kind === "model-presets") {
      if (ticks === 0) return;
      const count = Math.abs(ticks);
      if (!registration.queue.canEnqueue(count)) {
        void this.reportDialCommandError(
          registration,
          new Error("Dial rotation ignored: command queue is full.")
        );
        return;
      }
      const reservations = this.reserveModelReasoningMutations(count);
      if (!reservations) {
        void this.reportDialCommandError(
          registration,
          new Error("Dial rotation ignored: model and reasoning mutation queue is full.")
        );
        return;
      }
      const direction: ModelPresetDirection = ticks > 0 ? "clockwise" : "counter-clockwise";
      for (let detent = 0; detent < count; detent += 1) {
        this.enqueueModelPresetDirection(registration, direction, reservations[detent]!);
      }
      return;
    }
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
    if (!registration.queue.canEnqueue(reduced.bindings.length)) {
      void this.reportDialCommandError(
        registration,
        new Error("Dial rotation ignored: command queue is full.")
      );
      return;
    }
    const reasoningCount = reduced.bindings.filter((binding) =>
      binding === "reasoning.decrease" || binding === "reasoning.increase").length;
    const reasoningReservations = this.reserveModelReasoningMutations(reasoningCount);
    if (!reasoningReservations) {
      void this.reportDialCommandError(
        registration,
        new Error("Dial rotation ignored: model and reasoning mutation queue is full.")
      );
      return;
    }
    const startedAt = Date.now();
    let reasoningReservationIndex = 0;
    for (const binding of reduced.bindings) {
      const gesture = this.captureDialGesture(registration, binding, undefined, startedAt);
      if (binding === "reasoning.decrease" || binding === "reasoning.increase") {
        gesture.modelReasoningReservation = reasoningReservations[reasoningReservationIndex++];
      }
      this.enqueueDialTap(registration, gesture);
    }
  }

  private enqueueModelPresetDirection(
    registration: DialRegistration,
    direction: ModelPresetDirection,
    reservation: ModelReasoningMutationReservation
  ): void {
    const accepted = registration.queue.enqueue(async () => {
      await this.serializeModelReasoningMutation(async () => {
        if (!this.isCurrentDialRegistration(registration)) return;
        registration.settings = normalizeDialSettings(registration.settings);
        if (registration.settings.rotation.kind !== "model-presets") return;
        const resolution = resolveModelPresetDirection(
          registration.settings,
          this.dialRuntimeView(registration.settings, registration.state),
          direction
        );
        if (resolution.kind !== "target") {
          await this.renderDialSafely(registration);
          return;
        }
        const route: DialHostRoute = {
          kind: "host",
          hostId: this.targetHostId,
          platform: this.targetPlatform
        };
        const request: ModelPresetRequest = {
          modelId: resolution.entry.modelId,
          reasoningEffort: resolution.entry.reasoningEffort,
          includeUltra: registration.settings.includeUltraReasoning
        };
        registration.state = { ...registration.state, modelPresetSwitching: true };
        await this.renderDialSafely(registration);
        try {
          await this.sendModelPresetToHost(route, request);
          if (!this.isCurrentDialRegistration(registration)) return;
          registration.state = { ...registration.state, modelPresetSwitching: false };
          await this.renderDialSafely(registration);
        } catch (error) {
          if (!this.isCurrentDialRegistration(registration)) return;
          registration.state = { ...registration.state, modelPresetSwitching: false };
          await this.renderDialSafely(registration);
          await this.reportDialCommandError(registration, error);
        }
      }, reservation);
    });
    if (!accepted) {
      this.releaseModelReasoningMutation(reservation);
    }
    if (!accepted && this.isCurrentDialRegistration(registration)) {
      void this.reportDialCommandError(
        registration,
        new Error("Dial rotation ignored: command queue is full.")
      );
    }
  }

  beginDialPress(action: CodexDialAction): Promise<void> {
    const registration = this.dials.get(action.id);
    if (!registration) return Promise.resolve();
    if (registration.pressed) return registration.queue.idle();
    registration.settings = normalizeDialSettings(registration.settings);
    const pressed = this.resolveDialPress(registration, Date.now());
    if (!this.reserveDialGestureMutation(pressed)) {
      void this.reportDialCommandError(
        registration,
        new Error("Dial press ignored: model and reasoning mutation queue is full.")
      );
      return registration.queue.idle();
    }
    registration.pressed = pressed;
    this.enqueueDialDown(registration, pressed);
    return registration.queue.idle();
  }

  finishDialPress(action: CodexDialAction): Promise<void> {
    const registration = this.dials.get(action.id);
    if (!registration) return Promise.resolve();
    const pressed = registration.pressed;
    registration.pressed = undefined;
    if (!pressed) return registration.queue.idle();
    pressed.endedAt = Date.now();
    this.enqueueDialUp(registration, pressed);
    return registration.queue.idle();
  }

  touchDial(action: CodexDialAction): Promise<void> {
    const registration = this.dials.get(action.id);
    if (!registration) return Promise.resolve();
    registration.settings = normalizeDialSettings(registration.settings);
    const gesture = this.captureDialGesture(
      registration,
      registration.settings.touchTap,
      undefined,
      Date.now()
    );
    if (!this.reserveDialGestureMutation(gesture)) {
      void this.reportDialCommandError(
        registration,
        new Error("Dial gesture ignored: model and reasoning mutation queue is full.")
      );
      return registration.queue.idle();
    }
    this.enqueueDialTap(registration, gesture);
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

  beginRateLimitReset(
    action: ActionIdentity,
    startedAt = Date.now(),
    sourceHostId?: string
  ): void {
    this.resetHolds.set(action.id, {
      startedAt,
      ...(sourceHostId == null ? {} : { sourceHostId })
    });
    const registered = this.rateLimitResetActions.get(action.id);
    if (registered) {
      void this.renderRateLimitReset(registered).catch((error) =>
        streamDeck.logger.error(`Rate-limit reset hold render failed (${action.id}): ${String(error)}`));
    }
  }

  async finishRateLimitReset(
    action: ActionIdentity,
    endedAt = Date.now(),
    sourceHostId?: string,
    requireReady = false
  ): Promise<boolean> {
    const hold = this.resetHolds.get(action.id);
    this.resetHolds.delete(action.id);
    const registered = this.rateLimitResetActions.get(action.id);
    if (registered) await this.renderRateLimitReset(registered);
    if (hold == null || endedAt - hold.startedAt < RESET_HOLD_MS) return false;
    const capturedHostId = sourceHostId ?? hold.sourceHostId;
    const source = capturedHostId == null
      ? this.accountUsageSource()
      : this.accountUsageSourceForHost(capturedHostId);
    if (requireReady && source.health.state !== "ready") {
      throw new Error("The captured Codex usage host is not ready.");
    }
    const usage = source.snapshot?.usage;
    const available = usage?.resetCreditsAvailable;
    if (typeof available !== "number" || !Number.isSafeInteger(available) || available <= 0) {
      throw new Error("No rate-limit reset credit is available.");
    }
    const applicable = usage?.resetCreditsApplicable;
    if (typeof applicable !== "number" || !Number.isSafeInteger(applicable) || applicable <= 0) {
      throw new Error("No rate-limit reset credit is currently applicable.");
    }
    if (capturedHostId == null) {
      await this.sendToHost(
        source.hostId,
        { kind: "rate-limit-reset" },
        () => this.microBridge.consumeRateLimitReset()
      );
    } else {
      await this.sendDialToHost(
        this.hostRoute(capturedHostId),
        { kind: "rate-limit-reset" },
        () => this.microBridge.consumeRateLimitReset()
      );
    }
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
    if (act === 1) {
      const current = this.routedSlots[slot];
      if (!current) throw new Error(`No Codex task is assigned to global agent slot ${slot + 1}.`);
      const threadKey = current.threadKey;
      if (!threadKey) throw new Error("The selected Codex task has no stable thread identity.");
      if (expectedThreadKey != null && threadKey !== expectedThreadKey) {
        throw new Error("The selected Codex task no longer matches the highlighted task.");
      }
      this.failedAgentUps.delete(slot);
      const assignment = { ...current, host: { ...current.host } };
      const outcome = this.sendAgentAssignment(assignment, 1).then<AgentSendOutcome, AgentSendOutcome>(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error })
      );
      const gesture = { assignment, outcome };
      this.pressedAgents.set(slot, gesture);
      const result = await outcome;
      if (!result.ok) {
        if (this.pressedAgents.get(slot) === gesture) {
          this.pressedAgents.delete(slot);
          this.failedAgentUps.set(slot, threadKey);
        }
        throw result.error;
      }
      return;
    }

    const gesture = this.pressedAgents.get(slot);
    if (!gesture) {
      const failedThreadKey = this.failedAgentUps.get(slot);
      if (failedThreadKey == null) {
        throw new Error(`No Codex task is assigned to global agent slot ${slot + 1}.`);
      }
      if (expectedThreadKey != null && failedThreadKey !== expectedThreadKey) {
        throw new Error("The selected Codex task no longer matches the highlighted task.");
      }
      this.failedAgentUps.delete(slot);
      return;
    }
    if (expectedThreadKey != null && gesture.assignment.threadKey !== expectedThreadKey) {
      throw new Error("The selected Codex task no longer matches the highlighted task.");
    }
    this.pressedAgents.delete(slot);
    const result = await gesture.outcome;
    if (!result.ok) return;
    await this.sendAgentAssignment(gesture.assignment, 0);
    void this.refresh();
  }

  private async sendAgentAssignment(assignment: RoutedAgentSlot, act: 0 | 1): Promise<void> {
    if (!assignment.threadKey) throw new Error("The selected Codex task has no stable thread identity.");
    if (assignment.host.hostId === this.localHost?.hostId) {
      await this.microBridge.sendAgent(assignment.sourceSlot, act, assignment.threadKey);
      return;
    }
    const remote = this.relayClient?.currentHost();
    if (remote?.hostId !== assignment.host.hostId) {
      throw new Error("The captured Codex agent host is no longer connected.");
    }
    await this.sendRemote({
      kind: "agent", slot: assignment.sourceSlot, threadKey: assignment.threadKey, act
    });
  }

  async sendMicroAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
    const target = this.pressTarget(`action:${slot}`, act);
    await this.sendToHost(target, { kind: "action", slot, act }, () => this.runLocalMicroAction(slot, act));
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
    await this.serializeModelReasoningMutation(() =>
      this.sendToTarget({ kind: "reasoning", direction, includeUltra: true }, async () => {
        await this.adjustLocalReasoning(direction, { includeUltra: true });
      }));
  }

  async runKeycap(keycapId: OfficialKeycapId): Promise<void> {
    await this.sendToTarget({ kind: "keycap", keycapId }, () => this.runLocalKeycap(keycapId));
  }

  async createTask(): Promise<void> {
    if (this.isRemoteTarget()) await this.sendRemote({ kind: "keycap", keycapId: "NEW" });
    else await openCodexThread("new");
  }

  async refreshUsage(): Promise<void> {
    const source = this.accountUsageSource();
    if (source.hostId != null && source.hostId !== this.localHost?.hostId) {
      const remote = this.relayClient?.currentHost();
      if (remote?.hostId !== source.hostId ||
          !this.relayClient?.supportsCapabilityForSnapshot(
            "usage-refresh", source.hostId, remote.platform
          )) {
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

  private async refreshDisplayAfterRelaySnapshot(): Promise<void> {
    try { await this.refreshDisplay(); }
    catch (error) {
      streamDeck.logger.error(`Remote Codex snapshot display failed: ${String(error)}`);
    }
  }

  private async renderAll(): Promise<void> {
    await Promise.all([
      this.pushModelCatalogs(),
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
    const occupiedHostIds = new Set(
      this.routedSlots
        .filter((slot) => slot.threadKey != null)
        .map((slot) => slot.host.hostId)
    );
    const showHostBadges = occupiedHostIds.size > 1;
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
      activeModelId: targetSnapshot?.activeModelId,
      activeModelDisplayName: targetSnapshot?.activeModelDisplayName,
      ...(targetSnapshot?.modelCatalog == null ? {} : {
        modelCatalog: targetSnapshot.modelCatalog.map((entry) => ({
          modelId: entry.modelId,
          displayName: entry.displayName,
          supportedReasoningEfforts: [...entry.supportedReasoningEfforts]
        }))
      }),
      agents: this.routedSlots
        .filter((slot): slot is RoutedAgentSlot & { threadKey: string } => slot.threadKey != null)
        .map((slot) => ({
          id: slot.id,
          identity: `${slot.host.hostId}:${slot.threadKey}`,
          threadKey: slot.threadKey,
          title: slot.title ?? `Agent ${slot.id + 1}`,
          status: slot.status,
          health: this.healthForHost(slot.host).state,
          ...(showHostBadges
            ? { hostBadge: slot.host.platform === "darwin" ? "M" as const : "W" as const }
            : {}),
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
    if (!this.isCurrentDialRegistration(registration) || registration.noticeActive) return;
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
    if (!this.isCurrentDialRegistration(registration)) return;
    await registration.action.setFeedback({
      title: feedback.title,
      value: feedback.value,
      detail: feedback.detail,
      indicator: feedback.indicator,
      accent: { value: 100, bar_fill_c: feedback.accent }
    });
    if (this.isCurrentDialRegistration(registration)) registration.lastFeedback = signature;
  }

  private async renderDialSafely(registration: DialRegistration): Promise<void> {
    if (!this.isCurrentDialRegistration(registration)) return;
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
          if (rememberDialError(this.dialRenderErrors, message)) {
            streamDeck.logger.error(`Codex dial feedback unavailable: ${message}`);
          }
        }
      } while (registration.renderAgain && this.isCurrentDialRegistration(registration));
    })();
    registration.rendering = rendering;
    try { await rendering; }
    finally {
      if (registration.rendering === rendering) registration.rendering = undefined;
      if (registration.disposed) {
        const current = this.dials.get(registration.action.id);
        if (current && current !== registration) void this.renderDialSafely(current);
      }
    }
  }

  private updateDialDescription(registration: DialRegistration): void {
    if (!this.isCurrentDialRegistration(registration)) return;
    const { settings, action } = registration;
    const rotate = settings.rotation.kind === "paired" ? "Adjust" : "Select";
    const push = dialBindingLabel(settings.press);
    const touch = dialBindingLabel(settings.touchTap);
    void action.setTriggerDescription({ rotate, push, touch }).catch((error) => {
      const message = String(error);
      if (rememberDialError(this.dialDescriptionErrors, message)) {
        streamDeck.logger.warn(`Codex dial trigger descriptions unavailable: ${message}`);
      }
    });
  }

  private clearDialNotice(registration: DialRegistration): void {
    if (!registration.noticeActive && !registration.noticeTimer) return;
    if (registration.noticeTimer) clearTimeout(registration.noticeTimer);
    registration.noticeTimer = undefined;
    registration.noticeActive = false;
    registration.noticeRevision += 1;
    registration.lastFeedback = undefined;
  }

  private async restoreDialAfterStaleNotice(registration: DialRegistration): Promise<void> {
    const current = this.dials.get(registration.action.id);
    if (!current || current === registration || !this.isCurrentDialRegistration(current)) return;
    current.lastFeedback = undefined;
    await this.renderDialSafely(current);
  }

  private async showDialNotice(
    registration: DialRegistration,
    notice: DialNotice,
    durationMs: number
  ): Promise<void> {
    if (!this.isCurrentDialRegistration(registration)) return;
    if (registration.noticeTimer) clearTimeout(registration.noticeTimer);
    registration.noticeTimer = undefined;
    const revision = ++registration.noticeRevision;
    registration.noticeActive = true;
    if (registration.rendering) await registration.rendering;
    if (!this.isCurrentDialRegistration(registration)) {
      await this.restoreDialAfterStaleNotice(registration);
      return;
    }
    if (registration.noticeRevision !== revision) {
      registration.lastFeedback = undefined;
      await this.renderDialSafely(registration);
      return;
    }
    try {
      await registration.action.setFeedback(notice);
    } catch (error) {
      if (!this.isCurrentDialRegistration(registration)) {
        await this.restoreDialAfterStaleNotice(registration);
        return;
      }
      if (registration.noticeRevision !== revision) {
        registration.lastFeedback = undefined;
        await this.renderDialSafely(registration);
        return;
      }
      registration.noticeActive = false;
      const message = String(error);
      if (rememberDialError(this.dialSuccessErrors, message)) {
        streamDeck.logger.warn(`Codex dial temporary feedback unavailable: ${message}`);
      }
      registration.lastFeedback = undefined;
      await this.renderDialSafely(registration);
      return;
    }
    if (!this.isCurrentDialRegistration(registration)) {
      await this.restoreDialAfterStaleNotice(registration);
      return;
    }
    if (registration.noticeRevision !== revision) {
      registration.lastFeedback = undefined;
      await this.renderDialSafely(registration);
      return;
    }
    registration.noticeTimer = setTimeout(() => {
      if (!this.isCurrentDialRegistration(registration) ||
          registration.noticeRevision !== revision) return;
      registration.noticeTimer = undefined;
      registration.noticeActive = false;
      registration.lastFeedback = undefined;
      void this.renderDialSafely(registration);
    }, durationMs);
  }

  private async showDialSuccess(registration: DialRegistration): Promise<void> {
    await this.showDialNotice(registration, {
      title: "RATE LIMIT",
      value: "RESET COMPLETE",
      detail: "CREDIT APPLIED",
      indicator: 100,
      accent: { value: 100, bar_fill_c: "#35D86B" }
    }, DIAL_SUCCESS_MS);
  }

  private async showDialUltraOff(registration: DialRegistration): Promise<void> {
    await this.showDialNotice(registration, {
      title: "REASONING",
      value: "ULTRA OFF",
      detail: "ENABLE IN DIAL SETTINGS",
      indicator: 100,
      accent: { value: 100, bar_fill_c: "#FF9A3D" }
    }, DIAL_ULTRA_NOTICE_MS);
  }

  private resolveDialPress(registration: DialRegistration, startedAt: number): DialGesture {
    const binding = registration.settings.press;
    if (binding !== "selector.activate") {
      return this.captureDialGesture(registration, binding, undefined, startedAt);
    }
    const item = selectedItem(
      registration.settings,
      registration.state,
      this.dialRuntimeView(registration.settings, registration.state)
    );
    return this.captureDialGesture(registration, binding, item, startedAt);
  }

  private captureDialGesture(
    registration: DialRegistration,
    requestedBinding: DialBindingId,
    item: DialSelectorItem | undefined,
    startedAt: number
  ): DialGesture {
    let binding = requestedBinding;
    let route: DialRoute;
    if (binding === "selector.activate") {
      if (item?.agentSlot != null && item.threadKey) {
        const assignment = this.routedSlots[item.agentSlot];
        const identity = assignment?.threadKey
          ? `${assignment.host.hostId}:${assignment.threadKey}`
          : undefined;
        route = assignment && identity === item.id
          ? {
              kind: "agent",
              assignment: {
                ...assignment,
                host: { ...assignment.host }
              },
              identity
            }
          : { kind: "invalid-agent" };
      } else if (item?.binding && isDialBindingId(item.binding, "selector")) {
        binding = item.binding;
        route = this.captureDialHostRoute(binding);
      } else {
        route = { kind: "invalid-agent" };
      }
    } else {
      route = this.captureDialHostRoute(binding);
    }
    return {
      binding,
      route,
      includeUltraReasoning: registration.settings.includeUltraReasoning,
      lifecycle: route.kind === "agent" ? "momentary" : bindingLifecycle(binding),
      startedAt,
      phase: "pending"
    };
  }

  private captureDialHostRoute(binding: DialBindingId): DialHostRoute {
    if (binding === "usage.refresh" || binding === "usage.rate-limit-reset") {
      const source = this.accountUsageSource();
      return this.hostRoute(source.hostId);
    }
    return {
      kind: "host",
      hostId: this.targetHostId,
      platform: this.targetPlatform
    };
  }

  private enqueueDialDown(registration: DialRegistration, gesture: DialGesture): void {
    const accepted = registration.queue.enqueue(async () => {
      if (!this.isCurrentDialRegistration(registration)) {
        gesture.phase = "canceled";
        this.releaseDialGestureMutation(gesture);
        return;
      }
      try {
        if (gesture.lifecycle === "hold") {
          const sourceHostId = gesture.route.kind === "host" ? gesture.route.hostId : undefined;
          this.beginRateLimitReset(registration.action, gesture.startedAt, sourceHostId);
          gesture.phase = "active";
          return;
        }
        await this.dispatchDialGesture(registration, gesture, 1);
        if (gesture.lifecycle !== "momentary") {
          gesture.phase = "completed";
          return;
        }
        gesture.phase = "active";
        if (!this.isCurrentDialRegistration(registration)) {
          await this.releaseDialGesture(
            registration,
            gesture,
            this.isCurrentDialRegistration(registration)
          );
        }
      } catch (error) {
        gesture.phase = "failed";
        if (this.isCurrentDialRegistration(registration)) {
          await this.reportDialCommandError(registration, error);
        }
      }
    });
    if (!accepted) {
      gesture.phase = "failed";
      this.releaseDialGestureMutation(gesture);
      if (this.isCurrentDialRegistration(registration)) {
        void this.reportDialCommandError(
          registration,
          new Error("Dial press ignored: command queue is full.")
        );
      }
    }
  }

  private enqueueDialUp(registration: DialRegistration, gesture: DialGesture): void {
    const release = async (): Promise<void> => {
      if (gesture.phase !== "active") return;
      if (gesture.lifecycle === "hold") {
        gesture.phase = "releasing";
        let reset = false;
        try {
          const sourceHostId = gesture.route.kind === "host" ? gesture.route.hostId : undefined;
          reset = await this.finishRateLimitReset(
            registration.action,
            gesture.endedAt ?? gesture.startedAt,
            sourceHostId,
            true
          );
          gesture.phase = "released";
        } catch (error) {
          gesture.phase = "released";
          if (this.isCurrentDialRegistration(registration)) {
            await this.reportDialCommandError(registration, error);
          }
        }
        if (reset && this.isCurrentDialRegistration(registration)) {
          await this.showDialSuccess(registration);
        }
        return;
      }
      await this.releaseDialGesture(
        registration,
        gesture,
        this.isCurrentDialRegistration(registration)
      );
    };
    if (!registration.queue.enqueue(release)) {
      if (gesture.lifecycle === "momentary") {
        registration.queue.enqueueCleanup(release);
      } else {
        gesture.phase = "failed";
        if (gesture.lifecycle === "hold") this.resetHolds.delete(registration.action.id);
        if (this.isCurrentDialRegistration(registration)) {
          void this.reportDialCommandError(
            registration,
            new Error("Dial release ignored: command queue is full.")
          );
        }
      }
    }
  }

  private enqueueDialTap(registration: DialRegistration, gesture: DialGesture): void {
    const accepted = registration.queue.enqueue(async () => {
      if (!this.isCurrentDialRegistration(registration)) {
        gesture.phase = "canceled";
        this.releaseDialGestureMutation(gesture);
        return;
      }
      if (gesture.lifecycle === "hold") {
        gesture.phase = "failed";
        await this.reportDialCommandError(
          registration,
          new Error("Rate-limit reset requires a dial press and hold.")
        );
        return;
      }
      try {
        await this.dispatchDialGesture(registration, gesture, 1);
        if (gesture.lifecycle === "momentary") {
          gesture.phase = "active";
          await this.releaseDialGesture(
            registration,
            gesture,
            this.isCurrentDialRegistration(registration)
          );
        } else {
          gesture.phase = "completed";
        }
      } catch (error) {
        if (gesture.phase !== "released") gesture.phase = "failed";
        if (this.isCurrentDialRegistration(registration)) {
          await this.reportDialCommandError(registration, error);
        }
      }
    });
    if (!accepted) {
      gesture.phase = "failed";
      this.releaseDialGestureMutation(gesture);
      if (this.isCurrentDialRegistration(registration)) {
        void this.reportDialCommandError(
          registration,
          new Error("Dial gesture ignored: command queue is full.")
        );
      }
    }
  }

  private async releaseDialGesture(
    registration: DialRegistration,
    gesture: DialGesture,
    reportFailure: boolean
  ): Promise<void> {
    if (gesture.phase !== "active") return;
    gesture.phase = "releasing";
    try {
      await this.dispatchDialGesture(registration, gesture, 0);
    } catch (error) {
      if (reportFailure) await this.reportDialCommandError(registration, error);
    } finally {
      gesture.phase = "released";
    }
  }

  private async dispatchDialGesture(
    registration: DialRegistration,
    gesture: DialGesture,
    act: 0 | 1
  ): Promise<void> {
    const { binding, route } = gesture;
    if (!isDialBindingId(binding, "press")) throw new Error("Unsupported Codex dial binding.");
    if (binding === "none") return;
    if (route.kind === "invalid-agent") throw new Error("No Codex dial selection is available.");
    if (route.kind === "agent") {
      await this.sendDialAgent(route, act);
      return;
    }
    const lifecycle = bindingLifecycle(binding);
    if (act === 0 && lifecycle !== "momentary") return;
    if (binding === "reasoning.decrease") {
      await this.serializeModelReasoningMutation(async () => {
        if (!this.isCurrentDialRegistration(registration)) return;
        const result = await this.sendDialToHost(
          route,
          {
            kind: "reasoning", direction: "decrease",
            includeUltra: gesture.includeUltraReasoning,
            includeReasoningFeedback: true
          },
          () => this.adjustLocalReasoning("decrease", {
            includeUltra: gesture.includeUltraReasoning
          })
        );
        const outcome = reasoningResultOutcome(result);
        if (outcome === "blocked-ultra") await this.showDialUltraOff(registration);
        else if (reasoningResultEffort(result) !== undefined) {
          await this.renderDialSafely(registration);
        }
      }, this.takeDialGestureMutation(gesture));
      return;
    }
    if (binding === "reasoning.increase") {
      await this.serializeModelReasoningMutation(async () => {
        if (!this.isCurrentDialRegistration(registration)) return;
        const result = await this.sendDialToHost(
          route,
          {
            kind: "reasoning", direction: "increase",
            includeUltra: gesture.includeUltraReasoning,
            includeReasoningFeedback: true
          },
          () => this.adjustLocalReasoning("increase", {
            includeUltra: gesture.includeUltraReasoning
          })
        );
        const outcome = reasoningResultOutcome(result);
        if (outcome === "blocked-ultra") await this.showDialUltraOff(registration);
        else if (reasoningResultEffort(result) !== undefined) {
          await this.renderDialSafely(registration);
        }
      }, this.takeDialGestureMutation(gesture));
      return;
    }
    if (binding === "new-task") {
      await this.sendDialToHost(
        route,
        { kind: "keycap", keycapId: "NEW" },
        () => openCodexThread("new")
      );
      return;
    }
    if (binding === "host.toggle") return this.toggleTargetHost();
    if (binding === "usage.refresh") return this.refreshDialUsage(route);
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
      const slot = binding.slice(6) as MicroActionSlot;
      await this.sendDialToHost(
        route,
        { kind: "action", slot, act },
        () => this.runLocalMicroAction(slot, act),
        act === 1
      );
      return;
    }
    if (binding.startsWith("joystick.")) {
      const direction = binding.slice(9) as MicroDirection;
      await this.sendDialToHost(
        route,
        { kind: "joystick", direction, distance: act },
        () => this.microBridge.sendJoystick(direction, act),
        act === 1
      );
      return;
    }
    if (binding.startsWith("keycap.") && act === 1) {
      const keycapId = binding.slice(7) as OfficialKeycapId;
      await this.sendDialToHost(
        route,
        { kind: "keycap", keycapId },
        () => this.runLocalKeycap(keycapId)
      );
      return;
    }
    throw new Error("Unsupported Codex dial binding.");
  }

  private async sendDialAgent(route: DialAgentRoute, act: 0 | 1): Promise<void> {
    if (act === 1) {
      const current = this.routedSlots.find((candidate) => candidate.threadKey != null &&
        `${candidate.host.hostId}:${candidate.threadKey}` === route.identity);
      if (!current || current.sourceSlot !== route.assignment.sourceSlot) {
        throw new Error("The selected Codex task no longer matches the highlighted host and task.");
      }
      if (this.healthForHost(current.host).state !== "ready") {
        throw new Error("The captured Codex agent host is not ready.");
      }
      route.assignment = { ...current, host: { ...current.host } };
    }
    await this.sendAgentAssignment(route.assignment, act);
  }

  private async sendDialToHost(
    route: DialHostRoute,
    command: RelayCommand,
    local: () => Promise<void | ReasoningAdjustmentExecution>,
    requireReady = true
  ): Promise<ReasoningAdjustmentResult | ReasoningAdjustmentExecution | undefined> {
    const localHost = this.localHost;
    const localRequested = route.hostId != null
      ? route.hostId === localHost?.hostId
      : route.platform === localHost?.platform;
    if (localRequested) {
      if (requireReady && this.localHealth.state !== "ready") {
        throw new Error("The captured Codex host is not ready.");
      }
      const execution = await local();
      const parsed = parseReasoningExecution(execution);
      if (!parsed) return undefined;
      return parsed.reasoningEffort === undefined ? parsed.outcome : parsed;
    }
    const remote = this.relayClient?.currentHost();
    if (!remote || (route.hostId != null
      ? remote.hostId !== route.hostId
      : remote.platform !== route.platform)) {
      throw new Error("The captured Codex host is no longer connected.");
    }
    if (requireReady && this.relayClient?.currentHealth().state !== "ready") {
      throw new Error("The captured Codex host is not ready.");
    }
    if (command.kind === "reasoning" && !command.includeUltra &&
        !this.relayClient?.supportsCurrentReadyCapability(RELAY_REASONING_POLICY_CAPABILITY)) {
      throw new Error("Remote Codex host does not support reasoning policy controls.");
    }
    const result = await this.sendRemote(command);
    if (typeof result === "string" || result === undefined) return result;
    return parseReasoningExecution(result);
  }

  private async sendModelPresetToHost(
    route: DialHostRoute,
    request: ModelPresetRequest
  ): Promise<ModelPresetExecution> {
    const lifecycleGeneration = this.controllerLifecycleGeneration;
    const localHost = this.localHost;
    const localRequested = route.hostId != null
      ? route.hostId === localHost?.hostId
      : route.platform === localHost?.platform;
    if (!localRequested) {
      throw new Error("Remote Codex host does not support model preset controls yet.");
    }
    if (this.localHealth.state !== "ready") {
      throw new Error("The captured Codex host is not ready.");
    }

    const mutationGeneration = ++this.localSnapshotGeneration;
    try {
      const parsed = parseModelPresetExecution(await this.microBridge.applyModelPreset(request));
      this.assertControllerLifecycle(lifecycleGeneration);
      if (!parsed || parsed.modelId !== request.modelId ||
          parsed.reasoningEffort !== request.reasoningEffort) {
        throw new Error("Codex returned an invalid or unconfirmed model preset result.");
      }
      if (this.localSnapshotGeneration !== mutationGeneration) {
        const authoritative = this.authoritativeLocalModelPreset(localHost);
        if (authoritative) return authoritative;
        return await this.reconcileSupersededLocalModelPreset(lifecycleGeneration, localHost);
      }
      const current = this.localSnapshot;
      if (!localHost || this.localHost?.hostId !== localHost.hostId ||
          this.localHost.platform !== localHost.platform || !current ||
          current.host.hostId !== localHost.hostId || current.host.platform !== localHost.platform) {
        throw new Error("The captured Codex host changed before model preset confirmation.");
      }
      const catalogEntry = current.snapshot.modelCatalog?.find((entry) =>
        entry.modelId === parsed.modelId &&
        entry.supportedReasoningEfforts.includes(parsed.reasoningEffort));
      if (!catalogEntry) {
        throw new Error("The confirmed Codex model preset is absent from the authoritative catalog.");
      }
      this.localSnapshot = {
        ...current,
        snapshot: {
          ...current.snapshot,
          activeModelId: parsed.modelId,
          activeModelDisplayName: catalogEntry.displayName,
          reasoningEffort: parsed.reasoningEffort
        }
      };
      return parsed;
    } catch (error) {
      this.assertControllerLifecycle(lifecycleGeneration);
      try {
        if (this.refreshInFlight) await this.refreshInFlight;
        this.assertControllerLifecycle(lifecycleGeneration);
        await this.refresh();
        this.assertControllerLifecycle(lifecycleGeneration);
      } catch {
        // refresh() records degraded health; retain the original command error for the dial alert.
      }
      throw error;
    }
  }

  private authoritativeLocalModelPreset(localHost?: CodexHost): ModelPresetExecution | undefined {
    const current = this.localSnapshot;
    const modelId = current?.snapshot.activeModelId;
    const reasoningEffort = current?.snapshot.reasoningEffort;
    if (this.localHealth.state !== "ready" || localHost == null || current == null ||
        this.localHost?.hostId !== localHost.hostId || this.localHost.platform !== localHost.platform ||
        current.host.hostId !== localHost.hostId || current.host.platform !== localHost.platform ||
        typeof modelId !== "string" || !isSafeReasoningIdentifier(reasoningEffort)) {
      return undefined;
    }
    const catalogEntry = current.snapshot.modelCatalog?.find((entry) =>
      entry.modelId === modelId && entry.supportedReasoningEfforts.includes(reasoningEffort));
    if (!catalogEntry) return undefined;
    return { modelId, reasoningEffort };
  }

  private async reconcileSupersededLocalModelPreset(
    lifecycleGeneration: number,
    localHost?: CodexHost
  ): Promise<ModelPresetExecution> {
    if (this.refreshInFlight) {
      try { await this.refreshInFlight; }
      catch { /* A fresh refresh is still attempted below. */ }
    }
    this.assertControllerLifecycle(lifecycleGeneration);
    await this.refresh();
    this.assertControllerLifecycle(lifecycleGeneration);
    const authoritative = this.authoritativeLocalModelPreset(localHost);
    if (!authoritative) {
      throw new Error("Authoritative model preset state is unavailable after confirmation.");
    }
    return authoritative;
  }

  private async refreshDialUsage(route: DialHostRoute): Promise<void> {
    const localRequested = route.hostId != null
      ? route.hostId === this.localHost?.hostId
      : route.platform === this.localHost?.platform;
    if (localRequested) {
      if (this.localHealth.state !== "ready") {
        throw new Error("The captured Codex usage host is not ready.");
      }
      await this.refreshLocalUsage();
      return;
    }
    const remote = this.relayClient?.currentHost();
    if (!remote || (route.hostId != null
      ? remote.hostId !== route.hostId
      : remote.platform !== route.platform)) {
      throw new Error("The captured Codex usage host is no longer connected.");
    }
    if (!this.relayClient?.supportsCapabilityForSnapshot(
      "usage-refresh", remote.hostId, remote.platform
    )) {
      throw new Error("Remote Codex host does not support usage refresh.");
    }
    await this.relayClient.send({ kind: "usage-refresh" });
  }

  private async reportDialCommandError(
    registration: DialRegistration,
    error: unknown
  ): Promise<void> {
    streamDeck.logger.error(`Codex dial command failed (${registration.action.id}): ${String(error)}`);
    try { await registration.action.showAlert(); }
    catch (alertError) {
      streamDeck.logger.error(`Codex dial alert failed (${registration.action.id}): ${String(alertError)}`);
    }
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
    const toggleState = keycapId === "FAST" ? snapshot.fastModeEnabled : undefined;
    const image = await this.keycapImage(keycapId, snapshot.theme, toggleState);
    const current = this.targetSnapshot();
    const currentKeycapId = current?.layout.slots[slot]?.keycapId;
    const currentToggleState = currentKeycapId === "FAST" ? current?.fastModeEnabled : undefined;
    if (currentKeycapId !== keycapId || current?.theme !== snapshot.theme || currentToggleState !== toggleState) return;
    if (image) await this.setImage(action, image);
  }

  private async renderFixedAction(registration: FixedIconRegistration): Promise<void> {
    const snapshot = this.targetSnapshot();
    const theme = snapshot?.theme ?? "dark";
    const toggleState = registration.source.kind === "local" && registration.source.keycapId === "FAST"
      ? snapshot?.fastModeEnabled
      : undefined;
    const image = registration.source.kind === "builtin"
      ? renderBuiltinKeycap(registration.source.name, theme)
      : await this.keycapImage(registration.source.keycapId, theme, toggleState);
    const current = this.targetSnapshot();
    const currentTheme = current?.theme ?? "dark";
    const currentToggleState = registration.source.kind === "local" && registration.source.keycapId === "FAST"
      ? current?.fastModeEnabled
      : undefined;
    if (currentTheme !== theme || currentToggleState !== toggleState) return;
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
    const hold = this.resetHolds.get(action.id);
    const progress = hold == null
      ? 0
      : Math.min(1, (Date.now() - hold.startedAt) / RESET_HOLD_MS);
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

  private accountUsageSourceForHost(hostId: string): AccountUsageSource {
    if (hostId === this.localHost?.hostId) {
      return {
        health: this.localHealth,
        hostId,
        snapshot: this.localSnapshot?.snapshot
      };
    }
    const remoteSnapshot = this.relayClient?.currentSnapshot();
    if (remoteSnapshot?.host.hostId === hostId) {
      return {
        health: this.relayClient?.currentHealth() ?? {
          state: "offline", reason: "relay-disconnected", changedAt: Date.now()
        },
        hostId,
        snapshot: remoteSnapshot.snapshot
      };
    }
    return {
      health: { state: "offline", reason: "relay-disconnected", changedAt: Date.now() },
      hostId
    };
  }

  private hostRoute(hostId: string | undefined): DialHostRoute {
    if (hostId != null && hostId === this.localHost?.hostId) {
      return { kind: "host", hostId, platform: this.localHost.platform };
    }
    const remote = this.relayClient?.currentHost();
    if (hostId != null && hostId === remote?.hostId) {
      return { kind: "host", hostId, platform: remote.platform };
    }
    return { kind: "host", hostId, platform: this.targetPlatform };
  }

  private isRemoteTarget(): boolean {
    return this.localHost != null && this.targetPlatform !== this.localHost.platform;
  }

  private async sendRemote(
    command: RelayCommand
  ): Promise<ReasoningAdjustmentResult | ReasoningAdjustmentExecution | undefined> {
    if (!this.relayClient) throw new Error("Remote Codex relay is not configured.");
    return this.relayClient.send(command);
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

  private async runLocalMicroAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
    const refreshFastState = act === 1 &&
      this.localSnapshot?.snapshot.layout.slots[slot]?.keycapId === "FAST";
    await this.microBridge.sendAction(slot, act);
    if (refreshFastState) await this.refreshAfterFastActivation();
  }

  private async runLocalKeycap(keycapId: OfficialKeycapId): Promise<void> {
    await this.microBridge.runKeycap(keycapId);
    if (keycapId === "FAST") await this.refreshAfterFastActivation();
  }

  private async refreshAfterFastActivation(): Promise<void> {
    const precedingRefresh = this.refreshInFlight;
    if (precedingRefresh) {
      try { await precedingRefresh; }
      catch { /* The original refresh owner retains its failure; FAST still needs a newer snapshot. */ }
    }
    if (this.stopped) return;
    await this.refresh();
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
      try {
        await Promise.all([
          this.renderAnimatedAgents().catch((error) =>
            streamDeck.logger.error(`Agent animation frame failed: ${String(error)}`)),
          this.renderResetHolds().catch((error) =>
            streamDeck.logger.error(`Reset hold animation frame failed: ${String(error)}`))
        ]);
      }
      finally { this.scheduleAnimation(); }
    }, 200);
  }

  private keycapImage(
    keycapId: string,
    theme: "light" | "dark",
    toggleState?: boolean
  ): Promise<string | null> {
    const stateKey = toggleState == null ? "unknown" : toggleState ? "on" : "off";
    const cacheKey = `${theme}:${keycapId}:${stateKey}`;
    let pending = this.keycapImages.get(cacheKey);
    if (pending) return pending;
    pending = readFile(join(USER_ICON_ROOT, `${keycapId}.svg`), "utf8")
      .then((svg) => renderImportedKeycap(svg, theme, toggleState))
      .catch(() => renderFallbackKeycap(keycapId, theme, toggleState));
    this.keycapImages.set(cacheKey, pending);
    return pending;
  }
}

function parseReasoningExecution(value: unknown): ReasoningAdjustmentExecution | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const expected = ["outcome", ...(Object.prototype.hasOwnProperty.call(descriptors, "reasoningEffort")
      ? ["reasoningEffort"] : [])];
    if (keys.length !== expected.length || keys.some((key) =>
      typeof key !== "string" || !expected.includes(key))) return undefined;
    const outcomeProperty = descriptors.outcome;
    const effortProperty = descriptors.reasoningEffort;
    if (!outcomeProperty || outcomeProperty.enumerable !== true || !("value" in outcomeProperty) ||
        (effortProperty && (effortProperty.enumerable !== true || !("value" in effortProperty)))) {
      return undefined;
    }
    const outcome = outcomeProperty.value;
    const reasoningEffort = effortProperty?.value;
    if (outcome !== "applied" && outcome !== "blocked-ultra") return undefined;
    if (reasoningEffort !== undefined && !isSafeReasoningIdentifier(reasoningEffort)) return undefined;
    return {
      outcome,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort })
    };
  } catch { return undefined; }
}

function isAppliedReasoningExecutionWithUnconfirmedEffort(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const hasEffort = Object.prototype.hasOwnProperty.call(descriptors, "reasoningEffort");
    const expected = ["outcome", ...(hasEffort ? ["reasoningEffort"] : [])];
    if (keys.length !== expected.length || keys.some((key) =>
      typeof key !== "string" || !expected.includes(key))) return false;
    const outcomeProperty = descriptors.outcome;
    const effortProperty = descriptors.reasoningEffort;
    if (!outcomeProperty || outcomeProperty.enumerable !== true || !("value" in outcomeProperty) ||
        (effortProperty && (effortProperty.enumerable !== true || !("value" in effortProperty)))) {
      return false;
    }
    return outcomeProperty.value === "applied" &&
      (!effortProperty || !isSafeReasoningIdentifier(effortProperty.value));
  } catch { return false; }
}

function parseModelPresetExecution(value: unknown): ModelPresetExecution | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 2 || keys.some((key) =>
      key !== "modelId" && key !== "reasoningEffort")) return undefined;
    const modelProperty = descriptors.modelId;
    const effortProperty = descriptors.reasoningEffort;
    if (!modelProperty || !effortProperty || modelProperty.enumerable !== true ||
        effortProperty.enumerable !== true || !("value" in modelProperty) ||
        !("value" in effortProperty)) return undefined;
    if (!isSafeReasoningIdentifier(modelProperty.value, 128) ||
        !isSafeReasoningIdentifier(effortProperty.value, 64)) return undefined;
    return {
      modelId: modelProperty.value,
      reasoningEffort: effortProperty.value
    };
  } catch { return undefined; }
}

function reasoningResultOutcome(
  result: ReasoningAdjustmentResult | ReasoningAdjustmentExecution | undefined
): ReasoningAdjustmentResult | undefined {
  return typeof result === "string" ? result : result?.outcome;
}

function reasoningResultEffort(
  result: ReasoningAdjustmentResult | ReasoningAdjustmentExecution | undefined
): string | undefined {
  return typeof result === "object" ? result.reasoningEffort : undefined;
}
