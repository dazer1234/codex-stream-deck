import assert from "node:assert/strict";
import test from "node:test";
import { IpcStatusFrameReader } from "../src/codex-ipc-status-frame-reader.js";

const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

test("projected framing handles split headers and coalesced frames", async () => {
  const reader = new IpcStatusFrameReader();
  const first = frame({ type: "response", requestId: "1", resultType: "success", result: { clientId: "deck" } });
  assert.deepEqual(await reader.push(first.subarray(0, 2)), []);
  const result = await reader.push(Buffer.concat([first.subarray(2), frame({ type: "broadcast", method: "ipc-connection-reset" })]));
  assert.equal(result.length, 2);
  assert.equal((result[0] as any).result.clientId, "deck");
  assert.equal((result[1] as any).method, "ipc-connection-reset");
  reader.close();
});

test("frames above 64 MiB retain only status metadata and preserve following frames", async () => {
  const reader = new IpcStatusFrameReader();
  const prefix = Buffer.from('{"type":"broadcast","params":{"change":{"conversationState":{"turns":["');
  const suffix = Buffer.from('"],"title":"after history","threadRuntimeStatus":{"type":"active"},"requests":[],"hasUnreadTurn":false},"type":"snapshot","revision":1}},"method":"thread-stream-state-changed","version":11}');
  const chunk = Buffer.alloc(64 * 1024, 120);
  const repeats = 1280; // 80 MiB; no fixture-sized allocation.
  const header = Buffer.alloc(4); header.writeUInt32LE(prefix.length + repeats * chunk.length + suffix.length);
  await reader.push(Buffer.concat([header, prefix]));
  for (let i = 0; i < repeats; i++) assert.deepEqual(await reader.push(chunk), []);
  const messages = await reader.push(Buffer.concat([suffix, frame({ type: "response", requestId: "after" })]));
  assert.equal(messages.length, 2);
  assert.equal((messages[0] as any).params.change.conversationState.title, "after history");
  assert.equal((messages[0] as any).params.change.conversationState.turns, undefined);
  assert.ok(JSON.stringify(messages).length < 1024);
  assert.equal((messages[1] as any).requestId, "after");
  reader.close();
});

test("invalid/truncated frames cannot leak partial projections into a following frame", async () => {
  const reader = new IpcStatusFrameReader();
  await assert.rejects(reader.push(Buffer.alloc(4)), /empty/i);
  reader.close();
  const truncated = new IpcStatusFrameReader();
  const body = Buffer.from('{"type":');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  await assert.rejects(truncated.push(Buffer.concat([header, body])));
  truncated.close();
});

test("an unfinished frame expires and closes without requiring another chunk", async () => {
  let expired = 0;
  const reader = new IpcStatusFrameReader(() => { expired++; }, 10);
  const header = Buffer.alloc(4); header.writeUInt32LE(1024);
  await reader.push(header);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(expired, 1);
  await assert.rejects(reader.push(Buffer.from("{}")), /closed/i);
  reader.close();
});
