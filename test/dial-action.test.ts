import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { DeckController } from "../src/controller.js";
import { CodexDialAction } from "../src/dial-action.js";
import { expandDialPreset, isDialBindingId } from "../src/dial-domain.js";

const text = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

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
  parentElement: FakeElement | null = null;
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  type = "";
  textContent = "";
  className = "";
  maxLength = -1;

  constructor(readonly tagName: string, readonly id = "") {}

  get options(): FakeElement[] {
    return this.descendants().filter(({ tagName }) => tagName === "OPTION");
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
    const elementPattern = /<(select|input|div|section|label|textarea)[^>]*\bid=["']([^"']+)["'][^>]*>/gi;
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
  open(): void;
  message(payload: unknown): void;
};

async function inspectorHarness(): Promise<{
  document: FakeDocument;
  sockets: FakeSocket[];
  connect: (...args: string[]) => void;
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

    constructor(readonly url: string) { sockets.push(this); }

    addEventListener(name: string, listener: (event: { data?: string }) => void): void {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    send(payload: string): void { this.sent.push(payload); }

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
  runInNewContext(script, { window, document, WebSocket: FakeWebSocket, JSON });
  const connect = window.connectElgatoStreamDeckSocket;
  assert.equal(typeof connect, "function");
  return {
    document,
    sockets,
    connect: connect as (...args: string[]) => void
  };
}

function field(document: FakeDocument, id: string): FakeElement {
  const element = document.getElementById(id);
  assert.ok(element, `missing #${id}`);
  return element;
}

function decodedMessages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

function adapterHarness(): { adapter: CodexDialAction; calls: ControllerCall[] } {
  const calls: ControllerCall[] = [];
  const controller = {
    registerDial(action: unknown, settings: unknown) { calls.push({ method: "register", action, payload: settings }); },
    updateDialSettings(action: unknown, settings: unknown) { calls.push({ method: "settings", action, payload: settings }); },
    unregisterDial(action: unknown) { calls.push({ method: "unregister", action }); },
    rotateDial(action: unknown, ticks: number) { calls.push({ method: "rotate", action, payload: ticks }); },
    async beginDialPress(action: unknown) { calls.push({ method: "down", action }); },
    async finishDialPress(action: unknown) { calls.push({ method: "up", action }); },
    async touchDial(action: unknown) { calls.push({ method: "touch", action }); }
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
    "selector-items", "wrap", "press", "touch-tap", "feedback", "static-label"
  ]) {
    assert.match(source, new RegExp(`id=["']${id}["']`));
  }
  assert.match(source, /setSettings/);
  assert.match(source, /version:\s*1/);
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
    { event: "registerPropertyInspector", uuid: "plugin-uuid" }
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
      event: "setSettings", context: "dial-preset", payload: expandDialPreset(id)
    });
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
    assert.equal(values.every((value) => isDialBindingId(value, gesture)), true, `${id} is allow-listed`);
    assert.equal(values.includes("usage.rate-limit-reset"), gesture === "press");
    assert.equal(values.includes("selector.activate"), gesture === "press");
  }
  const actionValues = field(document, "selector-items").descendants()
    .filter(({ tagName, type }) => tagName === "INPUT" && type === "checkbox")
    .map(({ dataset }) => dataset.binding ?? "");
  assert.ok(actionValues.length > 6);
  assert.equal(actionValues.every((value) => value !== "none" && isDialBindingId(value, "selector")), true);
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
  assert.equal(decodedMessages(sockets[0]!).slice(1).every(({ event }) => event === "setSettings"), true);
});

test("build wires every Encoder asset without executing the source-mutating generator", async () => {
  const source = await text("scripts/build.mjs");
  assert.match(source, /mkdir\(resolve\(output, "static\/layouts"\)/);
  for (const filename of ["dial.svg", "dial@2x.svg", "codex-dial.json", "codex-dial.html"]) {
    assert.match(source, new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
