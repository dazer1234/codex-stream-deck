import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquirePidLock } from "../launcher/macos/codex-deck-macos.js";

const nativeLockOptions = { skip: process.platform !== "darwin" };

async function fixture(run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-lock-regression-"));
  try { await run(join(root, "watcher.lock")); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function legacy(path: string) {
  await mkdir(path);
  await writeFile(join(path, "pid"), String(process.pid));
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
}

test("a legacy PID reused by an unrelated live process does not block the watcher", nativeLockOptions, async () => {
  await fixture(async path => {
    await legacy(path); // This test runner is alive, but is not a watcher.
    const release = await acquirePidLock(path);
    assert.ok(release);
    await release();
  });
});

test("owner identity rejects a reused PID even when the PID file is still live", nativeLockOptions, async () => {
  await fixture(async path => {
    await legacy(path);
    await writeFile(join(path, "owner.json"), JSON.stringify({
      pid: process.pid, startedAt: "Thu Jan  1 00:00:00 1970", command: "node old-runtime.mjs watch", token: "old"
    }));
    const release = await acquirePidLock(path);
    assert.ok(release);
    await release();
  });
});

test("fresh incomplete lock is preserved; an abandoned incomplete lock can be reclaimed", nativeLockOptions, async () => {
  await fixture(async path => {
    await mkdir(path);
    assert.equal(await acquirePidLock(path), null);
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    const release = await acquirePidLock(path);
    assert.ok(release);
    await release();
  });
});

test("only one concurrent claimant acquires an abandoned lock", nativeLockOptions, async () => {
  await fixture(async path => {
    await legacy(path);
    const releases = await Promise.all(Array.from({ length: 8 }, () => acquirePidLock(path)));
    assert.equal(releases.filter(Boolean).length, 1);
    for (const release of releases) await release?.();
  });
});

test("release cannot delete a successor's ownership record", nativeLockOptions, async () => {
  await fixture(async path => {
    const release = await acquirePidLock(path);
    assert.ok(release);
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8").catch(() => "{}"));
    await writeFile(join(path, "owner.json"), JSON.stringify({ ...owner, token: "successor" }));
    await release();
    assert.equal(JSON.parse(await readFile(join(path, "owner.json"), "utf8")).token, "successor");
  });
});

test("reclaimed metadata is retained alongside the new lock", nativeLockOptions, async () => {
  await fixture(async path => {
    await legacy(path);
    const release = await acquirePidLock(path);
    assert.ok(release);
    const files = await readdir(join(path, ".."));
    const stale = files.filter(name => name.startsWith("watcher.lock.stale."));
    assert.equal(stale.length, 1);
    assert.equal((await readFile(join(path, "..", stale[0]!, "pid"), "utf8")).trim(), String(process.pid));
    await release();
  });
});
test("separate watcher processes race for a stale lock without stealing the winner", { ...nativeLockOptions, timeout: 20_000 }, async () => {
  await fixture(async path => {
    await legacy(path);
    const children = Array.from({ length: 4 }, () => {
      const process = spawn(globalThis.process.execPath, ["--import", "tsx",
        fileURLToPath(new URL("./fixtures/macos-lock-child.ts", import.meta.url)), path],
        { stdio: ["pipe", "pipe", "pipe"] });
      const lines = createInterface({ input: process.stdout })[Symbol.asyncIterator]();
      const closed = once(process, "close");
      return { process, lines, closed };
    });
    try {
      assert.deepEqual(await Promise.all(children.map(async child => (await child.lines.next()).value)),
        Array(4).fill("ready"));
      for (const child of children) child.process.stdin.write("claim\n");
      const results = await Promise.all(children.map(async child => (await child.lines.next()).value));
      assert.equal(results.filter(result => result === "acquired").length, 1);
      assert.equal(results.filter(result => result === "busy").length, 3);
    } finally {
      for (const child of children) child.process.stdin.end("release\n");
      await Promise.all(children.map(child => child.closed));
    }
  });
});
