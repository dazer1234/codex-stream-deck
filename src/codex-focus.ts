import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function focusCodexOnAgentPressDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEX_DECK_FOCUS_CODEX_ON_AGENT_PRESS === "true";
}

export function codexFocusSpec(targetPlatform = process.platform): { executable: string; args: string[] } | null {
  if (targetPlatform !== "darwin") return null;
  return {
    executable: "/usr/bin/open",
    args: ["-b", "com.openai.codex"]
  };
}

export async function focusCodexApp(): Promise<void> {
  const spec = codexFocusSpec();
  if (!spec) return;
  await execFileAsync(spec.executable, spec.args, { windowsHide: true });
}
