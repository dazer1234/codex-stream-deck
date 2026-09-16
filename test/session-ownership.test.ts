import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSessionOwnershipIndex, sessionIdFromRolloutFilename, sessionIdFromThreadKey } from "../src/session-ownership.js";
import type { MicroSnapshot } from "../src/types.js";

const owned = "019f7336-04a2-72f1-af41-2f216ccdc3d0";
const mirrored = "019f6de7-44c2-7fe2-9d17-9322c952e626";

test("session ownership is derived from exact rollout filenames, not message references", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-ownership-"));
  try {
    const dated = join(root, "2026", "07", "18");
    await mkdir(dated, { recursive: true });
    await writeFile(join(dated, `rollout-2026-07-18T00-00-00-${owned}.jsonl`), "{}\n");
    await writeFile(join(dated, "rollout-containing-another-thread-reference.jsonl"), mirrored);
    const index = new CodexSessionOwnershipIndex([root], 60_000);
    const annotated = await index.annotate(snapshot());
    assert.equal(annotated.slots[0]!.ownedByHost, true);
    assert.equal(annotated.slots[1]!.ownedByHost, false);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("owned rollout metadata supplies a compact project label", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-project-label-"));
  try {
    await writeFile(join(root, `rollout-now-${owned}.jsonl`),
      '{"type":"session_meta","payload":{"cwd":"/Users/example/Code/acme-project"}}\n');
    const annotated = await new CodexSessionOwnershipIndex([root], 60_000).annotate(snapshot());
    assert.equal(annotated.slots[0]!.projectName, "acme-project");
    assert.equal(annotated.slots[1]!.projectName, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout and prefixed thread identities use the same UUID", () => {
  assert.equal(sessionIdFromRolloutFilename(`rollout-time-${owned}.jsonl`), owned);
  assert.equal(sessionIdFromThreadKey(`local:${owned}`), owned);
  assert.equal(sessionIdFromThreadKey("local:../../secret"), null);
});

test("recent local rollout tails expose structural working and completion state without task contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-presence-"));
  try {
    const activeId = "10000000-0000-4000-8000-000000000001";
    const completeId = "10000000-0000-4000-8000-000000000002";
    await writeFile(join(root, `rollout-now-${activeId}.jsonl`), '{"type":"event_msg","payload":{"type":"agent_reasoning"}}\n');
    await writeFile(join(root, `rollout-now-${completeId}.jsonl`), '{"type":"event_msg","payload":{"type":"agent_reasoning"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    const annotated = await new CodexSessionOwnershipIndex([root], 60_000).annotate(snapshot());
    const states = new Map(annotated.hostSessions?.map((session) => [session.threadId, session.status]));
    assert.equal(states.get(activeId), "working");
    assert.equal(states.get(completeId), "complete");
    const index = new CodexSessionOwnershipIndex([root], 60_000);
    const beforeOpen = await index.annotate(snapshot());
    assert.equal(beforeOpen.hostSessions?.find((session) => session.threadId === completeId)?.status, "complete");
    index.markOpened(`local:${completeId}`);
    const afterOpen = await index.annotate(snapshot());
    assert.equal(afterOpen.hostSessions?.find((session) => session.threadId === completeId)?.status, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current response_item records keep a long-running Codex task working after task_started leaves the tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-current-presence-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000009";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(path,
      '{"type":"event_msg","payload":{"type":"task_started"}}\n' +
      `${"x".repeat(520 * 1024)}\n` +
      '{"timestamp":"2026-07-21T20:00:00.000Z","type":"response_item","payload":{"type":"reasoning"}}\n' +
      '{"timestamp":"2026-07-21T20:00:01.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec"}}\n');
    const now = Date.parse("2026-07-21T20:00:02.000Z");
    const annotated = await new CodexSessionOwnershipIndex([root], 0).annotate(
      snapshotFor(threadId, false), now);
    const session = annotated.hostSessions?.find((candidate) => candidate.threadId === threadId);
    assert.equal(session?.status, "working");
    assert.equal(session?.activityAt, Date.parse("2026-07-21T20:00:01.000Z"));
    assert.equal(annotated.slots[0]!.status, "working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old completion uses its event timestamp and cannot flash as newly complete after a file touch", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-stale-completion-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000010";
    await writeFile(join(root, `rollout-now-${threadId}.jsonl`),
      '{"timestamp":"2026-07-21T19:00:00.000Z","type":"event_msg","payload":{"type":"task_started"}}\n' +
      '{"timestamp":"2026-07-21T19:01:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}\n' +
      '{"timestamp":"2026-07-21T20:00:00.000Z","type":"event_msg","payload":{"type":"thread_settings_applied"}}\n');
    const now = Date.parse("2026-07-21T20:00:01.000Z");
    const annotated = await new CodexSessionOwnershipIndex([root], 0).annotate(
      snapshotFor(threadId, false), now);
    const session = annotated.hostSessions?.find((candidate) => candidate.threadId === threadId);
    assert.equal(session?.status, "idle");
    assert.equal(session?.activityAt, Date.parse("2026-07-21T19:01:00.000Z"));
    assert.equal(annotated.slots[0]!.status, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout token counts expose bounded per-thread context usage without task content", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-context-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000006";
    const tokenCount = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 99_999_999 },
          last_token_usage: { total_tokens: 80_000 },
          model_context_window: 100_000
        }
      }
    });
    await writeFile(join(root, `rollout-now-${threadId}.jsonl`), `${tokenCount}\n`);
    const value = snapshotFor(threadId, false);
    const annotated = await new CodexSessionOwnershipIndex([root], 60_000).annotate(value);
    assert.equal(annotated.slots[0]!.contextUsedPercent, 80);
    assert.equal(
      annotated.hostSessions?.find((session) => session.threadId === threadId)?.contextUsedPercent,
      80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a renderer turn_context after task_complete does not resurrect a finished task", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-lifecycle-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000007";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(path,
      '{"type":"event_msg","payload":{"type":"task_started"}}\n' +
      '{"type":"event_msg","payload":{"type":"task_complete"}}\n' +
      '{"type":"turn_context","payload":{"type":"turn_context"}}\n');
    const index = new CodexSessionOwnershipIndex([root], 0);
    let state = await index.annotate(snapshotFor(threadId, false), Date.now());
    assert.equal(state.hostSessions?.find((session) => session.threadId === threadId)?.status, "complete");

    await appendFile(path, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
    state = await index.annotate(snapshotFor(threadId, false), Date.now() + 1);
    assert.equal(state.hostSessions?.find((session) => session.threadId === threadId)?.status, "working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acknowledging a completion survives later file touches but a new completion becomes unread", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-completion-ack-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000003";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(path, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    const index = new CodexSessionOwnershipIndex([root], 0);
    const first = await index.annotate(snapshotFor(threadId, false), Date.now());
    assert.equal(first.hostSessions?.find((session) => session.threadId === threadId)?.status, "complete");

    const selected = await index.annotate(snapshotFor(threadId, true), Date.now() + 1);
    assert.equal(selected.hostSessions?.find((session) => session.threadId === threadId)?.status, "idle");
    await appendFile(path, '{"type":"event_msg","payload":{"type":"thread_opened"}}\n');
    const afterTouch = await index.annotate(snapshotFor(threadId, false), Date.now() + 2);
    assert.equal(afterTouch.hostSessions?.find((session) => session.threadId === threadId)?.status, "idle");

    await appendFile(path, '{"type":"event_msg","payload":{"type":"agent_reasoning"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    const nextCompletion = await index.annotate(snapshotFor(threadId, false), Date.now() + 3);
    assert.equal(nextCompletion.hostSessions?.find((session) => session.threadId === threadId)?.status, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the active renderer task acknowledges completion outside the six Micro slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-active-thread-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000004";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(path, '{"type":"event_msg","payload":{"type":"agent_reasoning"}}\n');
    const index = new CodexSessionOwnershipIndex([root], 0);
    const value = snapshot();
    value.activeThreadKey = `local:${threadId}`;
    assert.equal((await index.annotate(value, Date.now())).hostSessions?.find((session) => session.threadId === threadId)?.status, "working");
    await appendFile(path, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    assert.equal((await index.annotate(value, Date.now() + 1)).hostSessions?.find((session) => session.threadId === threadId)?.status, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned rollout lifecycle clears stale native working and unread colors", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-native-status-"));
  try {
    const threadId = "10000000-0000-4000-8000-000000000008";
    const path = join(root, `rollout-now-${threadId}.jsonl`);
    await writeFile(path, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    const index = new CodexSessionOwnershipIndex([root], 0);
    const value = snapshotFor(threadId, false);
    value.slots[0]!.status = "working";
    assert.equal((await index.annotate(value, Date.now())).slots[0]!.status, "complete");

    value.activeThreadKey = `local:${threadId}`;
    value.slots[0]!.status = "unread";
    const active = await index.annotate(value, Date.now() + 1);
    assert.equal(active.hostSessions?.find((session) => session.threadId === threadId)?.status, "idle");
    assert.equal(active.slots[0]!.status, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function snapshot(): MicroSnapshot {
  return {
    slots: Array.from({ length: 6 }, (_, id) => ({
      id,
      threadKey: `local:${id === 0 ? owned : id === 1 ? mirrored : `00000000-0000-4000-8000-00000000000${id}`}`,
      title: `Task ${id + 1}`,
      status: "idle",
      selected: false
    })),
    layout: {
      version: 1,
      slots: {
        ACT06: { keycapId: "FAST" }, ACT07: { keycapId: "APPR" }, ACT08: { keycapId: "REJ" },
        ACT09: { keycapId: "SPLIT" }, ACT10_ACT11: { keycapId: "CODEX" }, ACT12: { keycapId: "CODEX" }
      },
      analogStick: { up: {}, right: {}, down: {}, left: {} }
    },
    agentSource: "recent",
    lightingAutoOff: "3-minutes",
    theme: "dark"
  };
}

function snapshotFor(threadId: string, selected: boolean): MicroSnapshot {
  const value = snapshot();
  value.slots[0] = { ...value.slots[0]!, threadKey: `local:${threadId}`, selected };
  return value;
}
