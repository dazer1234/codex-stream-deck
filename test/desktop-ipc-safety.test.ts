import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexDesktopIpcBridge, encodeIpcFrame, IpcFrameReader } from "../src/codex-desktop-ipc.js";
import { parseRelayServerMessage } from "../src/relay-protocol.js";
import type { MicroSnapshot } from "../src/types.js";

const id = "019fe6f4-531d-7542-b696-c95718d96a2d";
function stream(change: unknown, version = 11) {
  return { type: "broadcast", method: "thread-stream-state-changed", version,
    sourceClientId: "owner", params: { hostId: "local", conversationId: id, change } };
}
const initial = () => stream({ type: "snapshot", revision: 1, conversationState: {
  title: "Current task", threadRuntimeStatus: { type: "active" }, requests: [], hasUnreadTurn: false
} });

async function withBridge(run: (bridge: CodexDesktopIpcBridge, queue: (message: unknown) => void) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "deck-ipc-safety-"));
  const socketPath = join(directory, "ipc.sock");
  const peers = new Set<net.Socket>();
  let queued: unknown[] = [];
  const server = net.createServer(socket => {
    peers.add(socket); socket.on("close", () => peers.delete(socket));
    const reader = new IpcFrameReader();
    socket.on("data", chunk => {
      for (const value of reader.push(chunk)) {
        const message = value as any;
        if (message.method === "initialize") {
          // Deliver changes before the response: refresh's round-trip provides deterministic ordering.
          for (const update of queued) socket.write(encodeIpcFrame(update));
          queued = [];
          socket.write(encodeIpcFrame({ type: "response", method: "initialize",
            requestId: message.requestId, resultType: "success", result: { clientId: "deck" } }));
        }
        if (message.method === "thread-stream-following-changed" && message.params.following) {
          socket.write(encodeIpcFrame(initial()));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const bridge = new CodexDesktopIpcBridge(() => {}, { socketPath, verifyApp: async () => {},
    readThreads: async () => [{ id, title: "Stored task", activityAt: 100 }] });
  try { await run(bridge, message => queued.push(message)); }
  finally {
    bridge.close();
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
}

test("IPC relay permits task-only snapshots and rejects invented composer/action authority", async () => {
  await withBridge(async bridge => {
    const snapshot = await bridge.refresh();
    const relay = (value: MicroSnapshot) => ({ type: "snapshot", protocol: 1,
      host: { hostId: "local", hostName: "Mac", platform: "darwin" }, observedAt: 100, snapshot: value });
    assert.ok(parseRelayServerMessage(relay(snapshot)));
    for (const extra of [{ reasoningEffort: "high" }, { activeModelId: "gpt-6-astra" },
      { activeThreadKey: id }, { fastModeEnabled: true }]) {
      assert.equal(parseRelayServerMessage(relay({ ...snapshot, ...extra })), null);
    }
    const officialAction = structuredClone(snapshot);
    officialAction.layout.slots.ACT06 = { keycapId: "FAST" };
    assert.equal(parseRelayServerMessage(relay(officialAction)), null);
    const command = structuredClone(snapshot);
    command.layout.slots.ACT06 = { keycapId: "UNAVAILABLE", commandId: "composer.toggleFastMode" };
    assert.equal(parseRelayServerMessage(relay(command)), null);
    const analog = structuredClone(snapshot);
    analog.layout.analogStick.up = { type: "command", commandId: "toggleSidebar" };
    assert.equal(parseRelayServerMessage(relay(analog)), null);
  });
});

for (const [name, update] of [
  ["unsupported stream version", stream({ type: "snapshot", revision: 2, conversationState: {
    threadRuntimeStatus: { type: "idle" }, requests: [] } }, 12)],
  ["root replacement patch", stream({ type: "patches", baseRevision: 1, revision: 2,
    patches: [{ op: "replace", path: [], value: { threadRuntimeStatus: { type: "idle" } } }] })],
  ["nested status patch", stream({ type: "patches", baseRevision: 1, revision: 2,
    patches: [{ op: "replace", path: ["threadRuntimeStatus", "type"], value: "idle" }] })],
  ["read-state change", { type: "broadcast", method: "thread-read-state-changed", version: 2,
    params: { hostId: "local", conversationId: id } }],
  ["owner disconnection", { type: "broadcast", method: "client-status-changed", version: 0,
    params: { clientId: "owner", status: "disconnected" } }]
] as const) {
  test(`IPC invalidates cached task status after ${name}`, async () => {
    await withBridge(async (bridge, queue) => {
      assert.equal((await bridge.refresh()).slots[0]?.status, "working");
      queue(update);
      assert.equal((await bridge.refresh()).slots[0]?.status, "error");
      queue(initial());
      assert.equal((await bridge.refresh()).slots[0]?.status, "working");
    });
  });
}

test("IPC ignores task-content patches while applying later ordered status patches", async () => {
  await withBridge(async (bridge, queue) => {
    await bridge.refresh();
    queue(stream({ type: "patches", baseRevision: 1, revision: 2,
      patches: [{ op: "add", path: ["turns", 0], value: { text: "private task content" } }] }));
    assert.equal((await bridge.refresh()).slots[0]?.status, "working");
    queue(stream({ type: "patches", baseRevision: 2, revision: 3, patches: [
      { op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } },
      { op: "replace", path: ["hasUnreadTurn"], value: true }
    ] }));
    const snapshot = await bridge.refresh();
    assert.equal(snapshot.slots[0]?.status, "unread");
    assert.equal(JSON.stringify(snapshot).includes("private task content"), false);
  });
});
