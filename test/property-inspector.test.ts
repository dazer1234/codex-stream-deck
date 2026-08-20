import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

type EventHandler = (event: { data?: string; target?: FakeInput }) => void;

class FakeInput {
  checked = false;
  disabled = true;
  readonly handlers = new Map<string, EventHandler>();

  addEventListener(event: string, handler: EventHandler): void {
    this.handlers.set(event, handler);
  }

  dispatchChange(): void {
    this.handlers.get("change")?.({ target: this });
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static latest?: FakeWebSocket;

  readyState = 0;
  readonly sent: string[] = [];
  readonly handlers = new Map<string, EventHandler>();

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
  }

  addEventListener(event: string, handler: EventHandler): void {
    this.handlers.set(event, handler);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  emit(event: string, data?: unknown): void {
    this.handlers.get(event)?.({ data: data == null ? undefined : JSON.stringify(data) });
  }
}

test("agent property inspector waits for and preserves complete global settings", async () => {
  const html = await readFile(new URL("../static/property-inspector/agent.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  const inputs = new Map([
    ["show-context-rings", new FakeInput()],
    ["focus-codex-on-agent-press", new FakeInput()]
  ]);
  const window: Record<string, unknown> = {};
  vm.runInNewContext(script, {
    document: { getElementById: (id: string) => inputs.get(id) },
    JSON,
    WebSocket: FakeWebSocket,
    window
  });

  const connect = window.connectElgatoStreamDeckSocket as
    (port: string, uuid: string, registerEvent: string) => void;
  connect("1234", "plugin-context", "registerPropertyInspector");

  const socket = FakeWebSocket.latest;
  assert.ok(socket);
  assert.equal(socket.url, "ws://127.0.0.1:1234");
  assert.equal(inputs.get("show-context-rings")?.disabled, true);
  assert.equal(inputs.get("focus-codex-on-agent-press")?.disabled, true);

  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  assert.deepEqual(socket.sent.map((message) => JSON.parse(message)), [
    { event: "registerPropertyInspector", uuid: "plugin-context" },
    { event: "getGlobalSettings", context: "plugin-context" }
  ]);

  inputs.get("show-context-rings")?.dispatchChange();
  assert.equal(socket.sent.length, 2);

  socket.emit("message", {
    event: "didReceiveGlobalSettings",
    payload: { settings: { unrelatedSetting: "preserved" } }
  });
  assert.equal(inputs.get("show-context-rings")?.disabled, false);
  assert.equal(inputs.get("focus-codex-on-agent-press")?.disabled, false);
  assert.equal(inputs.get("focus-codex-on-agent-press")?.checked, false);

  socket.emit("message", {
    event: "didReceiveGlobalSettings",
    payload: {
      settings: {
        showContextRings: true,
        focusCodexOnAgentPress: true,
        unrelatedSetting: "preserved"
      }
    }
  });
  assert.equal(inputs.get("focus-codex-on-agent-press")?.checked, true);

  const showContextRings = inputs.get("show-context-rings");
  assert.ok(showContextRings);
  showContextRings.checked = false;
  showContextRings.dispatchChange();
  assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? ""), {
    event: "setGlobalSettings",
    context: "plugin-context",
    payload: {
      showContextRings: false,
      focusCodexOnAgentPress: true,
      unrelatedSetting: "preserved"
    }
  });

  const focusCodexOnAgentPress = inputs.get("focus-codex-on-agent-press");
  assert.ok(focusCodexOnAgentPress);
  focusCodexOnAgentPress.checked = false;
  focusCodexOnAgentPress.dispatchChange();
  assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? ""), {
    event: "setGlobalSettings",
    context: "plugin-context",
    payload: {
      showContextRings: false,
      focusCodexOnAgentPress: false,
      unrelatedSetting: "preserved"
    }
  });

  socket.emit("close");
  assert.equal(showContextRings.disabled, true);
  assert.equal(inputs.get("focus-codex-on-agent-press")?.disabled, true);
});
