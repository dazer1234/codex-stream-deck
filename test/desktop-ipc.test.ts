import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import test from "node:test";
import { CodexDesktopIpcBridge, encodeIpcFrame, IpcFrameReader, projectIpcStatus } from "../src/codex-desktop-ipc.js";
import { CodexMicroRendererBridge, DebugBridgeUnavailableError } from "../src/codex-micro-renderer-bridge.js";

const threadId = "019fe6f4-531d-7542-b696-c95718d96a2d";

test("IPC frames survive fragmented and coalesced socket reads, reject oversized frames", () => {
  const reader = new IpcFrameReader();
  const frame = encodeIpcFrame({ type: "response", requestId: "1" });
  assert.deepEqual(reader.push(frame.subarray(0, 2)), []);
  assert.deepEqual(reader.push(Buffer.concat([frame.subarray(2), frame])), [
    { type: "response", requestId: "1" }, { type: "response", requestId: "1" }
  ]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(64 * 1024 * 1024);
  assert.throws(() => reader.push(oversized), /large/);
});

test("IPC status projection keeps activity and pending input, never retains task content or claims composer authority", () => {
  assert.equal(projectIpcStatus({ threadRuntimeStatus: { type: "active" }, requests: [], hasUnreadTurn: false }), "working");
  assert.equal(projectIpcStatus({ threadRuntimeStatus: { type: "idle" }, requests: [], hasUnreadTurn: true }), "unread");
  assert.equal(projectIpcStatus({ threadRuntimeStatus: { type: "active" }, requests: [{}] }), "awaiting-response");
  assert.equal(projectIpcStatus({ threadRuntimeStatus: { type: "future-unknown" }, requests: [] }), "error");
});

test("normal-launch IPC supplies live slots and clears them on disconnect; reconnect requests fresh snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deck-ipc-"));
  const path = join(dir, "ipc.sock");
  const peers = new Set<net.Socket>();
  let subscriptions = 0;
  let revision = 1;
  const server = net.createServer(socket => {
    peers.add(socket); socket.on("close", () => peers.delete(socket));
    const reader = new IpcFrameReader();
    socket.on("data", chunk => {
      for (const message of reader.push(chunk)) {
        const m = message as any;
        if (m.method === "initialize") socket.write(encodeIpcFrame({ type: "response", method: "initialize",
          requestId: m.requestId, resultType: "success", result: { clientId: "deck" } }));
        if (m.method === "thread-stream-following-changed" && m.params.following) {
          subscriptions++;
          socket.write(encodeIpcFrame({ type: "broadcast", method: "thread-stream-state-changed", version: 11,
            sourceClientId: "owner", params: { hostId: "local", conversationId: threadId,
              change: { type: "snapshot", revision, conversationState: {
                title: "Live task", threadRuntimeStatus: { type: "active", activeFlags: [] }, requests: [],
                latestModel: "gpt-6-astra", latestReasoningEffort: "high", turns: [{ secret: "discard" }]
              } } } }));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const bridge = new CodexDesktopIpcBridge(() => {}, { socketPath: path,
    readThreads: async () => [{ id: threadId, title: "Stored task", activityAt: 100 }],
    verifyApp: async () => {} });
  try {
    const snapshot = await bridge.refresh();
    assert.equal(snapshot.slots[0]?.status, "working");
    assert.equal(snapshot.slots[0]?.title, "Live task");
    assert.equal(snapshot.transport, "desktop-ipc");
    assert.equal(snapshot.activeModelId, undefined);
    assert.equal(snapshot.activeThreadKey, undefined);
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
    const patch = (baseRevision: number, nextRevision: number, path: string[], value: unknown, version = 11) => {
      for (const socket of peers) socket.write(encodeIpcFrame({ type: "broadcast", method: "thread-stream-state-changed",
        version, sourceClientId: "owner", params: { hostId: "local", conversationId: threadId,
          change: { type: "patches", baseRevision, revision: nextRevision, patches: [{ op: "replace", path, value }] } } }));
    };
    patch(1, 2, ["threadRuntimeStatus"], { type: "idle" });
    assert.equal((await bridge.refresh()).slots[0]?.status, "idle");
    patch(2, 3, ["hasUnreadTurn"], true);
    assert.equal((await bridge.refresh()).slots[0]?.status, "unread");
    patch(1, 4, ["threadRuntimeStatus"], { type: "active" });
    assert.equal((await bridge.refresh()).slots[0]?.status, "error", "revision gaps clear stale status");
    revision = 4;
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await bridge.refresh()).slots[0]?.status, "working");
    assert.equal(subscriptions, 2);
  } finally {
    bridge.close();
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true });
  }
});

test("renderer bridge uses IPC only when the normal-launch renderer connection is missing", async () => {
  let refreshes = 0;
  const snapshot = { transport: "desktop-ipc" } as any;
  const bridge = new CodexMicroRendererBridge(() => {}, { refresh: async () => { refreshes++; return snapshot; }, close() {} });
  const internals = bridge as any;
  internals.ensureConnected = async () => { throw new DebugBridgeUnavailableError("normal launch"); };
  assert.equal(await bridge.refresh(), snapshot);
  assert.equal(refreshes, 1);
  await assert.rejects(bridge.requestUsageRefresh(), /Usage refresh requires/);
  assert.equal(refreshes, 1);
  internals.ensureConnected = async () => { throw new Error("page unavailable during relaunch"); };
  assert.equal(await bridge.refresh(), snapshot);
  assert.equal(refreshes, 2);
  internals.ensureConnected = async () => {};
  internals.evaluate = async () => { throw new Error("unexpected transport failure"); };
  await assert.rejects(bridge.refresh(), /unexpected transport failure/);
  assert.equal(refreshes, 2, "renderer execution errors are not silently hidden");
  bridge.close();
});
