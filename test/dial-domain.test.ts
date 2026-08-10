import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ACTION_SELECTOR_ITEMS,
  DialCommandQueue,
  JOYSTICK_DIRECTIONS,
  MICRO_SLOTS,
  bindingLifecycle,
  deriveDialFeedback,
  expandDialPreset,
  initialDialRuntimeState,
  isDialBindingId,
  normalizeDialSettings,
  reconcileSelector,
  reduceDialRotation,
  selectedItem,
  selectorItems
} from "../src/dial-domain.js";
import {
  DIAL_FEEDBACK_MODES,
  DIAL_PRESETS,
  DIAL_SELECTOR_SOURCES,
  type DialBindingId,
  type CodexDialSettings,
  type DialPreset,
  type DialRuntimeView
} from "../src/dial-types.js";
import { OFFICIAL_KEYCAP_IDS } from "../src/keycaps.js";

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

const RUNTIME_VIEW: DialRuntimeView = {
  health: "ready",
  reasoningEffort: "high",
  agents: [
    {
      id: 0,
      identity: "rollout-alpha",
      threadKey: "thread-alpha",
      title: "Alpha task",
      status: "thinking",
      health: "ready",
      contextUsedPercent: 42
    },
    {
      id: 3,
      identity: "rollout-delta",
      threadKey: "thread-delta",
      title: "Delta task",
      status: "idle",
      health: "ready"
    }
  ],
  actionLabels: {
    "micro.ACT06": "Approve change",
    "keycap.FAST": "Fast mode"
  },
  usage: {
    mode: "five-hour",
    remainingPercent: 72,
    resetsAt: 10_000,
    observedAt: 1_000,
    fiveHourRemaining: 72,
    weeklyRemaining: 41
  },
  now: 1_000
};

function actionSelector(
  items: DialBindingId[] = []
): CodexDialSettings {
  return normalizeDialSettings({
    ...expandDialPreset("actions"),
    rotation: { kind: "selector", source: "actions", wrap: true, items }
  });
}

test("binding lifecycle distinguishes momentary, one-shot, and protected hold commands", () => {
  assert.equal(bindingLifecycle("none"), "none");
  assert.equal(bindingLifecycle("micro.ACT07"), "momentary");
  assert.equal(bindingLifecycle("joystick.left"), "momentary");
  assert.equal(bindingLifecycle("reasoning.increase"), "one-shot");
  assert.equal(bindingLifecycle("keycap.FAST"), "one-shot");
  assert.equal(bindingLifecycle("usage.rate-limit-reset"), "hold");
});

test("serialized queue preserves every detent after async work", async () => {
  const seen: number[] = [];
  const queue = new DialCommandQueue();
  for (const value of [1, 2, 3]) queue.enqueue(async () => {
    await Promise.resolve();
    seen.push(value);
  });
  await queue.idle();
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(queue.pendingCount, 0);
});

test("serialized queue recovers after a rejected operation", async () => {
  const seen: string[] = [];
  const queue = new DialCommandQueue();
  queue.enqueue(async () => { seen.push("failed"); throw new Error("expected"); });
  queue.enqueue(async () => { seen.push("recovered"); });
  await queue.idle();
  assert.deepEqual(seen, ["failed", "recovered"]);
  assert.equal(queue.pendingCount, 0);
});

test("serialized queue rejects backlog beyond its bounded pending capacity", async () => {
  const queue = new DialCommandQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  assert.equal(queue.enqueue(() => gate), true);
  for (let index = 1; index < 128; index += 1) {
    assert.equal(queue.enqueue(async () => {}), true, String(index));
  }
  assert.equal(queue.pendingCount, 128);
  assert.equal(queue.enqueue(async () => {}), false);
  release();
  await queue.idle();
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.enqueue(async () => {}), true, "capacity recovers after the backlog drains");
  await queue.idle();
  assert.equal(queue.pendingCount, 0);
});

test("runtime selectors expose occupied agents, exact usage choices, and ordered safe actions", () => {
  const agentSettings = expandDialPreset("agents");
  assert.deepEqual(selectorItems(agentSettings, RUNTIME_VIEW), [
    {
      id: "rollout-alpha",
      label: "Alpha task",
      detail: "thinking",
      agentSlot: 0,
      threadKey: "thread-alpha"
    },
    {
      id: "rollout-delta",
      label: "Delta task",
      detail: "idle",
      agentSlot: 3,
      threadKey: "thread-delta"
    }
  ]);
  assert.deepEqual(selectorItems(expandDialPreset("usage"), RUNTIME_VIEW), [
    { id: "auto", label: "Auto" },
    { id: "five-hour", label: "5h" },
    { id: "weekly", label: "Weekly" }
  ]);

  const actions = actionSelector(["keycap.FAST", "micro.ACT06", "joystick.left", "new-task"]);
  assert.deepEqual(selectorItems(actions, RUNTIME_VIEW), [
    { id: "keycap.FAST", label: "Fast mode", binding: "keycap.FAST" },
    { id: "micro.ACT06", label: "Approve change", binding: "micro.ACT06" },
    { id: "joystick.left", label: "Joystick Left", binding: "joystick.left" },
    { id: "new-task", label: "New Task", binding: "new-task" }
  ]);
});

test("action selector normalization removes duplicates before rotation", () => {
  const settings = actionSelector(["keycap.FAST", "keycap.FAST", "keycap.APPR"]);
  assert.deepEqual(settings.rotation, {
    kind: "selector",
    source: "actions",
    wrap: true,
    items: ["keycap.FAST", "keycap.APPR"]
  });
  assert.equal(
    reduceDialRotation(
      settings,
      { ...initialDialRuntimeState(), selectedId: "keycap.FAST" },
      RUNTIME_VIEW,
      1
    ).state.selectedId,
    "keycap.APPR"
  );
});

test("selector reconciliation preserves stable identity across reorder and handles disappearance", () => {
  const original = selectorItems(expandDialPreset("agents"), RUNTIME_VIEW);
  assert.deepEqual(reconcileSelector(initialDialRuntimeState(), original), {
    usageMode: "auto",
    usageOverview: false,
    selectedId: "rollout-alpha",
    selectedIndex: 0
  });

  const selectedDelta = {
    ...initialDialRuntimeState(),
    selectedId: "rollout-delta",
    selectedIndex: 1
  };
  const reordered = selectorItems(expandDialPreset("agents"), {
    ...RUNTIME_VIEW,
    agents: [...RUNTIME_VIEW.agents].reverse()
  });
  assert.deepEqual(reconcileSelector(selectedDelta, reordered), {
    ...selectedDelta,
    selectedIndex: 0
  });
  assert.deepEqual(reconcileSelector(selectedDelta, original.slice(0, 1)), {
    ...selectedDelta,
    selectedId: "rollout-alpha",
    selectedIndex: 0
  });
  assert.deepEqual(reconcileSelector(selectedDelta, []), {
    usageMode: "auto",
    usageOverview: false,
    selectedIndex: 1
  });

  const three = [
    { id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }
  ];
  const selectedMiddle = reconcileSelector(
    { ...initialDialRuntimeState(), selectedId: "b" }, three
  );
  assert.equal(selectedMiddle.selectedIndex, 1);
  assert.deepEqual(reconcileSelector(selectedMiddle, [three[0]!, three[2]!]), {
    ...selectedMiddle,
    selectedId: "c",
    selectedIndex: 1
  });
});

test("preset and runtime factories return independent mutable structures", () => {
  const firstPreset = expandDialPreset("actions");
  const secondPreset = expandDialPreset("actions");
  assert.notEqual(firstPreset, secondPreset);
  assert.notEqual(firstPreset.rotation, secondPreset.rotation);
  if (firstPreset.rotation.kind === "selector" && secondPreset.rotation.kind === "selector") {
    assert.notEqual(firstPreset.rotation.items, secondPreset.rotation.items);
    firstPreset.rotation.items.push("keycap.FAST");
    assert.equal(secondPreset.rotation.items.includes("keycap.FAST"), false);
  }

  const firstState = initialDialRuntimeState();
  const secondState = initialDialRuntimeState();
  assert.notEqual(firstState, secondState);
  firstState.usageMode = "weekly";
  firstState.usageOverview = true;
  assert.deepEqual(secondState, { usageMode: "auto", usageOverview: false });
});

test("paired rotation emits one binding for every physical detent in both directions", () => {
  const settings = expandDialPreset("reasoning");
  const state = initialDialRuntimeState();
  assert.deepEqual(reduceDialRotation(settings, state, RUNTIME_VIEW, -3), {
    state,
    bindings: ["reasoning.decrease", "reasoning.decrease", "reasoning.decrease"]
  });
  assert.deepEqual(reduceDialRotation(settings, state, RUNTIME_VIEW, 2), {
    state,
    bindings: ["reasoning.increase", "reasoning.increase"]
  });
  assert.deepEqual(reduceDialRotation(settings, state, RUNTIME_VIEW, 65).bindings, []);
});

test("rotation accepts the full physical event range and rejects impossible counts", () => {
  const reasoning = expandDialPreset("reasoning");
  const state = initialDialRuntimeState();
  const clockwise = reduceDialRotation(reasoning, state, RUNTIME_VIEW, 64);
  assert.equal(clockwise.bindings.length, 64);
  assert.equal(clockwise.bindings[0], "reasoning.increase");
  assert.equal(clockwise.bindings.at(-1), "reasoning.increase");
  const counterClockwise = reduceDialRotation(reasoning, state, RUNTIME_VIEW, -64);
  assert.equal(counterClockwise.bindings.length, 64);
  assert.equal(counterClockwise.bindings[0], "reasoning.decrease");
  assert.equal(counterClockwise.bindings.at(-1), "reasoning.decrease");

  for (const ticks of [
    65,
    -65,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    const rejected = reduceDialRotation(reasoning, state, RUNTIME_VIEW, ticks);
    assert.equal(rejected.state, state, String(ticks));
    assert.deepEqual(rejected.bindings, [], String(ticks));
  }

  const usage = expandDialPreset("usage");
  assert.equal(
    reduceDialRotation(usage, state, RUNTIME_VIEW, 64).state.selectedId,
    "five-hour"
  );
  assert.equal(
    reduceDialRotation(usage, state, RUNTIME_VIEW, -64).state.selectedId,
    "weekly"
  );
  const hugeSelector = reduceDialRotation(usage, state, RUNTIME_VIEW, Number.MAX_SAFE_INTEGER);
  assert.equal(hugeSelector.state, state);
  assert.deepEqual(hugeSelector.bindings, []);
});

test("selector rotation previews without dispatch and wraps or clamps as configured", () => {
  const usage = expandDialPreset("usage");
  const weekly = {
    ...initialDialRuntimeState(),
    selectedId: "weekly",
    usageMode: "weekly" as const
  };
  const wrapped = reduceDialRotation(usage, weekly, RUNTIME_VIEW, 1);
  assert.deepEqual(wrapped.bindings, []);
  assert.deepEqual(wrapped.state, {
    selectedId: "auto",
    selectedIndex: 0,
    usageMode: "auto",
    usageOverview: false
  });

  const clampedSettings = normalizeDialSettings({
    ...usage,
    rotation: { kind: "selector", source: "usage", wrap: false, items: [] }
  });
  assert.deepEqual(reduceDialRotation(clampedSettings, weekly, RUNTIME_VIEW, 3), {
    state: { ...weekly, selectedIndex: 2 },
    bindings: []
  });
  assert.equal(
    reduceDialRotation(usage, { ...weekly, selectedId: "auto", usageMode: "auto" }, RUNTIME_VIEW, -1)
      .state.selectedId,
    "weekly"
  );
});

test("agent selector rotation skips absent slots and selectedItem reconciles stable identity", () => {
  const agents = expandDialPreset("agents");
  const initial = reduceDialRotation(agents, initialDialRuntimeState(), RUNTIME_VIEW, 1);
  assert.deepEqual(initial.bindings, []);
  assert.equal(initial.state.selectedId, "rollout-delta");
  assert.equal(selectedItem(agents, initial.state, RUNTIME_VIEW)?.threadKey, "thread-delta");

  const reorderedView = { ...RUNTIME_VIEW, agents: [...RUNTIME_VIEW.agents].reverse() };
  assert.equal(selectedItem(agents, initial.state, reorderedView)?.id, "rollout-delta");
  assert.equal(selectedItem(agents, initialDialRuntimeState(), { ...RUNTIME_VIEW, agents: [] }), undefined);
});

test("empty selectors and invalid, non-finite, fractional, or zero ticks are no-ops", () => {
  const state = { ...initialDialRuntimeState(), selectedId: "missing" };
  const emptyView = { ...RUNTIME_VIEW, agents: [] };
  assert.deepEqual(reduceDialRotation(expandDialPreset("agents"), state, emptyView, 2), {
    state: { usageMode: "auto", usageOverview: false },
    bindings: []
  });
  for (const ticks of [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
    const result = reduceDialRotation(expandDialPreset("reasoning"), state, RUNTIME_VIEW, ticks);
    assert.equal(result.state, state, String(ticks));
    assert.deepEqual(result.bindings, [], String(ticks));
  }
});

test("reasoning feedback reports the live effort and never infers an absent value", () => {
  assert.deepEqual(
    deriveDialFeedback(expandDialPreset("reasoning"), initialDialRuntimeState(), RUNTIME_VIEW),
    {
      title: "REASONING",
      value: "HIGH",
      detail: "TURN TO ADJUST",
      indicator: 75,
      accent: "#1683FF"
    }
  );
  assert.deepEqual(
    deriveDialFeedback(
      expandDialPreset("reasoning"),
      initialDialRuntimeState(),
      { ...RUNTIME_VIEW, reasoningEffort: undefined }
    ),
    {
      title: "REASONING",
      value: "UNAVAILABLE",
      detail: "LIVE VALUE NOT REPORTED",
      indicator: 0,
      accent: "#707B85"
    }
  );
});

test("agent and action feedback use reconciled selections and bounded live labels", () => {
  const agentState = { ...initialDialRuntimeState(), selectedId: "rollout-alpha" };
  assert.deepEqual(deriveDialFeedback(expandDialPreset("agents"), agentState, RUNTIME_VIEW), {
    title: "AGENT 1",
    value: "ALPHA TASK",
    detail: "THINKING • 42% CONTEXT",
    indicator: 42,
    accent: "#1683FF"
  });
  assert.deepEqual(deriveDialFeedback(
    expandDialPreset("agents"),
    agentState,
    {
      ...RUNTIME_VIEW,
      health: "ready",
      agents: [{ ...RUNTIME_VIEW.agents[0]!, health: "offline" }]
    }
  ), {
    title: "AGENT 1",
    value: "OFFLINE",
    detail: "LIVE DATA UNAVAILABLE",
    indicator: 0,
    accent: "#FF4B61"
  });
  assert.equal(deriveDialFeedback(
    expandDialPreset("agents"),
    agentState,
    { ...RUNTIME_VIEW, health: "offline" }
  ).value, "ALPHA TASK");

  const settings = actionSelector(["keycap.FAST", "micro.ACT06"]);
  assert.deepEqual(deriveDialFeedback(settings, initialDialRuntimeState(), RUNTIME_VIEW), {
    title: "ACTION 1/2",
    value: "FAST MODE",
    detail: "PRESS TO RUN",
    indicator: 50,
    accent: "#4CE0C2"
  });

  const longLabelView = {
    ...RUNTIME_VIEW,
    actionLabels: { "keycap.FAST": "  a very long\nlabel that cannot fit on the touchscreen  " }
  };
  const bounded = deriveDialFeedback(
    actionSelector(["keycap.FAST"]), initialDialRuntimeState(), longLabelView
  );
  assert.equal(bounded.value, "A VERY LONG LABEL THAT…");
  assert.equal(bounded.value.length <= 24, true);
});

test("empty selectors report no items while agent feedback includes an optional host badge", () => {
  for (const health of ["ready", "degraded", "offline", "connecting"] as const) {
    assert.deepEqual(
      deriveDialFeedback(
        expandDialPreset("agents"),
        initialDialRuntimeState(),
        { ...RUNTIME_VIEW, health, agents: [] }
      ),
      {
        title: "AGENT",
        value: "NO ITEMS",
        detail: "NO ACTIVE AGENTS",
        indicator: 0,
        accent: "#707B85"
      },
      `agents ${health}`
    );
    assert.deepEqual(
      deriveDialFeedback(
        actionSelector([]),
        initialDialRuntimeState(),
        { ...RUNTIME_VIEW, health }
      ),
      {
        title: "ACTION",
        value: "NO ITEMS",
        detail: "NO ACTIONS CONFIGURED",
        indicator: 0,
        accent: "#707B85"
      },
      `actions ${health}`
    );
  }
  const multiHostView: DialRuntimeView = {
    ...RUNTIME_VIEW,
    agents: [{ ...RUNTIME_VIEW.agents[0]!, hostBadge: "M" }]
  };
  assert.equal(
    deriveDialFeedback(expandDialPreset("agents"), initialDialRuntimeState(), multiHostView).title,
    "AGENT 1 • M"
  );
  assert.equal(
    deriveDialFeedback(expandDialPreset("agents"), initialDialRuntimeState(), RUNTIME_VIEW).title,
    "AGENT 1"
  );
});

test("zero-based agents use one-based display numbers and nonblank text fallbacks", () => {
  const blankAgentView: DialRuntimeView = {
    ...RUNTIME_VIEW,
    agents: [{
      id: 0,
      identity: "blank-agent",
      threadKey: "thread-blank",
      title: "   ",
      status: "\n\t",
      health: "ready"
    }]
  };
  assert.deepEqual(selectorItems(expandDialPreset("agents"), blankAgentView), [{
    id: "blank-agent",
    label: "Agent 1",
    detail: "unknown",
    agentSlot: 0,
    threadKey: "thread-blank"
  }]);
  assert.deepEqual(
    deriveDialFeedback(expandDialPreset("agents"), initialDialRuntimeState(), blankAgentView),
    {
      title: "AGENT 1",
      value: "AGENT 1",
      detail: "UNKNOWN",
      indicator: 0,
      accent: "#707B85"
    }
  );
});

test("feedback truncation preserves complete Unicode code points before the ellipsis", () => {
  const settings = normalizeDialSettings({
    ...expandDialPreset("custom"),
    staticLabel: `${"a".repeat(22)}😀bc`
  });
  const value = deriveDialFeedback(settings, initialDialRuntimeState(), RUNTIME_VIEW).value;
  assert.equal(value, `${"A".repeat(22)}😀…`);
  assert.equal(Array.from(value).length, 24);
});

test("navigation and static feedback are explicit, while auto follows the rotation source", () => {
  assert.deepEqual(
    deriveDialFeedback(expandDialPreset("navigation"), initialDialRuntimeState(), RUNTIME_VIEW),
    {
      title: "NAVIGATION",
      value: "BACK / FORWARD",
      detail: "TURN LEFT / RIGHT",
      indicator: 50,
      accent: "#1683FF"
    }
  );
  assert.deepEqual(
    deriveDialFeedback(
      normalizeDialSettings({ ...expandDialPreset("custom"), staticLabel: "Desk control" }),
      initialDialRuntimeState(),
      RUNTIME_VIEW
    ),
    {
      title: "CUSTOM",
      value: "DESK CONTROL",
      detail: "READY",
      indicator: 0,
      accent: "#707B85"
    }
  );

  const autoAgents = normalizeDialSettings({ ...expandDialPreset("agents"), feedback: "auto" });
  assert.equal(deriveDialFeedback(autoAgents, initialDialRuntimeState(), RUNTIME_VIEW).title, "AGENT 1");

  const autoUsagePreset = normalizeDialSettings({
    ...expandDialPreset("usage"),
    feedback: "auto",
    rotation: { kind: "paired", counterClockwise: "none", clockwise: "none" }
  });
  assert.equal(
    deriveDialFeedback(autoUsagePreset, initialDialRuntimeState(), RUNTIME_VIEW).title,
    "USAGE • 5 HOURS"
  );
});

test("usage feedback reports percent left, reset countdown, and both overview windows", () => {
  const view: DialRuntimeView = {
    ...RUNTIME_VIEW,
    now: 1_000,
    usage: {
      ...RUNTIME_VIEW.usage!,
      resetsAt: 9_001_000
    }
  };
  const state = {
    ...initialDialRuntimeState(),
    selectedId: "five-hour",
    usageMode: "five-hour" as const
  };
  assert.deepEqual(deriveDialFeedback(expandDialPreset("usage"), state, view), {
    title: "USAGE • 5 HOURS",
    value: "72% LEFT",
    detail: "RESETS IN 2H 30M",
    indicator: 72,
    accent: "#35D86B"
  });
  assert.deepEqual(deriveDialFeedback(
    expandDialPreset("usage"),
    { ...state, usageOverview: true },
    view
  ), {
    title: "USAGE OVERVIEW",
    value: "5H 72% • WK 41%",
    detail: "PRESS TO CLOSE",
    indicator: 72,
    accent: "#35D86B"
  });

  assert.deepEqual(deriveDialFeedback(
    expandDialPreset("usage"),
    { ...state, selectedId: "weekly", usageMode: "weekly" },
    { ...view, usage: { ...view.usage!, weeklyRemaining: undefined } }
  ), {
    title: "USAGE • WEEKLY",
    value: "UNAVAILABLE",
    detail: "LIVE VALUE NOT REPORTED",
    indicator: 0,
    accent: "#707B85"
  });
});

test("usage feedback formats reset countdowns as compact day, hour, and minute units", () => {
  const settings = expandDialPreset("usage");
  const state = {
    ...initialDialRuntimeState(),
    selectedId: "five-hour",
    usageMode: "five-hour" as const
  };
  const now = 1_000;
  const cases = [
    [48 * 60_000, "RESETS IN 48M"],
    [(5 * 60 + 48) * 60_000, "RESETS IN 5H 48M"],
    [24 * 60 * 60_000, "RESETS IN 1D"],
    [(24 * 60 + 1) * 60_000, "RESETS IN 1D 1M"],
    [(125 * 60 + 48) * 60_000, "RESETS IN 5D 5H 48M"],
    [7 * 24 * 60 * 60_000, "RESETS IN 7D"],
    [0, "RESETS IN 0M"],
    [60_001, "RESETS IN 2M"]
  ] as const;

  for (const [remainingMs, expected] of cases) {
    const view: DialRuntimeView = {
      ...RUNTIME_VIEW,
      now,
      usage: { ...RUNTIME_VIEW.usage!, resetsAt: now + remainingMs }
    };
    assert.equal(deriveDialFeedback(settings, state, view).detail, expected);
  }

  for (const resetsAt of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const view: DialRuntimeView = {
      ...RUNTIME_VIEW,
      now,
      usage: { ...RUNTIME_VIEW.usage!, resetsAt }
    };
    assert.equal(deriveDialFeedback(settings, state, view).detail, "RESET UNAVAILABLE");
  }
});

test("partial usage runtime views remain honest and accept a nullable reset time", () => {
  const partialView: DialRuntimeView = {
    ...RUNTIME_VIEW,
    usage: { mode: "weekly" }
  };
  assert.deepEqual(deriveDialFeedback(
    expandDialPreset("usage"),
    { ...initialDialRuntimeState(), selectedId: "weekly", usageMode: "weekly" },
    partialView
  ), {
    title: "USAGE • WEEKLY",
    value: "UNAVAILABLE",
    detail: "LIVE VALUE NOT REPORTED",
    indicator: 0,
    accent: "#707B85"
  });

  const nullableResetView: DialRuntimeView = {
    ...RUNTIME_VIEW,
    usage: {
      mode: "five-hour",
      remainingPercent: 72,
      resetsAt: null,
      fiveHourRemaining: 72
    }
  };
  assert.equal(
    deriveDialFeedback(
      expandDialPreset("usage"),
      { ...initialDialRuntimeState(), selectedId: "five-hour", usageMode: "five-hour" },
      nullableResetView
    ).detail,
    "RESET UNAVAILABLE"
  );
});

test("feedback replaces live values with honest offline, connecting, and degraded states", () => {
  const expected = {
    offline: ["OFFLINE", "LIVE DATA UNAVAILABLE", "#FF4B61"],
    connecting: ["CONNECTING", "WAITING FOR LIVE DATA", "#FF9A3D"],
    degraded: ["DEGRADED", "LIVE DATA MAY BE STALE", "#FF9A3D"]
  } as const;
  for (const health of ["offline", "connecting", "degraded"] as const) {
    const feedback = deriveDialFeedback(
      expandDialPreset("reasoning"),
      initialDialRuntimeState(),
      { ...RUNTIME_VIEW, health }
    );
    assert.deepEqual(feedback, {
      title: "REASONING",
      value: expected[health][0],
      detail: expected[health][1],
      indicator: 0,
      accent: expected[health][2]
    });
  }
});

test("status-focused presets expand to the approved independent bindings", () => {
  const actionItems = [
    "micro.ACT06", "micro.ACT07", "micro.ACT08", "micro.ACT09", "micro.ACT10_ACT11", "micro.ACT12"
  ];
  assert.deepEqual(DEFAULT_ACTION_SELECTOR_ITEMS, actionItems);
  assert.deepEqual(expandDialPreset("reasoning"), {
    version: 1,
    preset: "reasoning",
    customized: false,
    includeUltraReasoning: false,
    rotation: { kind: "paired", counterClockwise: "reasoning.decrease", clockwise: "reasoning.increase" },
    press: "none",
    touchTap: "keycap.FAST",
    feedback: "reasoning"
  });
  assert.deepEqual(expandDialPreset("agents"), {
    version: 1,
    preset: "agents",
    customized: false,
    includeUltraReasoning: false,
    rotation: { kind: "selector", source: "agents", wrap: true, items: [] },
    press: "selector.activate",
    touchTap: "keycap.TIME",
    feedback: "agent"
  });
  assert.deepEqual(expandDialPreset("actions"), {
    version: 1,
    preset: "actions",
    customized: false,
    includeUltraReasoning: false,
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
    includeUltraReasoning: false,
    rotation: { kind: "paired", counterClockwise: "joystick.left", clockwise: "joystick.right" },
    press: "joystick.up",
    touchTap: "joystick.down",
    feedback: "navigation"
  });
  assert.deepEqual(expandDialPreset("usage"), {
    version: 1,
    preset: "usage",
    customized: false,
    includeUltraReasoning: false,
    rotation: { kind: "selector", source: "usage", wrap: true, items: [] },
    press: "usage.toggle-overview",
    touchTap: "usage.refresh",
    feedback: "usage"
  });
  assert.deepEqual(expandDialPreset("custom"), {
    version: 1,
    preset: "custom",
    customized: false,
    includeUltraReasoning: false,
    rotation: { kind: "paired", counterClockwise: "none", clockwise: "none" },
    press: "none",
    touchTap: "none",
    feedback: "static"
  });
});

test("every dial preset explicitly disables Ultra reasoning", () => {
  for (const preset of DIAL_PRESETS) {
    const settings = expandDialPreset(preset);
    assert.equal(Object.hasOwn(settings, "includeUltraReasoning"), true, preset);
    assert.equal(settings.includeUltraReasoning, false, preset);
  }
});

test("Ultra reasoning normalization accepts only own literal booleans", () => {
  const base = expandDialPreset("reasoning");
  assert.equal(normalizeDialSettings({ ...base, includeUltraReasoning: true }).includeUltraReasoning, true);
  assert.equal(normalizeDialSettings({ ...base, includeUltraReasoning: false }).includeUltraReasoning, false);
  const { includeUltraReasoning: _omitted, ...withoutUltra } = base;
  assert.equal(Object.hasOwn(withoutUltra, "includeUltraReasoning"), false);
  assert.equal(
    normalizeDialSettings(withoutUltra).includeUltraReasoning,
    false,
    "valid legacy settings without the field default false"
  );

  const inheritedTrue = Object.create({ includeUltraReasoning: true }) as Record<string, unknown>;
  Object.assign(inheritedTrue, base);
  delete inheritedTrue.includeUltraReasoning;
  assert.equal(normalizeDialSettings(inheritedTrue).includeUltraReasoning, false);

  for (const value of [
    undefined, null, 0, 1, "false", "true", {}, [], () => true
  ]) {
    const normalized = normalizeDialSettings({ ...base, includeUltraReasoning: value });
    assert.equal(normalized.includeUltraReasoning, false, String(value));
  }
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
    includeUltraReasoning: false,
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

test("runtime normalization matches the property inspector when paired rotation cannot activate a selector", () => {
  const normalized = normalizeDialSettings({
    ...expandDialPreset("agents"),
    customized: true,
    rotation: { kind: "paired", counterClockwise: "none", clockwise: "none" },
    press: "selector.activate"
  });
  assert.equal(normalized.rotation.kind, "paired");
  assert.equal(normalized.press, "none");
  assert.deepEqual(normalizeDialSettings(normalized), normalized);
});

test("normalization ignores inherited top-level settings properties", () => {
  const values = {
    version: 1,
    preset: "custom",
    customized: true,
    includeUltraReasoning: false,
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
    includeUltraReasoning: false,
    rotation: expandDialPreset("custom").rotation,
    press: "none",
    touchTap: "none",
    feedback: "static"
  } as const;
  for (const key of [
    "customized", "includeUltraReasoning", "rotation", "press", "touchTap", "feedback"
  ] as const) {
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
  const requestedItems: string[] = [
    ...OFFICIAL_KEYCAP_IDS.map((id) => `keycap.${id}`),
    ...MICRO_SLOTS.map((slot) => `micro.${slot}`),
    "shell.rm",
    "selector.activate",
    "usage.rate-limit-reset"
  ];
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
