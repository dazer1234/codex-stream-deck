import type { UsageSnapshot, UsageWindow } from "./types.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

const CODEX_APP_SERVER_EXECUTABLES = [
  "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex"
] as const;

export function resolveCodexAppServerExecutable(
  pathExists: (candidate: string) => boolean = existsSync
): string {
  return CODEX_APP_SERVER_EXECUTABLES.find(pathExists) ?? CODEX_APP_SERVER_EXECUTABLES[0];
}

type ReaderOptions = {
  log?: (message: string) => void;
  spawnChild?: (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
  pathExists?: (candidate: string) => boolean;
  now?: () => number;
  timeoutMs?: number;
};

export class CodexAppServerUsageReader {
  private cached?: UsageSnapshot;
  private pending?: Promise<UsageSnapshot>;
  private lastAttempt = -Infinity;
  private generation = 0;
  private lastDiagnostic?: string;
  private cancel?: () => void;
  private readonly now: () => number;

  constructor(private readonly options: ReaderOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async read(force = false): Promise<UsageSnapshot | undefined> {
    if (!this.pending && !force && this.now() - this.lastAttempt < 30_000) return this.cached;
    if (!this.pending) {
      this.lastAttempt = this.now();
      const generation = this.generation;
      const pending = this.query().then((usage) => {
        if (this.generation === generation) {
          this.cached = usage;
          this.diagnose(`Codex account usage available (${usage.windows.map(window => window.kind).join(", ")}).`);
        }
        return usage;
      }, (error: unknown) => {
        if (this.generation === generation) {
          this.cached = undefined;
          // query produces only fixed, redacted errors, never raw server text.
          this.diagnose(`Codex account usage unavailable: ${error instanceof Error ? error.message : "read failed"}`);
        }
        throw error;
      }).finally(() => { if (this.pending === pending) this.pending = undefined; });
      this.pending = pending;
    }
    try { return await this.pending; }
    catch (error) { if (force) throw error; return undefined; }
  }

  close(): void {
    this.generation++;
    this.cached = undefined;
    this.cancel?.();
    this.pending = undefined;
    this.lastAttempt = -Infinity;
  }

  private diagnose(message: string): void {
    if (message === this.lastDiagnostic) return;
    this.lastDiagnostic = message;
    try { this.options.log?.(message); } catch {}
  }

  private query(): Promise<UsageSnapshot> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = (this.options.spawnChild ?? ((executable, args) => spawn(executable, args, {
          stdio: ["pipe", "pipe", "pipe"], windowsHide: true
        })))(resolveCodexAppServerExecutable(this.options.pathExists), ["app-server", "--stdio"]);
      } catch {
        reject(new Error("Codex usage helper could not start."));
        return;
      }
      let done = false;
      let exited = false;
      let buffer = "";
      let totalBytes = 0;
      let expectedId = 1;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => finish(new Error("Codex usage request timed out.")), this.options.timeoutMs ?? 10_000);
      const finish = (error?: Error, usage?: UsageSnapshot): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.cancel = undefined;
        child.stdout.removeListener("data", onData);
        child.stdin.end();
        if (!exited && child.exitCode == null && child.signalCode == null) {
          // Only the helper we spawned is signaled; never the desktop or another process.
          try { child.kill("SIGTERM"); } catch {}
          killTimer = setTimeout(() => {
            if (!exited && child.exitCode == null && child.signalCode == null) {
              try { child.kill("SIGKILL"); } catch {}
            }
          }, 1000);
          killTimer.unref();
        }
        if (error) reject(error);
        else if (usage) resolve(usage);
        else reject(new Error("Codex usage response was unavailable."));
      };
      const send = (message: unknown): void => {
        if (done) return;
        try { child.stdin.write(JSON.stringify(message) + "\n"); }
        catch { finish(new Error("Codex usage helper connection failed.")); }
      };
      const onData = (chunk: string): void => {
        if (done) return;
        totalBytes += Buffer.byteLength(chunk);
        buffer += chunk;
        if (totalBytes > 1_048_576) { finish(new Error("Codex usage response exceeded its size limit.")); return; }
        let newline: number;
        while (!done && (newline = buffer.indexOf("\n")) >= 0) {
          if (Buffer.byteLength(buffer.slice(0, newline)) > 262_144) {
            finish(new Error("Codex usage response exceeded its line limit.")); return;
          }
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: Record<string, unknown> | undefined;
          try { message = record(JSON.parse(line)); }
          catch { finish(new Error("Codex usage helper returned malformed data.")); return; }
          if (!message) { finish(new Error("Codex usage helper returned malformed data.")); return; }
          if (message.id !== expectedId) continue;
          // Server error text may contain account details. Never propagate it into plugin logs.
          if (Object.hasOwn(message, "error")) { finish(new Error("Codex usage request failed.")); return; }
          if (expectedId === 1) {
            if (!record(message.result)) { finish(new Error("Codex usage initialization failed.")); return; }
            expectedId = 2;
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/rateLimits/read", params: {} });
          } else {
            const usage = normalizeAppServerUsage(message.result, this.now());
            finish(usage ? undefined : new Error("Codex usage response was unavailable."), usage);
          }
        }
        if (!done && Buffer.byteLength(buffer) > 262_144) finish(new Error("Codex usage response exceeded its line limit."));
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onData);
      // Drain stderr without retaining or exposing potentially private server diagnostics.
      child.stderr.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > 1_048_576) finish(new Error("Codex usage helper exceeded its output limit."));
      });
      child.on("error", () => finish(new Error("Codex usage helper could not start.")));
      child.stdin.on("error", () => finish(new Error("Codex usage helper connection failed.")));
      child.stdout.on("error", () => finish(new Error("Codex usage helper connection failed.")));
      child.stderr.on("error", () => finish(new Error("Codex usage helper connection failed.")));
      child.on("exit", () => {
        exited = true;
        if (killTimer) clearTimeout(killTimer);
        finish(new Error("Codex usage helper exited before responding."));
      });
      this.cancel = () => finish(new Error("Codex usage reader is closed."));
      send({ id: 1, method: "initialize", params: {
        clientInfo: { name: "codex_stream_deck_usage", title: "Stream Deck usage", version: "1.0.0" },
        capabilities: { experimentalApi: true }
      } });
    });
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function normalizeAppServerUsage(value: unknown, now = Date.now()): UsageSnapshot | undefined {
  const response = record(value);
  if (!response || !Number.isFinite(now) || now <= 0) return undefined;
  // A present map is authoritative. Never substitute Spark or an unrelated bucket.
  const limits = record(Object.hasOwn(response, "rateLimitsByLimitId")
    ? record(response.rateLimitsByLimitId)?.codex : response.rateLimits);
  if (!limits || (limits.limitId != null && limits.limitId !== "codex")) return undefined;
  const windows: UsageWindow[] = [];
  for (const role of ["primary", "secondary"]) {
    if (limits[role] == null) continue;
    const window = record(limits[role]);
    if (!window) return undefined;
    const used = window.usedPercent;
    const minutes = window.windowDurationMins;
    const reset = window.resetsAt;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return undefined;
    if (minutes != null && (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0)) return undefined;
    if (reset != null && (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0 || !Number.isSafeInteger(reset * 1000))) return undefined;
    const kind = minutes === 300 ? "five-hour" : minutes === 10080 ? "weekly" : "other";
    windows.push({ id: kind === "other" ? `${role}-${String(minutes ?? "unknown")}` : kind,
      kind, usedPercent: used, remainingPercent: 100 - used,
      windowDurationMins: minutes == null ? null : minutes as number,
      resetsAt: reset == null ? null : (reset as number) * 1000 });
  }
  if (!windows.length) return undefined;
  const credits = record(response.rateLimitResetCredits);
  const available = credits?.availableCount;
  if (available != null && (typeof available !== "number" || !Number.isSafeInteger(available) || available < 0)) return undefined;
  return { windows, observedAt: now, resetCreditsAvailable: available == null ? null : available as number,
    resetCreditsApplicable: null };
}
