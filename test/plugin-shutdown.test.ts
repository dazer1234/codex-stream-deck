import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  // Windows child.kill() force-terminates rather than delivering Node signals.
  test(`plugin stops its controller and exits on ${signal} despite a live SDK connection`, {
    skip: process.platform === "win32"
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-deck-shutdown-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const entry = join(directory, "plugin.mjs");

    // Keep the actual plugin entry and action registration. Only replace the
    // external SDK connection and Codex controller to avoid touching live apps.
    await build({
      entryPoints: [fileURLToPath(new URL("../src/plugin.ts", import.meta.url))],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      plugins: [{
        name: "isolated-plugin-connections",
        setup(builder) {
          builder.onResolve({ filter: /^@elgato\/streamdeck$/ }, () => ({ path: "sdk", namespace: "shutdown-test" }));
          builder.onLoad({ filter: /.*/, namespace: "shutdown-test" }, () => ({
            contents: `
              export class SingletonAction {}
              export const action = () => (target) => target;
              export default {
                settings: { onDidReceiveGlobalSettings() {} },
                actions: { registerAction() {} },
                logger: { error(message) { console.error(message); } },
                connect() { setInterval(() => {}, 1000); }
              };
            `,
            loader: "js"
          }));
          builder.onLoad({ filter: /[\\/]src[\\/]controller\.ts$/ }, () => ({
            contents: `
              export class DeckController {
                async start() { console.log("READY"); }
                stop() { console.log("STOP"); }
                setContextRingVisibility() {}
              }
            `,
            loader: "js"
          }));
        }
      }]
    });

    const child = spawn(process.execPath, [entry], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Plugin did not start: ${stderr}`)), 5000);
      const onData = () => {
        if (!stdout.includes("READY\n")) return;
        clearTimeout(deadline);
        child.stdout.off("data", onData);
        resolve();
      };
      child.stdout.on("data", onData);
      onData();
    });
    // Give the entry point time to install signal listeners after start().
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(child.kill(signal), true);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      exited,
      new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), 1000); })
    ]);
    clearTimeout(deadline);
    assert.notEqual(result, null, `Plugin remained alive after ${signal}; stdout=${stdout}; stderr=${stderr}`);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stdout.split("\n").filter((line) => line === "STOP").length, 1);
    assert.equal(stderr, "");
  });
}
