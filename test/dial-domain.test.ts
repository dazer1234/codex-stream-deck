import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ACTION_SELECTOR_ITEMS,
  JOYSTICK_DIRECTIONS,
  MICRO_SLOTS,
  expandDialPreset,
  isDialBindingId,
  normalizeDialSettings
} from "../src/dial-domain.js";
import {
  DIAL_FEEDBACK_MODES,
  DIAL_PRESETS,
  DIAL_SELECTOR_SOURCES,
  type DialPreset
} from "../src/dial-types.js";

function withInheritedProperty(
  values: Record<string, unknown>, inheritedKey: string
): Record<string, unknown> {
  const inherited = Object.create({ [inheritedKey]: values[inheritedKey] }) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (key !== inheritedKey) inherited[key] = value;
  }
  return inherited;
}

function assertFrozenCatalog(catalog: readonly string[]): void {
  const mutable = catalog as string[];
  const originalLength = mutable.length;
  let mutationThrew = false;
  try {
    mutable.push("shell.rm");
  } catch (error) {
    mutationThrew = error instanceof TypeError;
  } finally {
    if (!Object.isFrozen(catalog)) mutable.length = originalLength;
  }
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(mutationThrew, true);
}

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

test("validation and preset catalogs are frozen against runtime authority changes", () => {
  for (const catalog of [
    DIAL_PRESETS,
    DIAL_FEEDBACK_MODES,
    DIAL_SELECTOR_SOURCES,
    MICRO_SLOTS,
    JOYSTICK_DIRECTIONS,
    DEFAULT_ACTION_SELECTOR_ITEMS
  ]) {
    assertFrozenCatalog(catalog);
  }
  assert.equal(expandDialPreset("shell.rm" as DialPreset).preset, "reasoning");
  assert.equal(isDialBindingId("shell.rm"), false);
  assert.equal(isDialBindingId("micro.shell.rm"), false);
  assert.equal(isDialBindingId("joystick.shell.rm"), false);
  assert.equal(isDialBindingId("keycap.shell.rm"), false);
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

test("normalization ignores inherited top-level settings properties", () => {
  const values = {
    version: 1,
    preset: "custom",
    customized: true,
    rotation: {
      kind: "paired", counterClockwise: "reasoning.decrease", clockwise: "reasoning.increase"
    },
    press: "usage.rate-limit-reset",
    touchTap: "keycap.FAST",
    feedback: "reasoning"
  };
  assert.deepEqual(normalizeDialSettings(values), values);

  for (const key of ["version", "preset"]) {
    assert.deepEqual(
      normalizeDialSettings(withInheritedProperty(values, key)),
      expandDialPreset("reasoning"),
      `inherited ${key}`
    );
  }

  const expectedByKey = {
    customized: false,
    rotation: expandDialPreset("custom").rotation,
    press: "none",
    touchTap: "none",
    feedback: "static"
  } as const;
  for (const key of ["customized", "rotation", "press", "touchTap", "feedback"] as const) {
    assert.deepEqual(
      normalizeDialSettings(withInheritedProperty(values, key))[key],
      expectedByKey[key],
      `inherited ${key}`
    );
  }
});

test("normalization ignores inherited nested rotation properties", () => {
  const paired = {
    kind: "paired", counterClockwise: "reasoning.decrease", clockwise: "reasoning.increase"
  };
  const pairedExpected = {
    kind: "paired", counterClockwise: "reasoning.decrease", clockwise: "reasoning.increase"
  };
  assert.deepEqual(normalizeDialSettings({
    version: 1, preset: "custom", rotation: paired, press: "none", touchTap: "none", feedback: "static"
  }).rotation, pairedExpected);
  assert.deepEqual(normalizeDialSettings({
    version: 1,
    preset: "custom",
    rotation: withInheritedProperty(paired, "kind"),
    press: "none",
    touchTap: "none",
    feedback: "static"
  }).rotation, expandDialPreset("custom").rotation);
  assert.deepEqual(normalizeDialSettings({
    version: 1,
    preset: "custom",
    rotation: withInheritedProperty(paired, "counterClockwise"),
    press: "none",
    touchTap: "none",
    feedback: "static"
  }).rotation, { ...pairedExpected, counterClockwise: "none" });
  assert.deepEqual(normalizeDialSettings({
    version: 1,
    preset: "custom",
    rotation: withInheritedProperty(paired, "clockwise"),
    press: "none",
    touchTap: "none",
    feedback: "static"
  }).rotation, { ...pairedExpected, clockwise: "none" });

  const selector = { kind: "selector", source: "actions", wrap: false, items: ["keycap.FAST"] };
  for (const key of ["kind", "source", "wrap", "items"]) {
    assert.deepEqual(normalizeDialSettings({
      version: 1,
      preset: "actions",
      rotation: withInheritedProperty(selector, key),
      press: "selector.activate",
      touchTap: "keycap.SETUP",
      feedback: "action"
    }).rotation, expandDialPreset("actions").rotation, `inherited selector ${key}`);
  }
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

test("only action selectors persist configured items", () => {
  const agents = normalizeDialSettings({
    version: 1,
    preset: "agents",
    rotation: { kind: "selector", source: "agents", wrap: true, items: ["keycap.FAST"] },
    press: "selector.activate",
    touchTap: "keycap.TIME",
    feedback: "agent"
  });
  const usage = normalizeDialSettings({
    version: 1,
    preset: "usage",
    rotation: { kind: "selector", source: "usage", wrap: true, items: ["keycap.FAST"] },
    press: "usage.toggle-overview",
    touchTap: "usage.refresh",
    feedback: "usage"
  });
  const actions = normalizeDialSettings({
    version: 1,
    preset: "actions",
    rotation: {
      kind: "selector", source: "actions", wrap: true, items: ["keycap.FAST", "shell.rm"]
    },
    press: "selector.activate",
    touchTap: "keycap.SETUP",
    feedback: "action"
  });

  assert.deepEqual(agents.rotation, { kind: "selector", source: "agents", wrap: true, items: [] });
  assert.deepEqual(usage.rotation, { kind: "selector", source: "usage", wrap: true, items: [] });
  assert.deepEqual(actions.rotation, {
    kind: "selector", source: "actions", wrap: true, items: ["keycap.FAST"]
  });
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
