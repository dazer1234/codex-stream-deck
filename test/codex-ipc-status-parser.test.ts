import assert from "node:assert/strict";
import test from "node:test";
import { IpcStatusJsonParser } from "../src/codex-ipc-status-parser.js";

async function project(value: string, chunkSize = 37): Promise<any> {
  const parser = new IpcStatusJsonParser();
  try {
    const bytes = Buffer.from(value);
    for (let offset = 0; offset < bytes.length; offset += chunkSize) await parser.write(bytes.subarray(offset, offset + chunkSize));
    return JSON.parse(JSON.stringify(await parser.finish()));
  } finally { parser.close(); }
}

test("projects reordered snapshot metadata and fragmented Unicode without message contents", async () => {
  const result = await project('{"params":{"change":{"conversationState":{"turns":[{"text":"private"}],"requests":[{"secret":"never retain"}],"threadRuntimeStatus":{"activeFlags":["waitingOnInput"],"type":"active"},"hasUnreadTurn":true,"ti\\u0074le":"🧪 café"},"revision":42,"type":"snapshot"},"conversationId":"task","hostId":"local","following":true},"sourceClientId":"owner","version":11,"method":"thread-stream-state-changed","type":"broadcast"}', 1);
  assert.deepEqual(result, { params: { change: { conversationState: { requests: [true], threadRuntimeStatus: { activeFlags: ["waitingOnInput"], type: "active" }, hasUnreadTurn: true, title: "🧪 café" }, revision: 42, type: "snapshot" }, conversationId: "task", hostId: "local", following: true }, sourceClientId: "owner", version: 11, method: "thread-stream-state-changed", type: "broadcast" });
  assert.deepEqual(await project('{"type":"response","requestId":"r","resultType":"success","result":{"clientId":"c","secret":"omit"}}'), { type: "response", requestId: "r", resultType: "success", result: { clientId: "c" } });
});

test("streams a 70 MiB snapshot body with bounded heap and metadata after the body", async () => {
  const parser = new IpcStatusJsonParser();
  const block = Buffer.alloc(64 * 1024, 120);
  const initialHeap = process.memoryUsage().heapUsed;
  const initialExternal = process.memoryUsage().external;
  let peakHeap = initialHeap;
  let peakExternal = initialExternal;
  await parser.write(Buffer.from('{"params":{"change":{"conversationState":{"turns":[{"text":"'));
  for (let i = 0; i < 70 * 16; i++) {
    await parser.write(block);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    peakExternal = Math.max(peakExternal, process.memoryUsage().external);
  }
  await parser.write(Buffer.from('"}],"title":"After the body","requests":[],"threadRuntimeStatus":{"type":"idle"}},"type":"snapshot","revision":5},"hostId":"local","conversationId":"task"},"type":"broadcast"}'));
  const result = JSON.parse(JSON.stringify(await parser.finish()));
  assert.deepEqual(result.params.change.conversationState, { title: "After the body", requests: [], threadRuntimeStatus: { type: "idle" } });
  assert.ok(peakHeap - initialHeap < 48 * 1024 * 1024, `Retained heap grew by ${peakHeap - initialHeap} bytes`);
  assert.ok(peakExternal - initialExternal < 8 * 1024 * 1024, `Retained buffers grew by ${peakExternal - initialExternal} bytes`);
  parser.close();
});

test("preserves useful patch values regardless of key order without retaining unrelated payloads", async () => {
  const result = await project(JSON.stringify({ params: { change: { type: "patches", baseRevision: 1, revision: 2, patches: [
    { value: "New title", path: ["title"], op: "replace" },
    { value: false, path: ["hasUnreadTurn"], op: "replace" },
    { value: { type: "active", activeFlags: ["waitingOnApproval"], secret: "private" }, path: ["threadRuntimeStatus"], op: "replace" },
    { value: [{ secret: "private" }], path: ["requests"], op: "replace" },
    { value: "body", path: ["turns", 0, "text"], op: "replace" },
    { value: { nested: "private" }, path: ["title"], op: "replace" },
    { path: ["requests"], op: "replace", value: [] },
  ] } } }));
  assert.deepEqual(result.params.change.patches, [
    { value: "New title", path: ["title"], op: "replace" },
    { value: false, path: ["hasUnreadTurn"], op: "replace" },
    { value: { type: "active", activeFlags: ["waitingOnApproval"] }, path: ["threadRuntimeStatus"], op: "replace" },
    { value: [true], path: ["requests"], op: "replace" },
    { __codexStatusValueOmitted: true, path: ["turns", 0, "text"], op: "replace" },
    { __codexStatusValueOmitted: true, path: ["title"], op: "replace" },
    { path: ["requests"], op: "replace", value: [] },
  ]);
});

test("discards giant unknown keys and numbers without hiding later metadata or polluting prototypes", async () => {
  const parser = new IpcStatusJsonParser();
  await parser.write(Buffer.from('{"'));
  const block = Buffer.alloc(64 * 1024, 120);
  for (let i = 0; i < 32; i++) await parser.write(block);
  await parser.write(Buffer.from('\":1,"unknown":1'));
  const digits = Buffer.alloc(64 * 1024, 49);
  for (let i = 0; i < 32; i++) await parser.write(digits);
  await parser.write(Buffer.from(',"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"type":"broadcast"}'));
  assert.deepEqual(JSON.parse(JSON.stringify(await parser.finish())), { type: "broadcast" });
  assert.equal(({} as any).polluted, undefined);
});

test("fails closed for malformed, truncated, non-object, deep, and oversized metadata", async () => {
  for (const input of ['[]', 'null', 'true', '12', '"private"', '', '{"type":', '{"secret":"private"', '{"type":"x"}{}', '{"unknown":' + '['.repeat(300) + '0' + ']'.repeat(300) + '}', JSON.stringify({ type: 'x'.repeat(20000) })]) {
    await assert.rejects(project(input), (error: Error) => error.message === "Invalid or excessive Codex IPC status metadata");
  }
});

test("close rejects pending operations and prevents parser reuse", async () => {
  const writing = new IpcStatusJsonParser();
  const pendingWrite = writing.write(Buffer.from('{"type":"broadcast"}'));
  writing.close();
  await assert.rejects(pendingWrite, /closed/);
  await assert.rejects(writing.write(Buffer.from('{}')), /closed/);
  await assert.rejects(writing.finish(), /closed/);

  const finishing = new IpcStatusJsonParser();
  await finishing.write(Buffer.from('{}'));
  const pendingEnd = finishing.finish();
  finishing.close();
  await assert.rejects(pendingEnd, /closed/);

  const finished = new IpcStatusJsonParser();
  await finished.write(Buffer.from('{}'));
  await finished.finish();
  await assert.rejects(finished.finish(), /lifecycle/);
  await assert.rejects(finished.write(Buffer.from('{}')), /lifecycle/);
  finished.close();
});

test("bounds aggregate projected metadata and marks giant patch strings instead of retaining them", async () => {
  const giant = await project(JSON.stringify({ params: { change: { patches: [{ value: "x".repeat(20000), path: ["title"], op: "replace" }] } } }));
  assert.deepEqual(giant.params.change.patches[0], { __codexStatusValueOmitted: true, path: ["title"], op: "replace" });
  const patches = Array.from({ length: 10000 }, () => ({ op: "replace", path: ["title"], value: "x".repeat(100) }));
  await assert.rejects(project(JSON.stringify({ params: { change: { patches } } }), 65536));
});
