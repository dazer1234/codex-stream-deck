import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderAgentSvg, renderBuiltinKeycap, renderFallbackKeycap, renderHostTargetKey, renderImportedKeycap, SIGNAL_COLORS } from "../src/render.js";

test("dark agent tiles use Codex-like charcoal surfaces without pure black", () => {
  const svg = renderAgentSvg(0, "Building dark mode", "thinking", true, 4, "dark");
  assert.match(svg, /data-theme="dark"/);
  assert.match(svg, /#343638/);
  assert.match(svg, /#222426/);
  assert.match(svg, /#F2F2EF/);
  assert.match(svg, new RegExp(SIGNAL_COLORS.dark.thinking, "i"));
  assert.doesNotMatch(svg, /#000(?:000)?\b/i);
});

test("light and dark agent themes remain visually distinct", () => {
  const light = renderAgentSvg(0, "Ready", "idle", false, 0, "light");
  const dark = renderAgentSvg(0, "Ready", "idle", false, 0, "dark");
  assert.match(light, /data-theme="light"/);
  assert.match(light, /#FFFFFF/);
  assert.notEqual(light, dark);
});

test("agent context ring is bounded and can be hidden globally", () => {
  const visible = renderAgentSvg(0, "Context test", "thinking", false, 0, "dark", "M", "ready", 84, true);
  assert.match(visible, /data-context-used="84"/);
  assert.match(visible, /cx="116" cy="25"/);
  assert.match(visible, new RegExp(SIGNAL_COLORS.dark.input, "i"));

  const hidden = renderAgentSvg(0, "Context test", "thinking", false, 0, "dark", "M", "ready", 84, false);
  assert.doesNotMatch(hidden, /data-context-used=/);

  const pending = renderAgentSvg(0, "New task", "idle", false, 0, "dark", "M", "ready", undefined, true);
  assert.match(pending, /data-context-used="unknown"/);

  const empty = renderAgentSvg(0, "Not assigned", "empty", false, 0, "dark", "M", "ready", undefined, true);
  assert.doesNotMatch(empty, /data-context-used=/);
});

test("agent titles are enlarged and all state indicators occupy the upper-left slot", () => {
  const complete = renderAgentSvg(0, "Review changes", "complete", false, 0, "dark", undefined, "ready", 42, true);
  assert.match(complete, /font-size="26\.00"/);
  assert.match(complete, /data-agent-motion="complete"[\s\S]*cx="25" cy="25" r="11"/);
  assert.match(complete, /data-context-used="42"[\s\S]*cx="116" cy="25"/);

  const idle = renderAgentSvg(0, "Ready", "idle", false, 0, "dark");
  assert.match(idle, /font-size="27\.00"/);
  assert.match(idle, /data-agent-motion="idle" cx="25" cy="25" r="6" fill="#FFFFFF"/);

  const working = renderAgentSvg(0, "Building UI", "thinking", false, 4, "dark");
  assert.match(working, /data-agent-motion="working"[\s\S]*x="13" y="19"/);
  assert.match(working, /fill="#FFFFFF" fill-opacity="\.98"/);

  const lightWorking = renderAgentSvg(0, "Building UI", "thinking", false, 4, "light");
  assert.match(lightWorking, /data-agent-motion="working"[\s\S]*fill="#15202A" fill-opacity="\.98"/);

  const nextWorking = renderAgentSvg(1, "Building API", "thinking", false, 4, "dark");
  assert.match(working, /data-agent-motion="working"[\s\S]*<rect x="19\.80" y="21"/);
  assert.match(nextWorking, /data-agent-motion="working"[\s\S]*<rect x="28\.20" y="21"/);

  const input = renderAgentSvg(0, "Needs review", "input", false, 0, "dark");
  assert.match(input, /data-agent-motion="input"[\s\S]*x="19" y="17"/);

  const error = renderAgentSvg(0, "Test failed", "error", false, 0, "dark");
  assert.match(error, /data-agent-motion="error"[\s\S]*cx="25" cy="25" r="11"/);

  const empty = renderAgentSvg(0, "Not assigned", "empty", false, 0, "dark");
  assert.match(empty, /data-agent-motion="empty" x="18" y="23"/);
});

test("long agent titles can use three centered lines", () => {
  const longTitle = renderAgentSvg(0, "Investigate yellow triangle", "thinking", false, 0, "dark");
  assert.match(longTitle, /y="62"[\s\S]*>Investigate<\/text>/);
  assert.match(longTitle, /y="91"[\s\S]*>yellow<\/text>/);
  assert.match(longTitle, /y="120"[\s\S]*>triangle<\/text>/);
  assert.match(longTitle, /font-size="24\.00"/);
});

test("agent titles wrap before reaching the horizontal key edges", () => {
  const title = renderAgentSvg(0, "Building UI", "thinking", false, 0, "dark");
  assert.match(title, /x="72" y="73"[\s\S]*>Building<\/text>/);
  assert.match(title, /x="72" y="107"[\s\S]*>UI<\/text>/);
  assert.doesNotMatch(title, />Building UI<\/text>/);
});

test("user-local monochrome SVGs normalize to an off-white dark glyph", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M2 2h20v20H2z" stroke="#000"/></svg>';
  const output = decodeURIComponent(renderImportedKeycap(input, "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
  assert.match(output, /data-theme="dark"/);
  assert.match(output, /fill="#F2F2EE"/);
  assert.match(output, /stroke="#F2F2EE"/);
  assert.match(output, /translate\(18\.000 18\.000\) scale\(4\.50000\)/);
  assert.doesNotMatch(output, /#000(?:000)?\b/i);
});

test("original navigation icons use the same dark keycap system", () => {
  for (const icon of ["back", "forward", "sidebar", "home", "navigation"] as const) {
    const output = decodeURIComponent(renderBuiltinKeycap(icon, "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
    assert.match(output, /data-theme="dark"/);
    assert.match(output, /data-icon-source="codex-deck-original"/);
    assert.match(output, /stroke="#F2F2EE"/);
    assert.doesNotMatch(output, /#000(?:000)?\b/i);
  }
});

test("renderer snapshot derives a theme without a versioned asset hash", async () => {
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  assert.match(source, /backgroundColor/);
  assert.match(source, /prefers-color-scheme: dark/);
  assert.match(source, /theme\s*=\s*explicitDark/);
});

test("dark title contrast stays above WCAG AA for small text", () => {
  assert.ok(contrast("#F2F2EF", "#2A2C2E") > 7);
});

test("missing local assets receive a readable themed fallback", () => {
  const output = decodeURIComponent(renderFallbackKeycap("TERM", "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
  assert.match(output, /data-icon-source="fallback-label"/);
  assert.match(output, /font-size="34"/);
  assert.match(output, /font-weight="700"/);
  assert.match(output, />TERM<\/text>/);
  assert.doesNotMatch(output, /#000(?:000)?\b/i);
});

test("host target and affected agent keys expose degraded and offline state", () => {
  const target = decodeURIComponent(renderHostTargetKey("MAC", "degraded", "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
  assert.match(target, /data-host-health="degraded"/);
  assert.match(target, />DEGRADED<\/text>/);
  assert.match(target, new RegExp(SIGNAL_COLORS.dark.input, "i"));

  const degradedAgent = renderAgentSvg(0, "Last known task", "idle", false, 0, "dark", "M", "degraded");
  assert.match(degradedAgent, /data-agent-host="M"/);
  assert.match(degradedAgent, /data-agent-host-health="degraded"/);
  const offlineAgent = renderAgentSvg(0, "Last known task", "idle", false, 0, "dark", "M", "offline");
  assert.match(offlineAgent, /data-agent-host-health="offline"/);
});

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + .05) / (darker! + .05);
}

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
}
