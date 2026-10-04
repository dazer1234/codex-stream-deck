import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CodexAppServerUsageReader,
  normalizeAppServerUsage,
  resolveCodexAppServerExecutable
} from "../src/codex-app-server-usage.js";

const bucket = {
  limitId: "codex", limitName: null,
  primary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: 1789436723 },
  secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" },
  individualLimit: null, spendControlReached: false, planType: "pro", rateLimitReachedType: null
};
const response = {
  rateLimits: bucket,
  rateLimitsByLimitId: { codex: bucket, codex_bengalfox: { ...bucket, primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1789072971 } } },
  rateLimitResetCredits: { availableCount: 1, credits: [] }, accountId: "test-account", rateLimitUpsell: null
};

test("resolves the bundled Codex helper after the desktop app moves it under codex-cli", () => {
  const available = new Set([
    "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
  ]);
  assert.equal(resolveCodexAppServerExecutable((candidate) => available.has(candidate)),
    "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  assert.equal(resolveCodexAppServerExecutable((candidate) => candidate.endsWith("/Resources/codex")),
    "/Applications/Codex.app/Contents/Resources/codex");
});

test("normalizes the Codex bucket without borrowing Spark windows or inventing reset applicability", () => {
  assert.deepEqual(normalizeAppServerUsage(response, 1000), {
    windows: [{ id: "weekly", kind: "weekly", usedPercent: 46, remainingPercent: 54,
      windowDurationMins: 10080, resetsAt: 1789436723000 }],
    observedAt: 1000, resetCreditsAvailable: 1, resetCreditsApplicable: null
  });
  assert.equal(normalizeAppServerUsage({ ...response, rateLimitsByLimitId: { codex_bengalfox: bucket } }), undefined);
  assert.equal(normalizeAppServerUsage({ ...response, rateLimitsByLimitId: null }), undefined);
  assert.equal(normalizeAppServerUsage({ rateLimits: bucket }, 1000)?.resetCreditsAvailable, null);
});

function fakeServer(reply: (request: Record<string, unknown>, child: FakeChild) => void) {
  return new FakeChild(reply);
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  messages: Record<string, unknown>[] = [];
  kills: NodeJS.Signals[] = [];
  constructor(reply: (request: Record<string, unknown>, child: FakeChild) => void) {
    super();
    this.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const request = JSON.parse(line);
        this.messages.push(request);
        queueMicrotask(() => reply(request, this));
      }
    });
  }
  reply(value: unknown): void { this.stdout.write(JSON.stringify(value) + "\n"); }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

function normalReply(request: Record<string, unknown>, child: FakeChild): void {
  if (request.method === "initialize") child.reply({ id: request.id, result: { userAgent: "fixture" } });
  if (request.method === "account/rateLimits/read") child.reply({ id: request.id, result: response });
}

test("reader sends only initialization and read-only usage RPCs and closes its own child", async () => {
  const child = fakeServer(normalReply);
  const reader = new CodexAppServerUsageReader({ spawnChild: (exe, args) => {
    assert.equal(exe, "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
    assert.deepEqual(args, ["app-server", "--stdio"]);
    return child.asChild();
  }, pathExists: (candidate) => candidate.includes("/codex-cli/"), now: () => 1000 });
  assert.equal((await reader.read())?.windows[0]?.remainingPercent, 54);
  assert.deepEqual(child.messages.map((message) => message.method), ["initialize", "initialized", "account/rateLimits/read"]);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  reader.close();
});

test("reader uses the legacy bundled helper when the new app layout is absent", async () => {
  const child = fakeServer(normalReply);
  const reader = new CodexAppServerUsageReader({ spawnChild: (exe) => {
    assert.equal(exe, "/Applications/Codex.app/Contents/Resources/codex");
    return child.asChild();
  }, pathExists: (candidate) => candidate.endsWith("/Resources/codex"), now: () => 1000 });
  assert.equal((await reader.read())?.windows[0]?.remainingPercent, 54);
  reader.close();
});

test("usage diagnostics report availability transitions without account data or repeated failures", async () => {
  const logs: string[] = [];
  let healthy = false;
  const reader = new CodexAppServerUsageReader({
    log: message => logs.push(message),
    spawnChild: () => fakeServer(healthy ? normalReply : (request, child) => {
      child.reply({ id: request.id, error: { message: "private-account-detail" } });
    }).asChild()
  });
  await reader.read(true).catch(() => {});
  await reader.read(true).catch(() => {});
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /unavailable/i);
  assert.ok(!logs.join().includes("private-account-detail"));
  healthy = true;
  await reader.read(true);
  assert.equal(logs.length, 2);
  assert.match(logs[1]!, /available.*weekly/i);
  assert.ok(!logs.join().includes("test-account"));
  reader.close();
});

test("reader coalesces requests, caches for 30 seconds, and discards failed stale data", async () => {
  let now = 1000;
  let count = 0;
  const children: FakeChild[] = [];
  const reader = new CodexAppServerUsageReader({ now: () => now, spawnChild: () => {
    const child = fakeServer(count++ === 0 ? normalReply : (request, child) => child.reply({ id: request.id, error: { message: "secret" } }));
    children.push(child);
    return child.asChild();
  } });
  const [first, concurrent] = await Promise.all([reader.read(), reader.read()]);
  assert.equal(first?.windows[0]?.usedPercent, 46);
  assert.equal(concurrent, first);
  now = 30_999;
  assert.equal(await reader.read(), first);
  assert.equal(count, 1);
  now = 31_000;
  assert.equal(await reader.read(), undefined);
  assert.equal(await reader.read(), undefined);
  assert.equal(count, 2, "failed background reads should also be throttled");
  await assert.rejects(reader.read(true), /usage/i);
  assert.equal(count, 3);
  assert.equal(children.every((child) => child.kills.length === 1), true);
  reader.close();
});

test("reader bounds hung/malformed children and redacts RPC errors", async () => {
  const behaviors = [
    (_request: Record<string, unknown>, _child: FakeChild) => {},
    (_request: Record<string, unknown>, child: FakeChild) => child.stdout.write("x".repeat(300_000)),
    (_request: Record<string, unknown>, child: FakeChild) => {
      for (let i = 0; i < 6; i++) child.reply({ method: "notification", params: "x".repeat(200_000) });
    },
    (_request: Record<string, unknown>, child: FakeChild) => child.stderr.write("x".repeat(1_048_577)),
    (_request: Record<string, unknown>, child: FakeChild) => child.stdout.write("not json\n"),
    (request: Record<string, unknown>, child: FakeChild) => child.reply({ id: request.id, error: { message: "SECRET_TOKEN" } }),
    (_request: Record<string, unknown>, child: FakeChild) => child.emit("error", new Error("SECRET_TOKEN")),
    (_request: Record<string, unknown>, child: FakeChild) => child.emit("exit", 1, null)
  ];
  for (const [index, behavior] of behaviors.entries()) {
    const child = fakeServer(behavior);
    const reader = new CodexAppServerUsageReader({ spawnChild: () => child.asChild(), timeoutMs: 20 });
    await assert.rejects(reader.read(true), (error: Error) => /usage/i.test(error.message) && !error.message.includes("SECRET_TOKEN"));
    assert.deepEqual(child.kills, index === behaviors.length - 1 ? [] : ["SIGTERM"]);
    reader.close();
  }
});

test("synchronous spawn failures stay private and background retries remain throttled", async () => {
  let count = 0;
  const reader = new CodexAppServerUsageReader({ spawnChild: () => { count++; throw new Error("SECRET_TOKEN"); } });
  assert.equal(await reader.read(), undefined);
  assert.equal(await reader.read(), undefined);
  assert.equal(count, 1);
  await assert.rejects(reader.read(true), (error: Error) => /could not start/.test(error.message) && !error.message.includes("SECRET_TOKEN"));
  assert.equal(count, 2);
  reader.close();
});

test("closing an in-flight reader terminates only its child and permits a fresh fallback connection", async () => {
  const child = fakeServer(() => {});
  const nextChild = fakeServer(normalReply);
  let count = 0;
  const reader = new CodexAppServerUsageReader({ spawnChild: () => (count++ === 0 ? child : nextChild).asChild() });
  const pending = reader.read(true);
  reader.close();
  const next = reader.read();
  await assert.rejects(pending, /closed/i);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal((await next)?.windows[0]?.remainingPercent, 54);
  assert.equal((await reader.read())?.windows[0]?.remainingPercent, 54);
  assert.equal(count, 2);
  reader.close();
});

test("usage normalization rejects malformed values and classifies windows by duration, not primary position", () => {
  for (const usedPercent of ["46", null, -1, 101, NaN]) {
    assert.equal(normalizeAppServerUsage({ rateLimits: { ...bucket, primary: { ...bucket.primary, usedPercent } } }), undefined);
  }
  for (const windowDurationMins of ["300", 0, -1, Infinity]) {
    assert.equal(normalizeAppServerUsage({ rateLimits: { ...bucket, primary: { ...bucket.primary, windowDurationMins } } }), undefined);
  }
  assert.equal(normalizeAppServerUsage({ rateLimits: { ...bucket, primary: { ...bucket.primary, resetsAt: "tomorrow" } } }), undefined);
  assert.equal(normalizeAppServerUsage({ rateLimits: bucket, rateLimitResetCredits: { availableCount: -1 } }), undefined);
  assert.deepEqual(normalizeAppServerUsage({ rateLimits: { ...bucket,
    secondary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }
  } }, 1000)?.windows[1], { id: "five-hour", kind: "five-hour", usedPercent: 0, remainingPercent: 100,
    windowDurationMins: 300, resetsAt: null });
});
