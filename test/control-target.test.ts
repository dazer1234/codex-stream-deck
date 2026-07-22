import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isRemoteControlRequest, readControlTarget, resolveStartupControlTarget
} from "../src/control-target.js";

test("control targeting treats each platform as local on its own host", () => {
  assert.equal(isRemoteControlRequest("win32", "win32"), false);
  assert.equal(isRemoteControlRequest("darwin", "darwin"), false);
  assert.equal(isRemoteControlRequest("darwin", "win32"), true);
  assert.equal(isRemoteControlRequest("win32", "darwin"), true);
});

test("an explicit task owner overrides the selected platform", () => {
  assert.equal(isRemoteControlRequest("darwin", "darwin", "local", "local"), false);
  assert.equal(isRemoteControlRequest("darwin", "darwin", "remote", "local"), true);
});

test("invalid persisted targets fall back to the local platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-target-"));
  try {
    const path = join(root, "target.json");
    await writeFile(path, '{"platform":"unknown"}\n');
    assert.equal(await readControlTarget(path, "darwin"), "darwin");
    assert.equal(await readControlTarget(join(root, "missing.json"), "win32"), "win32");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("single-host startup resets a stale opposite-host target", () => {
  assert.equal(resolveStartupControlTarget("win32", "darwin", false), "darwin");
  assert.equal(resolveStartupControlTarget("darwin", "win32", false), "win32");
});

test("configured relay preserves an explicit remote target while offline", () => {
  assert.equal(resolveStartupControlTarget("win32", "darwin", true), "win32");
  assert.equal(resolveStartupControlTarget("darwin", "win32", true), "darwin");
});
