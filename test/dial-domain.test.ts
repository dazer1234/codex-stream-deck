import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ACTION_SELECTOR_ITEMS,
  expandDialPreset,
  isDialBindingId,
  normalizeDialSettings
} from "../src/dial-domain.js";

test("status-focused presets expand to the approved independent bindings", () => {
  const actionItems = [
    "micro.ACT06", "micro.ACT07", "micro.ACT08", "micro.ACT09", "micro.ACT10_ACT11", "micro.ACT12"
  ];
  assert.deepEqual(DEFAULT_ACTION_SELECTOR_ITEMS, actionItems);
  assert.deepEqual(expandDialPreset("reasoning"), {
    version: 1,
    preset: "reasoning",
    customized: false,
    rotation: { kind: "paired", counterClockwise: "reasoning.decrease", clockwise: "reasoning.increase" },
    press: "none",
    touchTap: "keycap.FAST",
    feedback: "reasoning"
  });
  assert.deepEqual(expandDialPreset("agents"), {
    version: 1,
    preset: "agents",
    customized: false,
    rotation: { kind: "selector", source: "agents", wrap: true, items: [] },
    press: "selector.activate",
    touchTap: "keycap.TIME",
    feedback: "agent"
  });
  assert.deepEqual(expandDialPreset("actions"), {
    version: 1,
    preset: "actions",
    customized: false,
    rotation: {
      kind: "selector", source: "actions", wrap: true, items: actionItems
    },
    press: "selector.activate",
    touchTap: "keycap.SETUP",
    feedback: "action"
  });
  assert.deepEqual(expandDialPreset("navigation"), {
    version: 1,
    preset: "navigation",
    customized: false,
    rotation: { kind: "paired", counterClockwise: "joystick.left", clockwise: "joystick.right" },
    press: "joystick.up",
    touchTap: "joystick.down",
    feedback: "navigation"
  });
  assert.deepEqual(expandDialPreset("usage"), {
    version: 1,
    preset: "usage",
    customized: false,
    rotation: { kind: "selector", source: "usage", wrap: true, items: [] },
    press: "usage.toggle-overview",
    touchTap: "usage.refresh",
    feedback: "usage"
  });
  assert.deepEqual(expandDialPreset("custom"), {
    version: 1,
    preset: "custom",
    customized: false,
    rotation: { kind: "paired", counterClockwise: "none", clockwise: "none" },
    press: "none",
    touchTap: "none",
    feedback: "static"
  });
});

test("binding validation accepts only exact allow-listed commands for each gesture", () => {
  for (const binding of [
    "none", "reasoning.decrease", "reasoning.increase", "new-task", "host.toggle",
    "usage.refresh", "usage.toggle-overview", "micro.ACT06", "micro.ACT10_ACT11",
    "joystick.up", "joystick.left", "keycap.FAST", "keycap.MIND+"
  ]) {
    assert.equal(isDialBindingId(binding, "rotation"), true, binding);
  }
  assert.equal(isDialBindingId("selector.activate", "press"), true);
  assert.equal(isDialBindingId("usage.rate-limit-reset", "press"), true);

  for (const binding of [
    "shell.rm", "micro.ACT13", "micro.ACT06.extra", "joystick.center", "joystick.up.extra",
    "keycap.NOT_REAL", "keycap.FAST.extra", "usage.refresh.now", "", null
  ]) {
    assert.equal(isDialBindingId(binding, "press"), false, String(binding));
  }
  assert.equal(isDialBindingId("selector.activate", "rotation"), false);
  assert.equal(isDialBindingId("selector.activate", "touch"), false);
  assert.equal(isDialBindingId("usage.rate-limit-reset", "rotation"), false);
  assert.equal(isDialBindingId("usage.rate-limit-reset", "selector"), false);
  assert.equal(isDialBindingId("usage.rate-limit-reset", "touch"), false);
});

test("malformed settings normalize to a safe preset and reject executable strings", () => {
  assert.deepEqual(normalizeDialSettings({}), expandDialPreset("reasoning"));
  assert.deepEqual(
    normalizeDialSettings({ version: 2, preset: "usage" }),
    expandDialPreset("reasoning")
  );
  assert.deepEqual(
    normalizeDialSettings({ version: 1, preset: "unknown" }),
    expandDialPreset("reasoning")
  );

  const normalized = normalizeDialSettings({
    version: 1,
    preset: "custom",
    customized: true,
    rotation: { kind: "paired", counterClockwise: "shell.rm", clockwise: "reasoning.increase" },
    press: "usage.rate-limit-reset",
    touchTap: "usage.rate-limit-reset",
    feedback: "reasoning"
  });
  assert.deepEqual(normalized.rotation, {
    kind: "paired", counterClockwise: "none", clockwise: "reasoning.increase"
  });
  assert.equal(normalized.press, "usage.rate-limit-reset");
  assert.equal(normalized.touchTap, "none", "reset hold cannot be bound to touch tap");
});

test("selector normalization validates structure, filters bindings, and caps items", () => {
  const requestedItems: string[] = Array.from({ length: 35 }, (_, index) =>
    index % 2 === 0 ? "micro.ACT06" : "keycap.FAST"
  );
  requestedItems.splice(2, 0, "shell.rm", "selector.activate", "usage.rate-limit-reset");
  const normalized = normalizeDialSettings({
    version: 1,
    preset: "actions",
    rotation: { kind: "selector", source: "actions", wrap: false, items: requestedItems },
    press: "shell.execute",
    touchTap: "keycap.SETUP",
    feedback: "action"
  });
  assert.equal(normalized.rotation.kind, "selector");
  if (normalized.rotation.kind === "selector") {
    assert.equal(normalized.rotation.source, "actions");
    assert.equal(normalized.rotation.wrap, false);
    assert.equal(normalized.rotation.items.length, 30);
    assert.equal(normalized.rotation.items.includes("selector.activate"), false);
    assert.equal(normalized.rotation.items.includes("usage.rate-limit-reset"), false);
  }
  assert.equal(normalized.press, "selector.activate", "invalid press uses the preset fallback");

  assert.deepEqual(normalizeDialSettings({
    version: 1,
    preset: "usage",
    rotation: { kind: "selector", source: "arbitrary", wrap: true, items: [] },
    press: "usage.toggle-overview",
    touchTap: "usage.refresh",
    feedback: "usage"
  }).rotation, expandDialPreset("usage").rotation);
  assert.deepEqual(normalizeDialSettings({
    version: 1,
    preset: "agents",
    rotation: { kind: "selector", source: "agents", wrap: "true", items: [] },
    press: "selector.activate",
    touchTap: "keycap.TIME",
    feedback: "agent"
  }).rotation, expandDialPreset("agents").rotation);
});

test("normalization retains only exact customization and bounded non-empty labels", () => {
  const normalized = normalizeDialSettings({
    version: 1,
    preset: "custom",
    customized: "true",
    rotation: { kind: "paired", counterClockwise: "none", clockwise: "none" },
    press: "none",
    touchTap: "none",
    feedback: "not-real",
    staticLabel: `  ${"x".repeat(45)}  `
  });
  assert.equal(normalized.customized, false);
  assert.equal(normalized.feedback, "static");
  assert.equal(normalized.staticLabel, "x".repeat(40));

  const blank = normalizeDialSettings({
    ...normalized,
    customized: true,
    staticLabel: "   "
  });
  assert.equal(blank.customized, true);
  assert.equal("staticLabel" in blank, false);
});
