import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codexDeckStateRoot } from "./codex-deck-paths.js";
import type { CodexHost } from "./types.js";

export type HostPlatform = CodexHost["platform"];
const CONTROL_TARGET_PATH = join(codexDeckStateRoot(), "control-target.json");

export function resolveStartupControlTarget(
  persisted: HostPlatform,
  local: HostPlatform,
  relayConfigured: boolean
): HostPlatform {
  return relayConfigured ? persisted : local;
}

export function isRemoteControlRequest(
  targetPlatform: HostPlatform,
  localPlatform: HostPlatform,
  requestedHostId?: string,
  localHostId?: string
): boolean {
  return requestedHostId != null
    ? requestedHostId !== localHostId
    : targetPlatform !== localPlatform;
}

export async function readControlTarget(
  path = CONTROL_TARGET_PATH,
  fallback: HostPlatform = process.platform === "darwin" ? "darwin" : "win32"
): Promise<HostPlatform> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { platform?: unknown };
    return value.platform === "darwin" || value.platform === "win32" ? value.platform : fallback;
  } catch { return fallback; }
}

export async function writeControlTarget(platform: HostPlatform, path = CONTROL_TARGET_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, platform })}\n`, { encoding: "utf8", mode: 0o600 });
}
