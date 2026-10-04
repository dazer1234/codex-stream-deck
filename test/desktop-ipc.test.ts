import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import test from "node:test";
import { promisify } from "node:util";
import { CodexDesktopIpcBridge, encodeIpcFrame, IpcFrameReader, projectIpcStatus } from "../src/codex-desktop-ipc.js";
import { CodexMicroRendererBridge, DebugBridgeUnavailableError } from "../src/codex-micro-renderer-bridge.js";

const threadId = "019fe6f4-531d-7542-b696-c95718d96a2d";
const exec = promisify(execFile);

test("recent task catalog excludes source subagents before limiting slots without filtering user titles", {
  skip: process.platform !== "darwin" && "macOS catalog reader uses the system SQLite executable"
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "deck-catalog-"));
  const path = join(dir, "ipc.sock");
  const peers = new Set<net.Socket>();
  const server = net.createServer(socket => {
    peers.add(socket); socket.on("close", () => peers.delete(socket));
    const reader = new IpcFrameReader();
    socket.on("data", chunk => {
      for (const message of reader.push(chunk)) {
        const m = message as any;
        if (m.method === "initialize") socket.write(encodeIpcFrame({ type: "response", method: "initialize",
          requestId: m.requestId, resultType: "success", result: { clientId: "deck" } }));
      }
    });
  });
  try {
    await exec("/usr/bin/sqlite3", [join(dir, "state_5.sqlite"), `
      CREATE TABLE threads (id TEXT, name TEXT, title TEXT, recency_at_ms INTEGER,
        archived INTEGER, preview TEXT, agent_path TEXT, source TEXT);
      INSERT INTO threads VALUES
        ('00000000-0000-0000-0000-000000000001',NULL,'Guardian Review',109,0,'present',NULL,'{"subagent":{"other":"guardian"}}'),
        ('00000000-0000-0000-0000-000000000002',NULL,'Guardian Review',108,0,'present',NULL,'{"subagent":{"other":"guardian"}}'),
        ('00000000-0000-0000-0000-000000000003',NULL,'Guardian Review',107,0,'present',NULL,'{"subagent":{"other":"guardian"}}'),
        ('00000000-0000-0000-0000-000000000004',NULL,'Guardian Review',106,0,'present',NULL,'{"subagent":{"other":"guardian"}}'),
        ('00000000-0000-0000-0000-000000000005',NULL,'Guardian Review',105,0,'present',NULL,'{"subagent":"thread_spawn"}'),
        ('00000000-0000-0000-0000-000000000006',NULL,'Guardian Review',104,0,'present','/root/child','"cli"'),
        ('00000000-0000-0000-0000-000000000007',NULL,'Guardian Review',103,0,'present',NULL,'"cli"'),
        ('00000000-0000-0000-0000-000000000008',NULL,'User thread',102,0,'present',NULL,NULL),
        ('00000000-0000-0000-0000-000000000009',NULL,'Legacy user thread',101,0,'present',NULL,'desktop');
    `]);
    await new Promise<void>(resolve => server.listen(path, resolve));
    const source = `
      import { CodexDesktopIpcBridge } from ${JSON.stringify(new URL("../src/codex-desktop-ipc.ts", import.meta.url).href)};
      const bridge = new CodexDesktopIpcBridge(() => {}, {
        socketPath: ${JSON.stringify(path)}, verifyApp: async () => {}
      }, { read: async () => undefined, close() {} });
      try { console.log(JSON.stringify((await bridge.refresh()).slots)); }
      finally { bridge.close(); }
    `;
    const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      env: { ...process.env, CODEX_HOME: dir }, timeout: 10000
    });
    const slots = JSON.parse(stdout);
    assert.deepEqual(slots.filter((slot: any) => slot.threadKey).map((slot: any) => [slot.threadKey, slot.title]), [
      ["00000000-0000-0000-0000-000000000007", "Guardian Review"],
      ["00000000-0000-0000-0000-000000000008", "User thread"],
      ["00000000-0000-0000-0000-000000000009", "Legacy user thread"]
    ]);
    assert.equal(slots[0].status, "error", "missing live status must not be presented as healthy");
  } finally {
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true });
  }
});

test("IPC frames survive fragmented and coalesced socket reads, reject oversized frames", () => {
  const reader = new IpcFrameReader();
  const frame = encodeIpcFrame({ type: "response", requestId: "1" });
  assert.deepEqual(reader.push(frame.subarray(0, 2)), []);
  assert.deepEqual(reader.push(Buffer.concat([frame.subarray(2), frame])), [
    { type: "response", requestId: "1" }, { type: "response", requestId: "1" }
  ]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(64 * 1024 * 1024 + 1);
  assert.throws(() => reader.push(oversized), /large/);
});

test("large task snapshots above 32 MiB do not disconnect subsequent IPC messages", () => {
  // Codex 26.908 sends complete long-task snapshots exceeding the old limit.
  const body = Buffer.from(JSON.stringify({ type: "broadcast", payload: "x".repeat(36 * 1024 * 1024) }));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  const reader = new IpcFrameReader();
  assert.deepEqual(reader.push(header.subarray(0, 2)), []);
  assert.deepEqual(reader.push(header.subarray(2)), []);
  let decoded: unknown[] = [];
  for (let offset = 0; offset < body.length; offset += 8192) {
    decoded = reader.push(body.subarray(offset, offset + 8192));
  }
  assert.equal((decoded[0] as { payload: string }).payload.length, 36 * 1024 * 1024);
  assert.deepEqual(reader.push(encodeIpcFrame({ type: "response", requestId: "after-large" })),
    [{ type: "response", requestId: "after-large" }]);
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
  let appVerifications = 0;
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
    verifyApp: async () => { appVerifications++; } }, { read: async () => undefined, close() {} });
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
    assert.equal(appVerifications, 2, "process verification runs once per IPC connection, not every refresh");
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
  await assert.rejects(bridge.requestUsageRefresh(), /no valid rate-limit usage/);
  assert.equal(refreshes, 2);
  internals.ensureConnected = async () => { throw new Error("page unavailable during relaunch"); };
  assert.equal(await bridge.refresh(), snapshot);
  assert.equal(refreshes, 3);
  internals.ensureConnected = async () => {};
  internals.evaluate = async () => { throw new Error("unexpected transport failure"); };
  await assert.rejects(bridge.refresh(), /unexpected transport failure/);
  assert.equal(refreshes, 3, "renderer execution errors are not silently hidden");
  bridge.close();
});

test("explicit usage refresh routes through the IPC fallback", async () => {
  let forced: boolean | undefined;
  const snapshot = { transport: "desktop-ipc", usage: {
    observedAt: 100, resetCreditsAvailable: null, resetCreditsApplicable: null,
    windows: [{ id: "weekly", kind: "weekly", usedPercent: 46, remainingPercent: 54,
      windowDurationMins: 10080, resetsAt: null }]
  } } as any;
  const bridge = new CodexMicroRendererBridge(() => {}, {
    refresh: async force => { forced = force; return snapshot; }, close() {}
  });
  (bridge as any).ensureConnected = async () => { throw new DebugBridgeUnavailableError("normal launch"); };
  assert.equal(await bridge.requestUsageRefresh(), snapshot);
  assert.equal(forced, true);
  bridge.close();
});
