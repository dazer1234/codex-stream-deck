import assert from "node:assert/strict";
import test from "node:test";
import { codexOpenSpec, codexThreadUrl } from "../src/codex-open.js";
import { codexFocusSpec, focusCodexOnAgentPressDefault } from "../src/codex-focus.js";

test("Codex task deep links only accept task UUIDs or new", () => {
  assert.equal(codexThreadUrl("new"), "codex://threads/new");
  assert.equal(codexThreadUrl("019f6de7-44c2-7fe2-9d17-9322c952e626"), "codex://threads/019f6de7-44c2-7fe2-9d17-9322c952e626");
  assert.throws(() => codexThreadUrl("../../settings"), /Invalid Codex task ID/);
});

test("Codex links use native launchers on Windows and macOS", () => {
  const windows = codexOpenSpec("new", "win32", "C:\\Windows");
  assert.match(windows.executable, /powershell\.exe$/i);
  assert.equal(windows.windowsHide, true);
  const mac = codexOpenSpec("new", "darwin");
  assert.deepEqual(mac, { executable: "/usr/bin/open", args: ["codex://threads/new"], windowsHide: false });
  assert.throws(() => codexOpenSpec("new", "linux"), /unsupported/);
});

test("agent presses can opt into focusing the local macOS Codex app", () => {
  assert.equal(focusCodexOnAgentPressDefault({}), false);
  assert.equal(focusCodexOnAgentPressDefault({ CODEX_DECK_FOCUS_CODEX_ON_AGENT_PRESS: "true" }), true);
  assert.equal(focusCodexOnAgentPressDefault({ CODEX_DECK_FOCUS_CODEX_ON_AGENT_PRESS: "1" }), false);
  assert.deepEqual(codexFocusSpec("darwin"), {
    executable: "/usr/bin/open",
    args: ["-b", "com.openai.codex"]
  });
  assert.equal(codexFocusSpec("win32"), null);
});
