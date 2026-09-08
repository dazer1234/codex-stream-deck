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
  assert.match(visible, new RegExp(SIGNAL_COLORS.dark.input, "i"));

  const hidden = renderAgentSvg(0, "Context test", "thinking", false, 0, "dark", "M", "ready", 84, false);
  assert.doesNotMatch(hidden, /data-context-used=/);

  const pending = renderAgentSvg(0, "New task", "idle", false, 0, "dark", "M", "ready", undefined, true);
  assert.match(pending, /data-context-used="unknown"/);

  const empty = renderAgentSvg(0, "Not assigned", "empty", false, 0, "dark", "M", "ready", undefined, true);
  assert.doesNotMatch(empty, /data-context-used=/);
});

test("user-local monochrome SVGs normalize to an off-white dark glyph", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M2 2h20v20H2z" stroke="#000"/></svg>';
  const output = decodeURIComponent(renderImportedKeycap(input, "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
  assert.match(output, /data-theme="dark"/);
  assert.match(output, /fill="#F2F2EE"/);
  assert.match(output, /stroke="#F2F2EE"/);
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
  assert.match(output, />TERM<\/text>/);
  assert.doesNotMatch(output, /#000(?:000)?\b/i);
});

test("imported FAST keycaps expose authoritative green, red, and neutral states", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M2 2h20v20H2z"/></svg>';
  for (const [theme, enabled, semantic, signal] of [
    ["dark", true, "on", SIGNAL_COLORS.dark.complete],
    ["dark", false, "off", SIGNAL_COLORS.dark.error],
    ["light", true, "on", SIGNAL_COLORS.light.complete]
  ] as const) {
    const output = decodeURIComponent(renderImportedKeycap(input, theme, enabled).replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
    assert.match(output, new RegExp(`data-toggle-state="${semantic}"`));
    assert.match(output, new RegExp(`data-toggle-background="${signal}"`, "i"));
    assert.match(output, new RegExp(`fill="${signal}"`, "i"));
    assert.doesNotMatch(output, /data-toggle-background="[^"]+"[^>]*fill-opacity=/, "signal background is opaque");
    assert.match(output, /data-toggle-glyph="#171C20"/i);
    assert.ok(contrast("#171C20", signal) >= 4.5, `${theme} ${semantic} glyph remains readable`);
    assert.match(output, /stroke-width="2"/, "outer keycap border remains present");
    assert.match(output, /stroke-width="1"/, "inner keycap border remains present");
  }

  const unknown = decodeURIComponent(renderImportedKeycap(input, "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
  assert.match(unknown, /data-toggle-state="unknown"/);
  assert.doesNotMatch(unknown, /data-toggle-background=/);
  assert.match(unknown, /fill="#F2F2EE"/);
});

test("fallback FAST keycaps expose the same authoritative state backgrounds", () => {
  for (const [theme, enabled, semantic, signal] of [
    ["dark", true, "on", SIGNAL_COLORS.dark.complete],
    ["dark", false, "off", SIGNAL_COLORS.dark.error],
    ["light", false, "off", SIGNAL_COLORS.light.error]
  ] as const) {
    const output = decodeURIComponent(renderFallbackKeycap("FAST", theme, enabled).replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
    assert.match(output, new RegExp(`data-toggle-state="${semantic}"`));
    assert.match(output, new RegExp(`data-toggle-background="${signal}"`, "i"));
    assert.match(output, new RegExp(`fill="${signal}"`, "i"));
    assert.doesNotMatch(output, /data-toggle-background="[^"]+"[^>]*fill-opacity=/, "signal background is opaque");
    assert.match(output, /data-toggle-glyph="#171C20"/i);
    assert.match(output, />FAST<\/text>/);
  }

  const unknown = decodeURIComponent(renderFallbackKeycap("FAST", "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
  assert.match(unknown, /data-toggle-state="unknown"/);
  assert.doesNotMatch(unknown, /data-toggle-background=/);
  assert.match(unknown, /fill="#F2F2EF"/);
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
