import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { DeckController } from "../src/controller.js";
import { CodexDialAction } from "../src/dial-action.js";
import {
  expandDialPreset, isDialBindingId, JOYSTICK_DIRECTIONS, MICRO_SLOTS, normalizeDialSettings
} from "../src/dial-domain.js";
import { OFFICIAL_KEYCAP_IDS } from "../src/keycaps.js";

const text = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const CODEX_DIAL_ACTION_UUID = "com.simeo.codex-deck.codex-dial";

type ManifestAction = {
  UUID: string;
  Controllers?: string[];
  Encoder?: {
    Icon?: string;
    layout?: string;
    TriggerDescription?: Record<string, string>;
  };
  PropertyInspectorPath?: string;
};

type ControllerCall = { method: string; action: unknown; payload?: unknown };

type FakeEvent = { target: FakeElement; preventDefault(): void };

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  readonly attributes = new Map<string, string>();
  parentElement: FakeElement | null = null;
  private currentValue = "";
  checked = false;
  disabled = false;
  draggable = false;
  hidden = false;
  type = "";
  textContent = "";
  className = "";
  maxLength = -1;
  htmlFor = "";

  constructor(readonly tagName: string, readonly id = "") {}

  get options(): FakeElement[] {
    return this.descendants().filter(({ tagName }) => tagName === "OPTION");
  }

  get value(): string { return this.currentValue; }

  set value(value: string) {
    const options = this.options;
    this.currentValue = this.tagName === "SELECT" && options.length > 0 &&
      !options.some((option) => option.value === value) ? "" : value;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0);
    this.append(...children);
  }

  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  dispatch(name: string): void {
    const event = { target: this, preventDefault() {} };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();

  constructor(source: string) {
    const elementPattern = /<(select|input|button|div|section|label|p|textarea)[^>]*\bid=["']([^"']+)["'][^>]*>/gi;
    for (const match of source.matchAll(elementPattern)) {
      const tagName = match[1]?.toUpperCase();
      const id = match[2];
      if (tagName && id) this.elements.set(id, new FakeElement(tagName, id));
    }
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toUpperCase());
  }
}

type FakeSocket = {
  url: string;
  readyState: number;
  sent: string[];
  closed: boolean;
  open(): void;
  close(): void;
  message(payload: unknown): void;
};

async function inspectorHarness(): Promise<{
  document: FakeDocument;
  sockets: FakeSocket[];
  connect: (...args: string[]) => void;
  connectRaw: (...args: unknown[]) => void;
  normalize: (input: unknown) => Record<string, unknown>;
}> {
  const source = await text("static/property-inspector/codex-dial.html");
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "inspector contains an executable script");
  const document = new FakeDocument(source);
  const sockets: FakeSocket[] = [];
  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    readonly sent: string[] = [];
    readyState = 0;
    closed = false;

    constructor(readonly url: string) { sockets.push(this); }

    addEventListener(name: string, listener: (event: { data?: string }) => void): void {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    send(payload: string): void { this.sent.push(payload); }

    close(): void {
      this.closed = true;
      this.readyState = 3;
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      for (const listener of this.listeners.get("open") ?? []) listener({});
    }

    message(payload: unknown): void {
      const event = { data: JSON.stringify(payload) };
      for (const listener of this.listeners.get("message") ?? []) listener(event);
    }
  }
  const window: Record<string, unknown> = {};
  runInNewContext(`${script}\nwindow.__normalizedSettings = normalizedSettings;`, {
    window, document, WebSocket: FakeWebSocket, JSON
  });
  const connectRaw = window.connectElgatoStreamDeckSocket;
  const normalize = window.__normalizedSettings;
  assert.equal(typeof connectRaw, "function");
  assert.equal(typeof normalize, "function");
  const connect = (...args: string[]): void => {
    const copy = [...args];
    try {
      const parsed = JSON.parse(copy[4] || "{}");
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
          !Object.hasOwn(parsed, "action")) parsed.action = CODEX_DIAL_ACTION_UUID;
      copy[4] = JSON.stringify(parsed);
    } catch {}
    (connectRaw as (...values: string[]) => void)(...copy);
  };
  return {
    document,
    sockets,
    connect,
    connectRaw: connectRaw as (...args: unknown[]) => void,
    normalize: normalize as (input: unknown) => Record<string, unknown>
  };
}

function field(document: FakeDocument, id: string): FakeElement {
  const element = document.getElementById(id);
  assert.ok(element, `missing #${id}`);
  return element;
}

function decodedMessages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => {
    const message = JSON.parse(payload) as Record<string, unknown>;
    if (message.event === "setSettings" || message.event === "sendToPlugin") {
      assert.equal(message.action, CODEX_DIAL_ACTION_UUID);
      delete message.action;
    }
    return message;
  });
}

function rawDecodedMessages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

const ALL_RUNTIME_BINDINGS = [
  "none", "selector.activate", "reasoning.decrease", "reasoning.increase", "new-task",
  "host.toggle", "usage.refresh", "usage.toggle-overview", "usage.rate-limit-reset",
  ...MICRO_SLOTS.map((slot) => `micro.${slot}`),
  ...JOYSTICK_DIRECTIONS.map((direction) => `joystick.${direction}`),
  ...OFFICIAL_KEYCAP_IDS.map((id) => `keycap.${id}`)
];

function runtimeBindings(gesture: "rotation" | "press" | "touch" | "selector"): string[] {
  return ALL_RUNTIME_BINDINGS.filter((value) => isDialBindingId(value, gesture)).sort();
}

function actionCheckboxes(document: FakeDocument): FakeElement[] {
  return field(document, "selector-items").descendants()
    .filter(({ tagName, type }) => tagName === "INPUT" && type === "checkbox");
}

function modelPresetRows(document: FakeDocument): FakeElement[] {
  return field(document, "model-preset-items").children;
}

const MODEL_CATALOG = [{
  modelId: "gpt-5.6-sol",
  displayName: "5.6 Sol",
  supportedReasoningEfforts: ["low", "medium", "high", "ultra"]
}, {
  modelId: "gpt-5.6-terra",
  displayName: "5.6 Terra",
  supportedReasoningEfforts: ["low", "medium", "high", "ultra"]
}];

function adapterHarness(): { adapter: CodexDialAction; calls: ControllerCall[] } {
  const calls: ControllerCall[] = [];
  const controller = {
    registerDial(action: unknown, settings: unknown) { calls.push({ method: "register", action, payload: settings }); },
    updateDialSettings(action: unknown, settings: unknown) { calls.push({ method: "settings", action, payload: settings }); },
    unregisterDial(action: unknown) { calls.push({ method: "unregister", action }); },
    rotateDial(action: unknown, ticks: number) { calls.push({ method: "rotate", action, payload: ticks }); },
    async beginDialPress(action: unknown) { calls.push({ method: "down", action }); },
    async finishDialPress(action: unknown) { calls.push({ method: "up", action }); },
    async touchDial(action: unknown) { calls.push({ method: "touch", action }); },
    registerDialPropertyInspector(action: unknown) { calls.push({ method: "pi-appear", action }); },
    unregisterDialPropertyInspector(action: unknown) { calls.push({ method: "pi-disappear", action }); },
    handleDialPropertyInspectorMessage(action: unknown, payload: unknown) {
      calls.push({ method: "pi-message", action, payload });
    }
  };
  return {
    adapter: new CodexDialAction(controller as unknown as DeckController),
    calls
  };
}

test("manifest adds exactly one Encoder-only Codex Dial and covers every declared action", async () => {
  const manifest = JSON.parse(await text("static/manifest.json")) as { Actions: ManifestAction[] };
  const uuids = manifest.Actions.map(({ UUID }) => UUID);
  const dials = manifest.Actions.filter(({ UUID }) => UUID === "com.simeo.codex-deck.codex-dial");
  const actionSources = await Promise.all([text("src/actions.ts"), text("src/dial-action.ts")]);
  const declaredUuids = [...actionSources.join("\n").matchAll(/@action\(\{ UUID: "([^"]+)" \}\)/g)]
    .map(([, uuid]) => uuid)
    .filter((uuid): uuid is string => uuid !== undefined);

  assert.equal(new Set(uuids).size, uuids.length, "every action UUID is unique");
  assert.deepEqual([...uuids].sort(), [...declaredUuids].sort(), "manifest and declared actions stay in parity");
  assert.equal(dials.length, 1);
  assert.deepEqual(dials[0]?.Controllers, ["Encoder"]);
  assert.equal(dials[0]?.Encoder?.Icon, "static/imgs/dial");
  assert.equal(dials[0]?.Encoder?.layout, "static/layouts/codex-dial.json");
  assert.equal(dials[0]?.PropertyInspectorPath, "static/property-inspector/codex-dial.html");
  assert.deepEqual(Object.keys(dials[0]?.Encoder?.TriggerDescription ?? {}).sort(), ["Push", "Rotate", "Touch"]);
  for (const action of manifest.Actions.filter(({ UUID }) => UUID !== "com.simeo.codex-deck.codex-dial")) {
    assert.deepEqual(action.Controllers, ["Keypad"], `${action.UUID} remains keypad-only`);
  }
});

test("Codex Dial adapter forwards all Encoder event families and ignores held touch", async () => {
  const { adapter, calls } = adapterHarness();
  const dial = { id: "dial-1", isDial: () => true };
  const settings = { version: 1, preset: "reasoning" };

  adapter.onWillAppear({ action: dial, payload: { settings } } as never);
  adapter.onDidReceiveSettings({ action: dial, payload: { settings } } as never);
  adapter.onDialRotate({ action: dial, payload: { ticks: -2 } } as never);
  await adapter.onDialDown({ action: dial } as never);
  await adapter.onDialUp({ action: dial } as never);
  await adapter.onTouchTap({ action: dial, payload: { hold: false } } as never);
  await adapter.onTouchTap({ action: dial, payload: { hold: true } } as never);
  adapter.onWillDisappear({ action: dial } as never);

  assert.equal(adapter.manifestId, "com.simeo.codex-deck.codex-dial");
  assert.deepEqual(calls.map(({ method }) => method), [
    "register", "settings", "rotate", "down", "up", "touch", "unregister"
  ]);
  assert.equal(calls[0]?.action, dial);
  assert.equal(calls[0]?.payload, settings);
  assert.equal(calls[2]?.payload, -2);
});

test("Codex Dial adapter forwards property inspector lifecycle and messages only for dials", () => {
  const { adapter, calls } = adapterHarness();
  const dial = { id: "dial-pi", isDial: () => true };
  const key = { id: "key-pi", isDial: () => false };
  const request = { kind: "request-model-catalog", requestGeneration: 7 };

  adapter.onPropertyInspectorDidAppear?.({ action: dial } as never);
  adapter.onSendToPlugin?.({ action: dial, payload: request } as never);
  adapter.onPropertyInspectorDidDisappear?.({ action: dial } as never);
  adapter.onPropertyInspectorDidAppear?.({ action: key } as never);
  adapter.onSendToPlugin?.({ action: key, payload: request } as never);
  adapter.onPropertyInspectorDidDisappear?.({ action: key } as never);

  assert.deepEqual(calls.map(({ method }) => method), ["pi-appear", "pi-message", "pi-disappear"]);
  assert.equal(calls[1]?.action, dial);
  assert.equal(calls[1]?.payload, request);
});

test("property inspector includes the exact action UUID in every settings and plugin frame", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({
      action: CODEX_DIAL_ACTION_UUID,
      context: "dial-action-frame",
      payload: { settings: expandDialPreset("reasoning") }
    })
  );
  sockets[0]?.open();
  field(document, "press").value = "host.toggle";
  field(document, "press").dispatch("change");
  const frames = rawDecodedMessages(sockets[0]!);
  assert.deepEqual(frames[1], {
    event: "sendToPlugin",
    action: CODEX_DIAL_ACTION_UUID,
    context: "plugin-uuid",
    payload: { kind: "request-model-catalog", requestGeneration: 1 }
  });
  assert.equal(frames.at(-1)?.event, "setSettings");
  assert.equal(frames.at(-1)?.action, CODEX_DIAL_ACTION_UUID);
});

test("missing or malformed action identity fails closed without losing local edits", async () => {
  let getterCalls = 0;
  const accessorActionInfo = Object.defineProperty({}, "action", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return CODEX_DIAL_ACTION_UUID;
    }
  });
  for (const actionInfo of [
    JSON.stringify({ context: "missing", payload: { settings: expandDialPreset("reasoning") } }),
    JSON.stringify({ action: "com.example.wrong", context: "wrong", payload: { settings: expandDialPreset("reasoning") } }),
    JSON.stringify({ action: 7, context: "typed", payload: { settings: expandDialPreset("reasoning") } }),
    "null",
    accessorActionInfo,
    { action: Symbol("codex-dial") }
  ]) {
    const { document, sockets, connectRaw } = await inspectorHarness();
    connectRaw("24680", "plugin-uuid", "registerPropertyInspector", "{}", actionInfo);
    sockets[0]?.open();
    field(document, "press").value = "host.toggle";
    field(document, "press").dispatch("change");
    assert.deepEqual(rawDecodedMessages(sockets[0]!), [
      { event: "registerPropertyInspector", uuid: "plugin-uuid" }
    ]);
    assert.equal(field(document, "press").value, "host.toggle", "failed send retains the local edit");
  }
  assert.equal(getterCalls, 0, "action accessors are never invoked");
});

test("reconnect resets action authority and stale sockets cannot send with an old action", async () => {
  const { document, sockets, connectRaw } = await inspectorHarness();
  connectRaw(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ action: CODEX_DIAL_ACTION_UUID, context: "valid", payload: { settings: expandDialPreset("reasoning") } })
  );
  connectRaw(
    "24681", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ action: "com.example.wrong", context: "invalid", payload: { settings: expandDialPreset("reasoning") } })
  );
  sockets[0]?.open();
  sockets[1]?.open();
  field(document, "press").value = "host.toggle";
  field(document, "press").dispatch("change");
  assert.deepEqual(rawDecodedMessages(sockets[0]!), []);
  assert.deepEqual(rawDecodedMessages(sockets[1]!), [
    { event: "registerPropertyInspector", uuid: "plugin-uuid" }
  ]);
});

test("property inspector keeps its registration context when host events carry an action context", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({
      action: CODEX_DIAL_ACTION_UUID,
      context: "stale-action-context",
      payload: { settings: expandDialPreset("model-presets") }
    })
  );
  sockets[0]?.open();
  sockets[0]?.message({
    action: CODEX_DIAL_ACTION_UUID,
    context: "current-action-context",
    event: "sendToPropertyInspector",
    payload: {
      kind: "model-catalog", requestGeneration: 1, catalogRevision: 1, available: true,
      hostId: "host-a", platform: "darwin", snapshotGeneration: 4,
      activeModelId: "gpt-5.6-sol", activeModelDisplayName: "5.6 Sol", reasoningEffort: "high",
      modelCatalog: MODEL_CATALOG
    }
  });
  field(document, "press").value = "host.toggle";
  field(document, "press").dispatch("change");
  const frames = rawDecodedMessages(sockets[0]!);
  assert.equal(frames.at(-1)?.event, "setSettings");
  assert.equal(frames.at(-1)?.context, "plugin-uuid");
});

test("property inspector uses its registration UUID instead of stale actionInfo context", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "current-inspector-context", "registerPropertyInspector", "{}",
    JSON.stringify({
      action: CODEX_DIAL_ACTION_UUID,
      context: "stale-action-context",
      payload: { settings: expandDialPreset("reasoning") }
    })
  );
  sockets[0]?.open();
  field(document, "press").value = "host.toggle";
  field(document, "press").dispatch("change");
  const frames = rawDecodedMessages(sockets[0]!);
  assert.equal(frames.at(-1)?.event, "setSettings");
  assert.equal(frames.at(-1)?.context, "current-inspector-context");
});

test("property inspector exposes the Model Presets editor and requests live authority", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  assert.match(await text("static/property-inspector/codex-dial.html"), /<option value="model-presets">Model Presets<\/option>/);
  for (const id of ["model-presets-panel", "model-preset-items", "add-model-preset", "model-catalog-status"]) field(document, id);
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-models", payload: { settings: expandDialPreset("model-presets") } })
  );
  sockets[0]?.open();
  assert.equal(field(document, "preset").value, "model-presets");
  assert.deepEqual(decodedMessages(sockets[0]!)[1], {
    event: "sendToPlugin",
    context: "plugin-uuid",
    payload: { kind: "request-model-catalog", requestGeneration: 1 }
  });
  assert.equal(field(document, "model-presets-panel").hidden, false);
  assert.match(field(document, "model-catalog-status").textContent, /unavailable|waiting|offline/i);
});

test("authoritative catalog seeds preferred pairs and editor persists complete unique v2 rows", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-seed", payload: { settings: expandDialPreset("model-presets") } })
  );
  sockets[0]?.open();
  sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: {
      kind: "model-catalog", requestGeneration: 1, catalogRevision: 1, available: true,
      hostId: "host-a", platform: "darwin", snapshotGeneration: 4,
      activeModelId: "gpt-5.6-sol", activeModelDisplayName: "5.6 Sol", reasoningEffort: "high",
      modelCatalog: MODEL_CATALOG
    }
  });
  assert.equal(modelPresetRows(document).length, 3);
  const seeded = decodedMessages(sockets[0]!).at(-1)?.payload as { version: number; modelPresets: unknown[] };
  assert.equal(seeded.version, 2);
  assert.deepEqual(seeded.modelPresets, [
    { modelId: "gpt-5.6-sol", reasoningEffort: "high" },
    { modelId: "gpt-5.6-sol", reasoningEffort: "medium" },
    { modelId: "gpt-5.6-terra", reasoningEffort: "medium" }
  ]);

  field(document, "add-model-preset").dispatch("click");
  assert.equal(modelPresetRows(document).length, 4);
  const last = decodedMessages(sockets[0]!).at(-1)?.payload as Record<string, unknown>;
  assert.equal(last.version, 2);
  assert.equal(last.preset, "model-presets");
  assert.deepEqual(last.rotation, { kind: "model-presets" });
  assert.equal(last.feedback, "model-presets");
  assert.equal(last.press, "none");
  assert.equal(last.touchTap, "keycap.FAST");

  const rows = modelPresetRows(document);
  const down = rows[0]?.descendants().find(({ tagName, dataset }) => tagName === "BUTTON" && dataset.direction === "down");
  assert.ok(down);
  down.dispatch("click");
  assert.match(down.getAttribute("aria-label") ?? "", /^Move .+ down$/);
  const remove = modelPresetRows(document)[0]?.descendants().find(({ tagName, dataset }) => tagName === "BUTTON" && dataset.action === "remove");
  assert.ok(remove);
  remove.dispatch("click");
  assert.equal(modelPresetRows(document).length, 3);
});

test("model preset catalog ordering is monotonic and saved unknown or Ultra rows survive offline filtering", async () => {
  const settings = {
    ...expandDialPreset("model-presets"),
    modelPresets: [
      { modelId: "gpt-unknown", reasoningEffort: "medium" },
      { modelId: "gpt-5.6-sol", reasoningEffort: "ultra" }
    ]
  };
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-stale", payload: { settings } })
  );
  sockets[0]?.open();
  assert.equal(modelPresetRows(document).length, 2, "saved rows render before catalog authority");
  sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: {
      kind: "model-catalog", requestGeneration: 1, catalogRevision: 5, available: true,
      hostId: "host-a", platform: "darwin", snapshotGeneration: 8,
      activeModelId: "gpt-5.6-sol", activeModelDisplayName: "5.6 Sol", reasoningEffort: "high",
      modelCatalog: MODEL_CATALOG
    }
  });
  const firstStatus = field(document, "model-catalog-status").textContent;
  assert.match(firstStatus, /host-a|connected/i);
  assert.equal(modelPresetRows(document).length, 2);
  const ultraEffort = modelPresetRows(document)[1]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "effort");
  assert.equal(ultraEffort?.value, "ultra", "disabled Ultra is preserved in an existing row");

  sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: { kind: "model-catalog", requestGeneration: 1, catalogRevision: 4, available: false }
  });
  assert.equal(field(document, "model-catalog-status").textContent, firstStatus, "stale revision is ignored");
  assert.equal(modelPresetRows(document).length, 2);
});

test("model preset editor caps twelve rows and rejects duplicate pairs", async () => {
  const settings = {
    ...expandDialPreset("model-presets"), customized: true,
    modelPresets: [{ modelId: "gpt-model", reasoningEffort: "high" }]
  };
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-cap-models", payload: { settings } })
  );
  sockets[0]?.open();
  const efforts = ["high", ...Array.from({ length: 14 }, (_, index) => `effort-${index}`)];
  sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: {
      kind: "model-catalog", requestGeneration: 1, catalogRevision: 1, available: true,
      hostId: "host-a", platform: "darwin", snapshotGeneration: 1,
      activeModelId: "gpt-model", activeModelDisplayName: "Model", reasoningEffort: "high",
      modelCatalog: [{ modelId: "gpt-model", displayName: "Model", supportedReasoningEfforts: efforts }]
    }
  });
  for (let index = 0; index < 20; index += 1) field(document, "add-model-preset").dispatch("click");
  assert.equal(modelPresetRows(document).length, 12);
  assert.equal(field(document, "add-model-preset").disabled, true);
  const persisted = decodedMessages(sockets[0]!).at(-1)?.payload as { modelPresets: Array<{ modelId: string; reasoningEffort: string }> };
  assert.equal(new Set(persisted.modelPresets.map(({ modelId, reasoningEffort }) => `${modelId}:${reasoningEffort}`)).size, 12);

  const secondEffort = modelPresetRows(document)[1]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "effort");
  assert.ok(secondEffort);
  secondEffort.value = "high";
  secondEffort.dispatch("change");
  const rerenderedSecond = modelPresetRows(document)[1]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "effort");
  assert.notEqual(rerenderedSecond?.value, "high", "a duplicate edit is reverted without persistence");
});

test("model presets preserve and edit independent press and touch controls", async () => {
  const settings = {
    ...expandDialPreset("model-presets"),
    customized: true,
    press: "host.toggle" as const,
    touchTap: "keycap.TIME" as const,
    modelPresets: [{ modelId: "gpt-model", reasoningEffort: "high" }]
  };
  const { document, sockets, connect, normalize } = await inspectorHarness();
  assert.equal(normalize({ ...settings, press: "selector.activate" }).press, "none");
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-model-gestures", payload: { settings } })
  );
  sockets[0]?.open();
  assert.equal(field(document, "press").value, "host.toggle");
  assert.equal(field(document, "touch-tap").value, "keycap.TIME");

  field(document, "press").value = "micro.ACT06";
  field(document, "press").dispatch("change");
  field(document, "touch-tap").value = "host.toggle";
  field(document, "touch-tap").dispatch("change");
  const payload = decodedMessages(sockets[0]!).at(-1)?.payload as Record<string, unknown>;
  assert.equal(payload.press, "micro.ACT06");
  assert.equal(payload.touchTap, "host.toggle");
  assert.deepEqual(normalizeDialSettings(payload), payload, "saved model preset settings remain runtime-valid");
});

test("model changes select a nonduplicate effort or visibly refuse the edit", async () => {
  const settings = {
    ...expandDialPreset("model-presets"), customized: true,
    modelPresets: [
      { modelId: "gpt-sol", reasoningEffort: "high" },
      { modelId: "gpt-terra", reasoningEffort: "high" },
      { modelId: "gpt-sol", reasoningEffort: "medium" }
    ]
  };
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-model-dupes", payload: { settings } })
  );
  sockets[0]?.open();
  sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: {
      kind: "model-catalog", requestGeneration: 1, catalogRevision: 1, available: true,
      hostId: "host-a", platform: "darwin", snapshotGeneration: 1,
      activeModelId: "gpt-sol", activeModelDisplayName: "Sol", reasoningEffort: "high",
      modelCatalog: [
        { modelId: "gpt-sol", displayName: "Sol", supportedReasoningEfforts: ["high", "medium", "low"] },
        { modelId: "gpt-terra", displayName: "Terra", supportedReasoningEfforts: ["high"] }
      ]
    }
  });
  const secondModel = modelPresetRows(document)[1]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "model");
  assert.ok(secondModel);
  secondModel.value = "gpt-sol";
  secondModel.dispatch("change");
  const changed = decodedMessages(sockets[0]!).at(-1)?.payload as {
    modelPresets: Array<{ modelId: string; reasoningEffort: string }>;
  };
  assert.deepEqual(changed.modelPresets[1], { modelId: "gpt-sol", reasoningEffort: "low" });
  assert.equal(new Set(changed.modelPresets.map(({ modelId, reasoningEffort }) => `${modelId}:${reasoningEffort}`)).size, 3);

  const onlyUsedSettings = {
    ...settings,
    modelPresets: [
      { modelId: "gpt-sol", reasoningEffort: "high" },
      { modelId: "gpt-sol", reasoningEffort: "medium" },
      { modelId: "gpt-sol", reasoningEffort: "low" },
      { modelId: "gpt-terra", reasoningEffort: "high" }
    ]
  };
  sockets[0]?.message({ event: "didReceiveSettings", payload: { settings: onlyUsedSettings } });
  const before = decodedMessages(sockets[0]!).length;
  const fourthModel = modelPresetRows(document)[3]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "model");
  assert.ok(fourthModel);
  fourthModel.value = "gpt-sol";
  fourthModel.dispatch("change");
  assert.equal(decodedMessages(sockets[0]!).length, before, "refused duplicate edit is not persisted");
  assert.equal(
    modelPresetRows(document)[3]?.descendants().find(({ tagName, dataset }) =>
      tagName === "SELECT" && dataset.field === "model")?.value,
    "gpt-terra"
  );
  assert.match(field(document, "model-editor-status").textContent, /duplicate|already configured/i);
});

test("first authoritative catalog falls back to its valid active pair when preferred pairs are absent", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-active-seed", payload: { settings: expandDialPreset("model-presets") } })
  );
  sockets[0]?.open();
  sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: {
      kind: "model-catalog", requestGeneration: 1, catalogRevision: 1, available: true,
      hostId: "host-a", platform: "darwin", snapshotGeneration: 1,
      activeModelId: "gpt-next", activeModelDisplayName: "Next", reasoningEffort: "xhigh",
      modelCatalog: [{ modelId: "gpt-next", displayName: "Next", supportedReasoningEfforts: ["medium", "xhigh"] }]
    }
  });
  const seeded = decodedMessages(sockets[0]!).at(-1)?.payload as {
    modelPresets: Array<{ modelId: string; reasoningEffort: string }>;
  };
  assert.deepEqual(seeded.modelPresets, [{ modelId: "gpt-next", reasoningEffort: "xhigh" }]);
  assert.equal(modelPresetRows(document).length, 1);

  const blocked = await inspectorHarness();
  blocked.connect(
    "24681", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-blocked-seed", payload: { settings: expandDialPreset("model-presets") } })
  );
  blocked.sockets[0]?.open();
  blocked.sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: {
      kind: "model-catalog", requestGeneration: 1, catalogRevision: 1, available: true,
      hostId: "host-a", platform: "darwin", snapshotGeneration: 1,
      activeModelId: "gpt-next", activeModelDisplayName: "Next", reasoningEffort: "ultra",
      modelCatalog: [{ modelId: "gpt-next", displayName: "Next", supportedReasoningEfforts: ["ultra"] }]
    }
  });
  assert.equal(modelPresetRows(blocked.document).length, 0, "Ultra-disabled active pair is not seeded");
  assert.equal(decodedMessages(blocked.sockets[0]!).filter(({ event }) => event === "setSettings").length, 0);
});

test("saved rows distinguish offline authority from catalog-proven unavailable efforts", async () => {
  const settings = {
    ...expandDialPreset("model-presets"), customized: true,
    modelPresets: [{ modelId: "gpt-sol", reasoningEffort: "xhigh" }]
  };
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-unavailable-effort", payload: { settings } })
  );
  sockets[0]?.open();
  let model = modelPresetRows(document)[0]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "model");
  let effort = modelPresetRows(document)[0]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "effort");
  assert.equal(model?.disabled, true);
  assert.equal(effort?.disabled, true);
  assert.match(model?.options[0]?.textContent ?? "", /unknown|offline/i);
  assert.match(effort?.options[0]?.textContent ?? "", /unknown|offline/i);

  sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: {
      kind: "model-catalog", requestGeneration: 1, catalogRevision: 1, available: true,
      hostId: "host-a", platform: "darwin", snapshotGeneration: 1,
      activeModelId: "gpt-sol", activeModelDisplayName: "Sol", reasoningEffort: "high",
      modelCatalog: [{ modelId: "gpt-sol", displayName: "Sol", supportedReasoningEfforts: ["low", "high"] }]
    }
  });
  model = modelPresetRows(document)[0]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "model");
  effort = modelPresetRows(document)[0]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "effort");
  assert.equal(model?.disabled, false);
  assert.equal(effort?.disabled, false);
  assert.equal(effort?.value, "xhigh");
  assert.match(effort?.options.find(({ value }) => value === "xhigh")?.textContent ?? "", /unavailable/i);

  sockets[0]?.message({
    event: "sendToPropertyInspector",
    payload: { kind: "model-catalog", requestGeneration: 1, catalogRevision: 2, available: false }
  });
  model = modelPresetRows(document)[0]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "model");
  effort = modelPresetRows(document)[0]?.descendants().find(({ tagName, dataset }) =>
    tagName === "SELECT" && dataset.field === "effort");
  assert.equal(model?.disabled, true);
  assert.equal(effort?.disabled, true);
  assert.equal(effort?.value, "xhigh", "offline transition preserves the saved effort");
});

test("each model preset row has labeled selects and an explicit draggable handle", async () => {
  const settings = {
    ...expandDialPreset("model-presets"), customized: true,
    modelPresets: [
      { modelId: "gpt-sol", reasoningEffort: "high" },
      { modelId: "gpt-terra", reasoningEffort: "medium" }
    ]
  };
  const { document, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-accessible-rows", payload: { settings } })
  );
  for (const [index, row] of modelPresetRows(document).entries()) {
    assert.equal(row.draggable, false, "the whole row is not an unlabeled drag target");
    const selects = row.descendants().filter(({ tagName }) => tagName === "SELECT");
    const labels = row.descendants().filter(({ tagName }) => tagName === "LABEL");
    assert.equal(selects.length, 2);
    assert.equal(new Set(selects.map(({ id }) => id)).size, 2);
    assert.equal(labels.some(({ htmlFor }) => htmlFor === selects[0]?.id), true);
    assert.equal(labels.some(({ htmlFor }) => htmlFor === selects[1]?.id), true);
    const handle = row.descendants().find(({ tagName, dataset }) =>
      tagName === "BUTTON" && dataset.action === "drag-handle");
    assert.ok(handle);
    assert.equal(handle.draggable, true);
    assert.match(handle.getAttribute("aria-label") ?? "", new RegExp(`Drag preset ${index + 1}`, "i"));
  }
});

test("Codex Dial registration paths reject non-dial actions", () => {
  const { adapter, calls } = adapterHarness();
  const key = { id: "key-1", isDial: () => false };

  adapter.onWillAppear({ action: key, payload: { settings: {} } } as never);
  adapter.onDidReceiveSettings({ action: key, payload: { settings: {} } } as never);

  assert.deepEqual(calls, []);
  assert.equal("onKeyDown" in adapter, false);
  assert.equal("onKeyUp" in adapter, false);
});

test("plugin registers Codex Dial exactly once", async () => {
  const source = await text("src/plugin.ts");
  assert.equal(source.match(/new CodexDialAction\(controller\)/g)?.length, 1);
});

test("custom layout has five unique typed keys inside the 200 by 100 Encoder canvas", async () => {
  const layout = JSON.parse(await text("static/layouts/codex-dial.json")) as {
    id: string;
    items: Array<{ key: string; type: string; rect: number[] }>;
  };
  const expectedTypes = new Map([
    ["accent", "bar"], ["detail", "text"], ["indicator", "bar"], ["title", "text"], ["value", "text"]
  ]);
  const keys = layout.items.map(({ key }) => key);

  assert.equal(layout.id, "com.simeo.codex-deck.codex-dial.layout");
  assert.equal(layout.items.length, 5);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), [...expectedTypes.keys()].sort());
  for (const { key, type, rect } of layout.items) {
    assert.equal(type, expectedTypes.get(key));
    assert.equal(rect.length, 4);
    const [x, y, width, height] = rect;
    assert.ok(x !== undefined && y !== undefined && width !== undefined && height !== undefined);
    assert.ok(x >= 0 && y >= 0 && width >= 0 && height >= 0);
    assert.ok(x + width <= 200 && y + height <= 100, `${key} stays within the Encoder canvas`);
  }
});

test("dial artwork and property inspector are self-contained", async () => {
  const [dial, dial2x, inspector] = await Promise.all([
    text("static/imgs/dial.svg"),
    text("static/imgs/dial@2x.svg"),
    text("static/property-inspector/codex-dial.html")
  ]);

  assert.match(dial, /width="72" height="72"/);
  assert.match(dial2x, /width="144" height="144"/);
  assert.doesNotMatch(`${dial}${dial2x}`, /<image|href=/i, "artwork does not embed third-party assets");
  assert.match(inspector, /connectElgatoStreamDeckSocket/);
  assert.match(inspector, /new WebSocket/);
});

test("property inspector exposes presets and independent gesture controls", async () => {
  const source = await text("static/property-inspector/codex-dial.html");
  for (const id of [
    "preset", "rotation-kind", "counter-clockwise", "clockwise", "selector-source",
    "selector-items", "wrap", "include-ultra", "press", "touch-tap", "feedback", "static-label"
  ]) {
    assert.match(source, new RegExp(`id=["']${id}["']`));
  }
  assert.match(source, />Include Ultra</);
  assert.match(source, /When off, clockwise reasoning stops below Ultra\. Manual Codex selection is unchanged\./);
  assert.match(source, /setSettings/);
  assert.match(source, /version:\s*2/);
  assert.match(source, /customized:\s*true/);
  assert.match(source, /usage\.rate-limit-reset/);
});

test("property inspector registers, initializes, reconnects, and accepts incoming settings", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-1", payload: { settings: expandDialPreset("agents") } })
  );
  assert.equal(sockets[0]?.url, "ws://127.0.0.1:24680");
  sockets[0]?.open();
  assert.deepEqual(decodedMessages(sockets[0]!), [
    { event: "registerPropertyInspector", uuid: "plugin-uuid" },
    {
      event: "sendToPlugin", context: "plugin-uuid",
      payload: { kind: "request-model-catalog", requestGeneration: 1 }
    }
  ]);
  assert.equal(field(document, "preset").value, "agents");
  assert.equal(field(document, "paired-controls").hidden, true);
  assert.equal(field(document, "selector-controls").hidden, false);

  connect(
    "24681", "plugin-uuid-2", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-2", payload: { settings: expandDialPreset("actions") } })
  );
  assert.equal(field(document, "preset").value, "actions");
  sockets[0]?.message({
    event: "didReceiveSettings",
    payload: { settings: expandDialPreset("usage") }
  });
  assert.equal(field(document, "preset").value, "actions", "an obsolete socket cannot overwrite a reconnect");
  sockets[1]?.message({
    event: "didReceiveSettings",
    payload: { settings: { ...expandDialPreset("custom"), staticLabel: "Build monitor" } }
  });
  assert.equal(field(document, "preset").value, "custom");
  assert.equal(field(document, "feedback").value, "static");
  assert.equal(field(document, "static-label").value, "Build monitor");
  assert.equal(field(document, "static-label-row").hidden, false);
});

test("every preset replaces the complete form and persists exact uncustomized defaults", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-preset", payload: { settings: {} } })
  );
  sockets[0]?.open();
  const preset = field(document, "preset");
  for (const id of ["reasoning", "agents", "actions", "navigation", "usage", "custom"] as const) {
    preset.value = id;
    preset.dispatch("change");
    const last = decodedMessages(sockets[0]!).at(-1);
    assert.deepEqual(last, {
      event: "setSettings", context: "plugin-uuid", payload: expandDialPreset(id)
    });
  }
});

test("incoming settings normalize exactly like the runtime before the next complete persistence", async () => {
  const inherited = Object.create({ version: 1, preset: "usage", customized: true });
  const selectorValues = runtimeBindings("selector");
  const cases: unknown[] = [
    null,
    [],
    "malformed",
    42,
    inherited,
    {
      version: 1,
      preset: "actions",
      includeUltraReasoning: true,
      customized: true,
      rotation: { kind: "selector", source: "actions", wrap: "yes", items: ["micro.ACT07"] },
      press: "shell.command",
      feedback: "neon"
    },
    {
      version: 1,
      preset: "usage",
      includeUltraReasoning: "true",
      rotation: { kind: "paired", counterClockwise: "shell.command" },
      press: "usage.rate-limit-reset",
      touchTap: "usage.rate-limit-reset",
      feedback: "static",
      staticLabel: `  ${"x".repeat(50)}  `
    },
    {
      version: 1,
      preset: "custom",
      includeUltraReasoning: false,
      customized: true,
      rotation: {
        kind: "selector",
        source: "actions",
        wrap: false,
        items: [...selectorValues, selectorValues[0], "shell.command"]
      },
      press: "host.toggle",
      touchTap: "keycap.APPS",
      feedback: "auto"
    }
  ];

  for (const [index, input] of cases.entries()) {
    const { document, sockets, connect } = await inspectorHarness();
    connect(
      "24680", "plugin-uuid", "registerPropertyInspector", "{}",
      JSON.stringify({ context: `dial-normalize-${index}`, payload: { settings: input } })
    );
    sockets[0]?.open();
    assert.equal(
      field(document, "include-ultra").checked,
      normalizeDialSettings(input).includeUltraReasoning,
      `case ${index} applies the normalized Ultra setting`
    );
    field(document, "press").dispatch("change");
    const last = decodedMessages(sockets[0]!).at(-1);
    assert.deepEqual(last, {
      event: "setSettings",
      context: "plugin-uuid",
      payload: { ...normalizeDialSettings(input), customized: true }
    }, `case ${index} matches runtime normalization`);
  }
});

test("incoming Ultra settings update the checkbox and complete form payload", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-ultra", payload: { settings: expandDialPreset("reasoning") } })
  );
  sockets[0]?.open();

  const checkbox = field(document, "include-ultra");
  assert.equal(checkbox.checked, false);
  sockets[0]?.message({
    event: "didReceiveSettings",
    payload: { settings: { ...expandDialPreset("reasoning"), includeUltraReasoning: true } }
  });
  assert.equal(checkbox.checked, true);

  checkbox.checked = false;
  checkbox.dispatch("change");
  assert.deepEqual(decodedMessages(sockets[0]!).at(-1), {
    event: "setSettings",
    context: "plugin-uuid",
    payload: { ...expandDialPreset("reasoning"), includeUltraReasoning: false, customized: true }
  });
});

test("property inspector ignores inherited Ultra settings exactly like runtime normalization", async () => {
  const harness = await inspectorHarness();
  const { includeUltraReasoning: _omitted, ...ownSettings } = expandDialPreset("reasoning");
  const inheritedUltra = Object.assign(
    Object.create({ includeUltraReasoning: true }) as Record<string, unknown>,
    ownSettings
  );
  assert.equal(Object.hasOwn(inheritedUltra, "includeUltraReasoning"), false);

  const inspectorNormalized = JSON.parse(
    JSON.stringify(harness.normalize(inheritedUltra))
  ) as Record<string, unknown>;
  assert.equal(inspectorNormalized.includeUltraReasoning, false);
  assert.deepEqual(inspectorNormalized, normalizeDialSettings(inheritedUltra));
});

test("Ultra preference survives unrelated edits and remains persisted while hidden", async () => {
  const settings = { ...expandDialPreset("reasoning"), includeUltraReasoning: true };
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-ultra-retain", payload: { settings } })
  );
  sockets[0]?.open();

  const row = field(document, "include-ultra-row");
  assert.equal(row.hidden, false);
  field(document, "press").dispatch("change");
  assert.equal((decodedMessages(sockets[0]!).at(-1)?.payload as { includeUltraReasoning: boolean }).includeUltraReasoning, true);

  const clockwise = field(document, "clockwise");
  clockwise.value = "joystick.right";
  clockwise.dispatch("change");
  assert.equal(row.hidden, true);
  assert.equal(field(document, "include-ultra").checked, true);
  assert.equal((decodedMessages(sockets[0]!).at(-1)?.payload as { includeUltraReasoning: boolean }).includeUltraReasoning, true);

  const press = field(document, "press");
  press.value = "host.toggle";
  press.dispatch("change");
  const hiddenEditPayload = decodedMessages(sockets[0]!).at(-1)?.payload as {
    includeUltraReasoning: boolean;
    press: string;
  };
  assert.equal(hiddenEditPayload.press, "host.toggle");
  assert.equal(hiddenEditPayload.includeUltraReasoning, true);

  const counterClockwise = field(document, "counter-clockwise");
  counterClockwise.value = "reasoning.increase";
  counterClockwise.dispatch("change");
  assert.equal(row.hidden, false, "either paired direction may contain reasoning increase");

  const preset = field(document, "preset");
  preset.value = "navigation";
  preset.dispatch("change");
  assert.equal(field(document, "include-ultra").checked, false);
  assert.equal((decodedMessages(sockets[0]!).at(-1)?.payload as { includeUltraReasoning: boolean }).includeUltraReasoning, false);
});

test("null, array, and primitive socket payloads are ignored without losing current settings", async () => {
  for (const actionInfo of ["null", "[]", '"primitive"', "7"]) {
    const harness = await inspectorHarness();
    assert.doesNotThrow(() => harness.connect(
      "24680", "plugin-uuid", "registerPropertyInspector", "{}", actionInfo
    ));
    assert.equal(field(harness.document, "preset").value, "reasoning");
  }

  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-safe", payload: { settings: expandDialPreset("actions") } })
  );
  for (const message of [null, [], "primitive", 7, { event: "didReceiveSettings", payload: null }]) {
    assert.doesNotThrow(() => sockets[0]?.message(message));
    assert.equal(field(document, "preset").value, "actions");
  }
});

test("gesture catalogs contain only runtime-valid values and keep reset press-only", async () => {
  const { document } = await inspectorHarness();
  const cases = [
    ["counter-clockwise", "rotation"],
    ["clockwise", "rotation"],
    ["press", "press"],
    ["touch-tap", "touch"]
  ] as const;
  for (const [id, gesture] of cases) {
    const values = field(document, id).options.map(({ value }) => value);
    assert.ok(values.length > 0, `${id} has options`);
    assert.equal(new Set(values).size, values.length, `${id} has no duplicate values`);
    const expected = gesture === "press"
      ? runtimeBindings(gesture).filter((value) => value !== "selector.activate")
      : runtimeBindings(gesture);
    assert.deepEqual([...values].sort(), expected, `${id} covers the applicable runtime catalog exactly`);
    assert.equal(values.includes("usage.rate-limit-reset"), gesture === "press");
    assert.equal(values.includes("selector.activate"), false);
  }
  const actionValues = actionCheckboxes(document)
    .map(({ dataset }) => dataset.binding ?? "");
  assert.ok(actionValues.length > 6);
  assert.deepEqual([...actionValues].sort(), runtimeBindings("selector"));
});

test("property inspector offers selector activation only in selector mode and safely clears it for paired", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-mode-switch", payload: { settings: expandDialPreset("agents") } })
  );
  sockets[0]?.open();
  const press = field(document, "press");
  assert.equal(press.value, "selector.activate");
  assert.equal(press.options.some(({ value }) => value === "selector.activate"), true);

  const rotationKind = field(document, "rotation-kind");
  rotationKind.value = "paired";
  rotationKind.dispatch("change");

  assert.equal(press.options.some(({ value }) => value === "selector.activate"), false);
  assert.equal(press.value, "none");
  const payload = decodedMessages(sockets[0]!).at(-1)?.payload;
  assert.deepEqual(payload, {
    ...expandDialPreset("agents"),
    customized: true,
    rotation: { kind: "paired", counterClockwise: "none", clockwise: "none" },
    press: "none"
  });
  assert.deepEqual(normalizeDialSettings(payload), payload);

  rotationKind.value = "selector";
  rotationKind.dispatch("change");
  assert.equal(press.options.some(({ value }) => value === "selector.activate"), true);
  assert.equal(press.value, "none");
});

test("action selection cap is visible, reversible, and accessible", async () => {
  const items = runtimeBindings("selector").slice(0, 30);
  const settings = {
    ...expandDialPreset("custom"),
    rotation: { kind: "selector", source: "actions", wrap: true, items }
  };
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-cap", payload: { settings } })
  );
  sockets[0]?.open();

  let checkboxes = actionCheckboxes(document);
  assert.equal(checkboxes.filter(({ checked }) => checked).length, 30);
  assert.equal(checkboxes.filter(({ checked }) => !checked).every(({ disabled }) => disabled), true);
  assert.match(field(document, "selector-items-status").textContent, /30.*30/i);
  for (const row of field(document, "selector-items").children) {
    const checkbox = row.descendants().find(({ tagName }) => tagName === "INPUT");
    const label = row.descendants().find(({ tagName }) => tagName === "LABEL");
    assert.ok(checkbox?.id);
    assert.equal(label?.htmlFor, checkbox.id);
    for (const button of row.descendants().filter(({ tagName }) => tagName === "BUTTON")) {
      assert.match(button.getAttribute("aria-label") ?? "", /^Move .+ (up|down)$/);
    }
  }

  const selected = checkboxes.find(({ checked }) => checked);
  assert.ok(selected);
  selected.checked = false;
  selected.dispatch("change");
  checkboxes = actionCheckboxes(document);
  assert.equal(checkboxes.filter(({ checked }) => checked).length, 29);
  assert.equal(checkboxes.filter(({ checked }) => !checked).every(({ disabled }) => !disabled), true);
  assert.match(field(document, "selector-items-status").textContent, /29.*30/i);

  const unselected = checkboxes.find(({ checked }) => !checked);
  assert.ok(unselected);
  unselected.checked = true;
  unselected.dispatch("change");
  const last = decodedMessages(sockets[0]!).at(-1);
  assert.equal((last?.payload as { rotation: { items: string[] } }).rotation.items.length, 30);
  checkboxes = actionCheckboxes(document);
  assert.equal(checkboxes.filter(({ checked }) => !checked).every(({ disabled }) => disabled), true);
});

test("pre-open edits flush only the latest complete settings after registration", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-pending", payload: { settings: expandDialPreset("reasoning") } })
  );
  field(document, "preset").value = "actions";
  field(document, "preset").dispatch("change");
  field(document, "feedback").value = "static";
  field(document, "feedback").dispatch("change");
  assert.deepEqual(decodedMessages(sockets[0]!), []);
  sockets[0]?.open();
  assert.deepEqual(decodedMessages(sockets[0]!), [
    { event: "registerPropertyInspector", uuid: "plugin-uuid" },
    {
      event: "sendToPlugin", context: "plugin-uuid",
      payload: { kind: "request-model-catalog", requestGeneration: 1 }
    },
    {
      event: "setSettings",
      context: "plugin-uuid",
      payload: { ...expandDialPreset("actions"), feedback: "static", customized: true }
    }
  ]);
});

test("reconnect closes the replaced socket and ignores its late callbacks", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-old", payload: { settings: expandDialPreset("reasoning") } })
  );
  connect(
    "24681", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-new", payload: { settings: expandDialPreset("usage") } })
  );
  assert.equal(sockets[0]?.closed, true);
  sockets[0]?.open();
  sockets[0]?.message({ event: "didReceiveSettings", payload: { settings: expandDialPreset("agents") } });
  assert.equal(field(document, "preset").value, "usage");
  assert.deepEqual(decodedMessages(sockets[0]!), []);
});

test("custom edits serialize ordering, visibility, limits, and only setSettings messages", async () => {
  const { document, sockets, connect } = await inspectorHarness();
  connect(
    "24680", "plugin-uuid", "registerPropertyInspector", "{}",
    JSON.stringify({ context: "dial-custom", payload: { settings: expandDialPreset("actions") } })
  );
  sockets[0]?.open();

  const selectorItems = field(document, "selector-items");
  const approveRow = selectorItems.children.find((row) =>
    row.descendants().some(({ dataset }) => dataset.binding === "micro.ACT07"));
  const up = approveRow?.descendants().find(({ tagName, dataset }) =>
    tagName === "BUTTON" && dataset.direction === "up");
  assert.ok(up);
  up.dispatch("click");
  let last = decodedMessages(sockets[0]!).at(-1);
  assert.deepEqual((last?.payload as { rotation: { items: string[] } }).rotation.items.slice(0, 2), [
    "micro.ACT07", "micro.ACT06"
  ]);
  assert.equal((last?.payload as { customized: boolean }).customized, true);

  const rotationKind = field(document, "rotation-kind");
  rotationKind.value = "paired";
  rotationKind.dispatch("change");
  assert.equal(field(document, "paired-controls").hidden, false);
  assert.equal(field(document, "selector-controls").hidden, true);

  const feedback = field(document, "feedback");
  feedback.value = "static";
  feedback.dispatch("change");
  assert.equal(field(document, "static-label-row").hidden, false);
  const label = field(document, "static-label");
  label.value = "x".repeat(70);
  label.dispatch("input");
  last = decodedMessages(sockets[0]!).at(-1);
  assert.equal((last?.payload as { staticLabel: string }).staticLabel, "x".repeat(40));

  rotationKind.value = "selector";
  rotationKind.dispatch("change");
  field(document, "selector-source").value = "actions";
  field(document, "selector-source").dispatch("change");
  for (const checkbox of selectorItems.descendants().filter(({ tagName, type }) =>
    tagName === "INPUT" && type === "checkbox")) {
    checkbox.checked = true;
    checkbox.dispatch("change");
  }
  last = decodedMessages(sockets[0]!).at(-1);
  assert.equal((last?.payload as { rotation: { items: string[] } }).rotation.items.length, 30);
  assert.equal(decodedMessages(sockets[0]!).slice(2).every(({ event }) => event === "setSettings"), true);
});

test("build script wiring declares every Encoder asset without running the build", async () => {
  const source = await text("scripts/build.mjs");
  assert.match(source, /mkdir\(resolve\(output, "static\/layouts"\)/);
  for (const filename of ["dial.svg", "dial@2x.svg", "codex-dial.json", "codex-dial.html"]) {
    assert.match(source, new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Stream Deck Plus guide documents the supported dial contract without overstating coverage", async () => {
  const [readme, guide, macos, windows, changelog] = await Promise.all([
    text("README.md"), text("docs/STREAM_DECK_PLUS.md"), text("docs/MACOS.md"), text("docs/WINDOWS.md"),
    text("CHANGELOG.md")
  ]);

  assert.match(readme, /\[Stream Deck \+ guide\]\(docs\/STREAM_DECK_PLUS\.md\)/);
  assert.match(macos, /\[Stream Deck \+ guide\]\(STREAM_DECK_PLUS\.md\)/);
  assert.match(windows, /\[Stream Deck \+ guide\]\(STREAM_DECK_PLUS\.md\)/);
  assert.match(macos, /recommended Model Presets, Agents, Actions, and Usage presets/i);
  assert.match(changelog, /`SWITCHING…`[^.\n]*pre-confirmation/i);
  assert.match(changelog, /active-position[^.\n]*`UNLISTED`[^.\n]*confirmed/i);
  assert.doesNotMatch(changelog, /confirmed-only `SWITCHING…`/i);

  for (const label of ["Model Presets", "Reasoning", "Agents", "Actions", "Usage"]) {
    assert.match(guide, new RegExp(`\\b${label}\\b`));
  }
  for (const gesture of ["rotate", "press", "touch"]) assert.match(guide, new RegExp(`\\b${gesture}\\b`, "i"));
  for (const state of ["NO ITEMS", "OFFLINE", "DEGRADED", "CONNECTING"]) assert.match(guide, new RegExp(state));
  assert.match(guide, /Reasoning[^\n]*decrease[^\n]*increase/i);
  assert.ok(guide.includes(
    "The Reasoning knob redraws as soon as Codex confirms the resulting level after a short, bounded confirmation. " +
    "The normal 1.2-second background poll remains a reconciliation path, not the primary feedback path. " +
    "If the command fails or confirmation is missing, the dial retains the last authoritative level instead of predicting a new one."
  ));
  assert.match(guide, /Include Ultra[^.\n]*per knob[^.\n]*defaults off/i);
  assert.match(guide, /When Include Ultra is off[^.\n]*stops before Ultra[^.\n]*`ULTRA OFF`/i);
  assert.match(guide, /When Include Ultra is on[^.\n]*Ultra[^.\n]*native Full-access confirmation/i);
  assert.match(guide, /Manual Codex selection[^.\n]*keypad Reasoning Up[^.\n]*unrestricted/i);
  assert.match(guide, /never confirms or dismisses[^.\n]*native dialog/i);
  assert.match(guide, /Model Presets[^\n]*immediately[^\n]*detent[^\n]*wrap/i);
  assert.match(guide, /5\.6 Sol[^\n]*High[^\n]*5\.6 Sol[^\n]*Medium[^\n]*5\.6 Terra[^\n]*Medium/i);
  assert.match(guide, /live model[^.\n]*reasoning dropdowns[^.\n]*per knob/i);
  assert.match(guide, /add[^.\n]*remove[^.\n]*(?:drag|move)[^.\n]*reorder/i);
  assert.match(guide, /`SWITCHING…`[^.\n]*before[^.\n]*confirmed/i);
  assert.match(guide, /confirmed pair[^.\n]*(?:position|[0-9]+\s*\/\s*[0-9]+)/i);
  assert.match(guide, /`UNLISTED`[^.\n]*actual pair/i);
  assert.match(guide, /`NO PRESETS`[^.\n]*empty/i);
  assert.match(guide, /`UNAVAILABLE`[^.\n]*authoritative catalog/i);
  assert.match(guide, /unavailable entries[^.\n]*preserved[^.\n]*skipped/i);
  assert.match(guide, /Include Ultra[^.\n]*Model Presets[^.\n]*defaults off/i);
  assert.match(guide, /does not use[^.\n]*keyboard[^.\n]*focus navigation/i);
  assert.match(guide, /Press[^.\n]*None[^.\n]*Touch[^.\n]*Fast Mode/i);
  assert.match(guide, /remote host[^.\n]*`model-presets` capability/i);
  assert.match(guide, /Agents[^\n]*occupied agent[^\n]*focus[^\n]*M\/W host badge/i);
  assert.match(guide, /Actions[^\n]*Fast[^\n]*Approve[^\n]*Reject[^\n]*Fork[^\n]*Dictation[^\n]*Send[^\n]*Settings/i);
  assert.match(guide, /six action names[^.\n]*default slot labels/i);
  assert.match(guide, /feedback labels follow[^.\n]*current Codex Micro assignments/i);
  assert.match(guide, /Usage[^\n]*Auto[^\n]*5h[^\n]*Weekly/i);
  assert.match(guide, /day\/hour\/minute[^.\n]*`RESETS IN 5D 5H 48M`/i);
  assert.match(guide, /same formatter[^.\n]*Auto[^.\n]*5-hour[^.\n]*Weekly/i);
  assert.match(guide, /empty selector shows `NO ITEMS`/i);
  assert.doesNotMatch(guide, /empty selector[^.\n]*(?:may|UNAVAILABLE)/i);
  assert.match(guide, /1\.2.second hold/i);
  assert.match(guide, /RESET COMPLETE[^.\n]*green/i);
  assert.doesNotMatch(guide, /successful use shows the standard success indicator/i);
  assert.match(guide, /REASONING[^\n]*UNAVAILABLE/);
  assert.match(guide, /healthy local usage[^.\n]*unavailable[^.\n]*healthy paired host/i);
  assert.match(guide, /new command starts require a healthy, applicable route/i);
  assert.match(guide, /cleanup release[^.\n]*may still be attempted/i);
  assert.doesNotMatch(guide, /a command is not sent through stale display-only data/i);
  assert.match(guide, /macOS/);
  assert.match(guide, /Windows[^.\n]*(?:CI|build)[^.\n]*not[^.\n]*physical-device/i);
  assert.doesNotMatch(guide, /physically (?:tested|verified)[^.\n]*Windows/i);
});
