# Stream Deck + Codex Dial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one preset-driven, independently configurable Codex Dial action for Stream Deck + rotation, dial press, touch tap, and live touch-strip feedback.

**Architecture:** A pure dial domain layer owns settings normalization, presets, selectors, tick expansion, and feedback derivation. A thin Stream Deck Encoder action forwards hardware events to registrations managed by `DeckController`, which dispatches only allow-listed typed bindings through existing controller and relay paths. The renderer snapshot gains optional DOM-derived reasoning effort plus an explicit typed usage-refresh command; custom layout feedback is cached per action instance.

**Tech Stack:** TypeScript 5.9, Node.js 20+, `@elgato/streamdeck` 2.1, Stream Deck SDK v2 custom Encoder layouts, Node's built-in test runner through `tsx --test`, HTML/CSS/vanilla JavaScript property inspector, existing CDP bridge and authenticated relay.

---

## Execution rules

- Execute tasks in order because later tasks depend on types and interfaces established earlier.
- Use a fresh implementation subagent for each numbered code task.
- After each task, run a specification-compliance review subagent, then a code-quality review subagent. Fix all accepted findings before the task commit.
- Commit at every task boundary using the exact scoped paths listed in that task.
- Do not commit `.superpowers/`, installed Stream Deck profiles, local bridge metadata, logs, `dist/`, `release/`, or personal paths.
- Preserve unrelated worktree changes. Stage only the paths named in the current task.
- Use `apply_patch` for source edits.
- Follow red-green-refactor: observe the new focused test fail before adding production code.
- Do not change manifest/plugin version numbers.
- Do not run `npm audit fix`; the current lockfile reports pre-existing audit findings and dependency upgrades are outside this feature.

## File map

### New files

- `src/dial-types.ts` — JSON-safe settings, binding IDs, selector/runtime types, and preset constants.
- `src/dial-domain.ts` — settings normalization, binding validation, selector derivation/reconciliation, tick reduction, and feedback derivation.
- `src/dial-action.ts` — Stream Deck `SingletonAction` event adapter for one Encoder action UUID.
- `test/dial-domain.test.ts` — presets, validation, ticks, selectors, and feedback tests.
- `test/dial-action.test.ts` — manifest/build/event-adapter contract tests.
- `static/layouts/codex-dial.json` — 200 x 100 touch-strip feedback layout.
- `static/property-inspector/codex-dial.html` — preset and advanced per-instance configuration UI.
- `static/imgs/dial.svg` and `static/imgs/dial@2x.svg` — original Encoder action artwork.
- `docs/STREAM_DECK_PLUS.md` — user-facing configuration and physical control guide.

### Modified files

- `src/types.ts` — optional normalized reasoning effort on `MicroSnapshot`.
- `src/codex-micro-renderer-bridge.ts` — DOM-derived reasoning effort and forced usage-refresh flag.
- `src/codex-relay-client.ts` — remember advertised relay capabilities for mixed-version command gating.
- `src/relay-protocol.ts` — optional snapshot validation and typed `usage-refresh` command.
- `src/codex-relay-server.ts` — execute the typed usage-refresh command.
- `src/controller.ts` — dial registrations, dispatch, selector state, feedback caching, and rendering.
- `src/plugin.ts` — register `CodexDialAction`.
- `static/manifest.json` — Encoder-only action declaration.
- `scripts/build.mjs` — copy dial layout, property inspector, and images into the plugin bundle.
- `test/micro-bridge.test.ts` — reasoning and force-refresh bridge contracts.
- `test/relay.test.ts` — optional snapshot field and usage-refresh protocol tests.
- `test/release-audit.test.ts` — packaged dial asset presence and private-data boundary.
- `README.md` — feature overview and guide link.
- `docs/ARCHITECTURE.md` — Encoder flow and compatibility boundary.
- `docs/MACOS.md` — physical verification and setup link.
- `docs/WINDOWS.md` — compatibility statement without physical-device claim.

## Task 1: Establish the dial settings and preset domain

**Files:**
- Create: `src/dial-types.ts`
- Create: `src/dial-domain.ts`
- Create: `test/dial-domain.test.ts`

- [ ] **Step 1: Add failing preset and normalization tests**

Create `test/dial-domain.test.ts` with these initial tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ACTION_SELECTOR_ITEMS,
  expandDialPreset,
  normalizeDialSettings
} from "../src/dial-domain.js";

test("status-focused presets expand to the approved independent bindings", () => {
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
  assert.deepEqual(expandDialPreset("actions").rotation, {
    kind: "selector", source: "actions", wrap: true, items: [...DEFAULT_ACTION_SELECTOR_ITEMS]
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
});

test("malformed settings normalize to a safe preset and reject executable strings", () => {
  assert.deepEqual(normalizeDialSettings({}), expandDialPreset("reasoning"));
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
```

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run:

```bash
npx tsx --test test/dial-domain.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/dial-domain.js`.

- [ ] **Step 3: Define JSON-safe dial types and allow-listed IDs**

Create `src/dial-types.ts` with the following exported contracts:

```ts
import type { JsonObject } from "@elgato/utils";

export const DIAL_PRESETS = ["reasoning", "agents", "actions", "navigation", "usage", "custom"] as const;
export type DialPreset = typeof DIAL_PRESETS[number];

export const DIAL_FEEDBACK_MODES = ["auto", "reasoning", "agent", "action", "navigation", "usage", "static"] as const;
export type DialFeedbackMode = typeof DIAL_FEEDBACK_MODES[number];

export const DIAL_SELECTOR_SOURCES = ["agents", "actions", "usage"] as const;
export type DialSelectorSource = typeof DIAL_SELECTOR_SOURCES[number];

export type DialBindingId =
  | "none" | "selector.activate"
  | "reasoning.decrease" | "reasoning.increase"
  | "new-task" | "host.toggle"
  | "usage.refresh" | "usage.toggle-overview" | "usage.rate-limit-reset"
  | `micro.${string}` | `joystick.${string}` | `keycap.${string}`;

export interface PairedDialRotation extends JsonObject {
  kind: "paired";
  counterClockwise: DialBindingId;
  clockwise: DialBindingId;
}

export interface SelectorDialRotation extends JsonObject {
  kind: "selector";
  source: DialSelectorSource;
  wrap: boolean;
  items: DialBindingId[];
}

export type DialRotation = PairedDialRotation | SelectorDialRotation;

export interface CodexDialSettings extends JsonObject {
  version: 1;
  preset: DialPreset;
  customized: boolean;
  rotation: DialRotation;
  press: DialBindingId;
  touchTap: DialBindingId;
  feedback: DialFeedbackMode;
  staticLabel?: string;
}

export type DialSelectorItem = {
  id: string;
  label: string;
  detail?: string;
  binding?: DialBindingId;
  agentSlot?: number;
  threadKey?: string;
};

export type DialRuntimeState = {
  selectedId?: string;
  usageMode: "auto" | "five-hour" | "weekly";
  usageOverview: boolean;
};

export type DialFeedback = {
  title: string;
  value: string;
  detail: string;
  indicator: number;
  accent: string;
};
```

- [ ] **Step 4: Implement preset expansion and strict normalization**

Create `src/dial-domain.ts`. Export these constants and functions:

```ts
import { OFFICIAL_KEYCAP_IDS } from "./keycaps.js";
import type {
  CodexDialSettings, DialBindingId, DialFeedbackMode, DialPreset, DialRotation
} from "./dial-types.js";

export const MICRO_SLOTS = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"] as const;
export const JOYSTICK_DIRECTIONS = ["up", "right", "down", "left"] as const;
export const DEFAULT_ACTION_SELECTOR_ITEMS: readonly DialBindingId[] = MICRO_SLOTS.map((slot): DialBindingId => `micro.${slot}`);

export function expandDialPreset(preset: DialPreset): CodexDialSettings {
  if (preset === "agents") return selectorPreset("agents", "selector.activate", "keycap.TIME", "agent");
  if (preset === "actions") return selectorPreset("actions", "selector.activate", "keycap.SETUP", "action", [...DEFAULT_ACTION_SELECTOR_ITEMS]);
  if (preset === "usage") return selectorPreset("usage", "usage.toggle-overview", "usage.refresh", "usage");
  if (preset === "navigation") return pairedPreset("navigation", "joystick.left", "joystick.right", "joystick.up", "joystick.down", "navigation");
  if (preset === "custom") return pairedPreset("custom", "none", "none", "none", "none", "static");
  return pairedPreset("reasoning", "reasoning.decrease", "reasoning.increase", "none", "keycap.FAST", "reasoning");
}

export function isDialBindingId(value: unknown, gesture: "rotation" | "press" | "touch" | "selector" = "press"): value is DialBindingId {
  if (typeof value !== "string") return false;
  const valid = value === "none" || value === "selector.activate" || value === "reasoning.decrease" ||
    value === "reasoning.increase" || value === "new-task" || value === "host.toggle" ||
    value === "usage.refresh" || value === "usage.toggle-overview" || value === "usage.rate-limit-reset" ||
    (value.startsWith("micro.") && MICRO_SLOTS.includes(value.slice(6) as typeof MICRO_SLOTS[number])) ||
    (value.startsWith("joystick.") && JOYSTICK_DIRECTIONS.includes(value.slice(9) as typeof JOYSTICK_DIRECTIONS[number])) ||
    (value.startsWith("keycap.") && OFFICIAL_KEYCAP_IDS.includes(value.slice(7) as typeof OFFICIAL_KEYCAP_IDS[number]));
  if (!valid) return false;
  if (value === "usage.rate-limit-reset" && gesture !== "press") return false;
  if (value === "selector.activate" && gesture !== "press") return false;
  return true;
}

export function normalizeDialSettings(input: unknown): CodexDialSettings {
  if (!record(input) || input.version !== 1 || !isPreset(input.preset)) return expandDialPreset("reasoning");
  const fallback = expandDialPreset(input.preset);
  const rotation = normalizeRotation(input.rotation, fallback.rotation);
  const feedback = isFeedback(input.feedback) ? input.feedback : fallback.feedback;
  const staticLabel = typeof input.staticLabel === "string" ? input.staticLabel.trim().slice(0, 40) : undefined;
  return {
    version: 1,
    preset: input.preset,
    customized: input.customized === true,
    rotation,
    press: isDialBindingId(input.press, "press") ? input.press : fallback.press,
    touchTap: isDialBindingId(input.touchTap, "touch") ? input.touchTap : "none",
    feedback,
    ...(staticLabel ? { staticLabel } : {})
  };
}
```

Also implement private `record`, `isPreset`, `isFeedback`, `pairedPreset`, `selectorPreset`, and `normalizeRotation` helpers. `normalizeRotation` must preserve the chosen paired/selector kind, validate selector source, validate `wrap`, remove invalid action items, cap action items at 30, and fall back to the preset rotation when the structure is invalid.

- [ ] **Step 5: Run the focused tests until green**

Run:

```bash
npx tsx --test test/dial-domain.test.ts
npm run check
```

Expected: both commands exit 0; the focused runner reports 2 passing tests.

- [ ] **Step 6: Run two-stage subagent review and fix accepted findings**

Dispatch a specification-compliance reviewer with the approved design spec and Task 1 diff. Then dispatch a code-quality reviewer with the same diff. Re-run the two commands from Step 5 after fixes.

- [ ] **Step 7: Commit the dial settings slice**

```bash
git add src/dial-types.ts src/dial-domain.ts test/dial-domain.test.ts
git commit -m "feat: add configurable Codex dial presets"
```

## Task 2: Add selector reduction, tick expansion, and feedback derivation

**Files:**
- Modify: `src/dial-types.ts`
- Modify: `src/dial-domain.ts`
- Modify: `test/dial-domain.test.ts`

- [ ] **Step 1: Add failing selector and feedback tests**

Append tests that exercise exact detent counts, selector preview, stable agent identity, and usage feedback:

```ts
import {
  deriveDialFeedback, initialDialRuntimeState, reconcileSelector, reduceDialRotation,
  selectorItems
} from "../src/dial-domain.js";
import type { DialRuntimeView } from "../src/dial-types.js";

const view: DialRuntimeView = {
  health: "ready",
  reasoningEffort: "high",
  agents: [
    { id: 0, identity: "mac:thread-a", threadKey: "thread-a", title: "Build", status: "working", contextUsedPercent: 42 },
    { id: 2, identity: "mac:thread-c", threadKey: "thread-c", title: "Review", status: "idle" }
  ],
  actionLabels: { "micro.ACT06": "Fast", "micro.ACT07": "Approve" },
  usage: {
    mode: "five-hour", remainingPercent: 72, resetsAt: 1_800_000, observedAt: 1_000_000,
    fiveHourRemaining: 72, weeklyRemaining: 81
  },
  now: 1_000_000
};

test("paired rotation expands every detent in order", () => {
  const settings = expandDialPreset("reasoning");
  assert.deepEqual(reduceDialRotation(settings, initialDialRuntimeState(), view, -3).bindings,
    ["reasoning.decrease", "reasoning.decrease", "reasoning.decrease"]);
  assert.deepEqual(reduceDialRotation(settings, initialDialRuntimeState(), view, 2).bindings,
    ["reasoning.increase", "reasoning.increase"]);
});

test("agent selector previews without dispatch and reconciles by stable identity", () => {
  const settings = expandDialPreset("agents");
  const items = selectorItems(settings, view);
  assert.deepEqual(items.map(({ id }) => id), ["mac:thread-a", "mac:thread-c"]);
  const rotated = reduceDialRotation(settings, initialDialRuntimeState(), view, 1);
  assert.deepEqual(rotated.bindings, []);
  assert.equal(rotated.state.selectedId, "mac:thread-c");
  assert.equal(reconcileSelector(rotated.state, [items[1]!, items[0]!]).selectedId, "mac:thread-c");
});

test("feedback reports live reasoning and usage without inventing unavailable state", () => {
  assert.deepEqual(deriveDialFeedback(expandDialPreset("reasoning"), initialDialRuntimeState(), view), {
    title: "REASONING", value: "HIGH", detail: "TURN TO ADJUST", indicator: 100, accent: "#7f8cff"
  });
  const unavailable = deriveDialFeedback(expandDialPreset("reasoning"), initialDialRuntimeState(), { ...view, reasoningEffort: undefined });
  assert.equal(unavailable.value, "UNAVAILABLE");
  const usage = deriveDialFeedback(expandDialPreset("usage"), { ...initialDialRuntimeState(), usageMode: "five-hour" }, view);
  assert.equal(usage.value, "72% LEFT");
  assert.match(usage.detail, /RESET/);
});
```

- [ ] **Step 2: Run the focused tests and confirm symbol failures**

Run `npx tsx --test test/dial-domain.test.ts`.

Expected: FAIL because the new runtime functions and `DialRuntimeView` are not exported.

- [ ] **Step 3: Add runtime-view and reducer types**

Append these contracts to `src/dial-types.ts`:

```ts
export type DialRuntimeAgent = {
  id: number;
  identity: string;
  threadKey: string;
  title: string;
  status: string;
  contextUsedPercent?: number;
};

export type DialRuntimeUsage = {
  mode: "auto" | "five-hour" | "weekly";
  remainingPercent?: number;
  resetsAt?: number | null;
  observedAt?: number;
  fiveHourRemaining?: number;
  weeklyRemaining?: number;
};

export type DialRuntimeView = {
  health: "ready" | "degraded" | "offline" | "connecting";
  reasoningEffort?: string;
  agents: DialRuntimeAgent[];
  actionLabels: Partial<Record<DialBindingId, string>>;
  usage?: DialRuntimeUsage;
  now: number;
};
```

- [ ] **Step 4: Implement pure selector and feedback functions**

In `src/dial-domain.ts`, export:

```ts
export function initialDialRuntimeState(): DialRuntimeState {
  return { usageMode: "auto", usageOverview: false };
}

export function selectorItems(settings: CodexDialSettings, view: DialRuntimeView): DialSelectorItem[] {
  if (settings.rotation.kind !== "selector") return [];
  if (settings.rotation.source === "agents") return view.agents.map((agent) => ({
    id: agent.identity, label: agent.title || `Agent ${agent.id + 1}`, detail: agent.status,
    agentSlot: agent.id, threadKey: agent.threadKey
  }));
  if (settings.rotation.source === "usage") return [
    { id: "auto", label: "Automatic" },
    { id: "five-hour", label: "5 hours" },
    { id: "weekly", label: "Weekly" }
  ];
  return settings.rotation.items.map((binding) => ({
    id: binding, binding, label: view.actionLabels[binding] ?? bindingLabel(binding)
  }));
}

export function reconcileSelector(state: DialRuntimeState, items: DialSelectorItem[]): DialRuntimeState {
  if (!items.length) return { ...state, selectedId: undefined };
  return items.some(({ id }) => id === state.selectedId) ? state : { ...state, selectedId: items[0]!.id };
}

export function reduceDialRotation(
  settings: CodexDialSettings, state: DialRuntimeState, view: DialRuntimeView, ticks: number
): { state: DialRuntimeState; bindings: DialBindingId[] } {
  const count = Number.isFinite(ticks) ? Math.trunc(ticks) : 0;
  if (!count) return { state, bindings: [] };
  if (settings.rotation.kind === "paired") {
    const binding = count > 0 ? settings.rotation.clockwise : settings.rotation.counterClockwise;
    return { state, bindings: Array.from({ length: Math.abs(count) }, () => binding) };
  }
  const items = selectorItems(settings, view);
  const current = reconcileSelector(state, items);
  if (!items.length) return { state: current, bindings: [] };
  const index = Math.max(0, items.findIndex(({ id }) => id === current.selectedId));
  const raw = index + count;
  const next = settings.rotation.wrap
    ? ((raw % items.length) + items.length) % items.length
    : Math.min(items.length - 1, Math.max(0, raw));
  const selected = items[next]!;
  return {
    state: {
      ...current,
      selectedId: selected.id,
      ...(settings.rotation.source === "usage" ? { usageMode: selected.id as DialRuntimeState["usageMode"] } : {})
    },
    bindings: []
  };
}
```

Implement `deriveDialFeedback` for all seven feedback modes. `auto` follows the paired preset or selector source. The function must uppercase and truncate display strings, use `UNAVAILABLE`, `OFFLINE`, `CONNECTING`, or `DEGRADED` based on health, calculate a bounded 0–100 indicator, calculate usage reset countdown from `view.now`, and return only the five stable layout fields in `DialFeedback`. Implement and export `selectedItem(settings, state, view)` for press activation.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
npx tsx --test test/dial-domain.test.ts
npm run check
```

Expected: all dial-domain tests pass and TypeScript exits 0.

- [ ] **Step 6: Run two-stage subagent review, fix, and re-run Step 5**

The specification reviewer must specifically check no selector executes during rotation and no unavailable reasoning value is guessed. The quality reviewer must check bounded ticks, empty selectors, stable identity, and display truncation.

- [ ] **Step 7: Commit the reducer and feedback slice**

```bash
git add src/dial-types.ts src/dial-domain.ts test/dial-domain.test.ts
git commit -m "feat: add dial selectors and live feedback model"
```

## Task 3: Extend snapshots with reasoning effort and typed usage refresh

**Files:**
- Modify: `src/types.ts`
- Modify: `src/codex-micro-renderer-bridge.ts`
- Modify: `src/codex-relay-client.ts`
- Modify: `src/relay-protocol.ts`
- Modify: `src/codex-relay-server.ts`
- Modify: `src/controller.ts`
- Modify: `test/micro-bridge.test.ts`
- Modify: `test/relay.test.ts`

- [ ] **Step 1: Add failing bridge and relay contract tests**

Append to `test/micro-bridge.test.ts`:

```ts
test("renderer snapshot reads current reasoning effort from the live composer and supports forced usage refresh", async () => {
  const source = await readFile(new URL("../src/codex-micro-renderer-bridge.ts", import.meta.url), "utf8");
  assert.match(source, /data-selected-reasoning-effort/);
  assert.match(source, /reasoningEffort/);
  assert.match(source, /codex-deck-force-rate-limit-refresh/);
  assert.match(source, /requestUsageRefresh/);
});
```

Append to `test/relay.test.ts`:

```ts
test("relay accepts optional bounded reasoning effort and typed usage refresh", async () => {
  const { parseRelayServerMessage } = await import("../src/relay-protocol.js");
  const valid = { type: "snapshot", protocol: 1, host, observedAt: 1, snapshot: { ...structuredClone(snapshot), reasoningEffort: "high" } };
  assert.notEqual(parseRelayServerMessage(valid), null);
  valid.snapshot.reasoningEffort = "x".repeat(65);
  assert.equal(parseRelayServerMessage(valid), null);
  assert.deepEqual(parseRelayCommand({ kind: "usage-refresh" }), { kind: "usage-refresh" });
});
```

- [ ] **Step 2: Run focused tests and observe failures**

```bash
npx tsx --test test/micro-bridge.test.ts test/relay.test.ts
```

Expected: FAIL because the source lacks the new marker/method and the relay rejects `usage-refresh`.

- [ ] **Step 3: Add the optional snapshot field**

In `src/types.ts`, add to `MicroSnapshot`:

```ts
/** Current composer effort read from the active Codex reasoning trigger when available. */
reasoningEffort?: string;
```

In `SNAPSHOT_EXPRESSION`, after active-thread discovery, read only the active renderer DOM attribute:

```js
const reasoningCandidate = document.querySelector('[data-selected-reasoning-effort]')
  ?.getAttribute('data-selected-reasoning-effort')?.trim();
const reasoningEffort = reasoningCandidate && reasoningCandidate.length <= 64
  ? reasoningCandidate
  : undefined;
```

Include `...(reasoningEffort ? { reasoningEffort } : {})` in the returned snapshot. Do not infer it from encoder history.

- [ ] **Step 4: Add an explicit force-refresh flag**

Inside the existing usage-query block, consume this global flag:

```js
const forceRefreshKey = Symbol.for('codex-deck-force-rate-limit-refresh');
const forceRefresh = globalThis[forceRefreshKey] === true;
if (forceRefresh) delete globalThis[forceRefreshKey];
```

When `forceRefresh` is true and `query.fetch` exists, await `query.fetch()` before reading `query.state.data`; keep the current non-blocking 15-second behavior for normal background refreshes.

Add this method to `CodexMicroRendererBridge`:

```ts
async requestUsageRefresh(): Promise<MicroSnapshot> {
  await this.ensureConnected();
  await this.evaluate(`(() => { globalThis[Symbol.for('codex-deck-force-rate-limit-refresh')] = true; return true; })()`);
  return this.refresh();
}
```

- [ ] **Step 5: Extend the relay with capability-gated `usage-refresh`**

Add `{ kind: "usage-refresh" }` to `RelayCommand`, add `"usage-refresh"` to `RELAY_CAPABILITIES`, accept the exact object in `parseRelayCommand`, and add `refreshUsage(): Promise<void>` to the relay control interface. In `executeRelayCommand`:

```ts
if (command.kind === "usage-refresh") return control.refreshUsage();
```

The repository parser is named `parseRelayCommand`; add this exact branch before the keycap fallback:

```ts
if (value.kind === "usage-refresh" && Object.keys(value).length === 1) return value as RelayCommand;
```

Validate `snapshot.reasoningEffort` with:

```ts
if (value.reasoningEffort != null &&
    (typeof value.reasoningEffort !== "string" || value.reasoningEffort.length < 1 || value.reasoningEffort.length > 64)) return false;
```

In the controller's mobile relay control object, implement:

```ts
refreshUsage: () => runAndInvalidate(async () => {
  await this.microBridge.requestUsageRefresh();
})
```

In `CodexRelayClient`, store ready-message capabilities and expose exact gating:

```ts
private capabilities = new Set<string>();

supportsCapability(capability: string): boolean {
  return this.capabilities.has(capability);
}
```

On a `ready` message assign `this.capabilities = new Set(message.capabilities ?? [])`; clear it in `close()` and `disconnected()`.

Add a controller method that refreshes the healthy account source. For a remote source, send `usage-refresh` only when the remote advertises that capability; otherwise throw `Remote Codex host does not support usage refresh.` For local source, call `requestUsageRefresh`, update `localSnapshot`, and invoke `refreshDisplay`.

- [ ] **Step 6: Run focused and full relay tests**

```bash
npx tsx --test test/micro-bridge.test.ts test/relay.test.ts
npm run check
```

Expected: focused tests pass and typecheck exits 0.

- [ ] **Step 7: Run two-stage subagent review and fix accepted findings**

The specification reviewer checks optional mixed-version compatibility and account-scoped routing. The quality reviewer checks the force flag is consumed once, normal refresh remains non-blocking, the 64-character bound is enforced, and unsupported remote capability fails honestly.

- [ ] **Step 8: Commit the snapshot and refresh slice**

```bash
git add src/types.ts src/codex-micro-renderer-bridge.ts src/codex-relay-client.ts src/relay-protocol.ts src/codex-relay-server.ts src/controller.ts test/micro-bridge.test.ts test/relay.test.ts
git commit -m "feat: expose reasoning and refresh usage snapshots"
```

## Task 4: Add controller-managed dial registrations and typed dispatch

**Files:**
- Modify: `src/dial-types.ts`
- Modify: `src/dial-domain.ts`
- Modify: `src/controller.ts`
- Modify: `test/dial-domain.test.ts`

- [ ] **Step 1: Add failing command-lifecycle and queue tests**

Add pure lifecycle helpers to the test imports, then append:

```ts
test("binding lifecycle distinguishes momentary and one-shot commands", () => {
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
});
```

- [ ] **Step 2: Run the focused test and observe missing exports**

Run `npx tsx --test test/dial-domain.test.ts`.

Expected: FAIL because `bindingLifecycle` and `DialCommandQueue` are missing.

- [ ] **Step 3: Implement lifecycle classification and serialized queue**

In `src/dial-domain.ts`, export:

```ts
export function bindingLifecycle(binding: DialBindingId): "none" | "one-shot" | "momentary" | "hold" {
  if (binding === "none") return "none";
  if (binding === "usage.rate-limit-reset") return "hold";
  if (binding.startsWith("micro.") || binding.startsWith("joystick.")) return "momentary";
  return "one-shot";
}

export class DialCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  enqueue(operation: () => Promise<void>): void {
    this.tail = this.tail.then(operation, operation).catch(() => undefined);
  }
  idle(): Promise<void> { return this.tail; }
}
```

- [ ] **Step 4: Add controller dial registrations**

Import `DialAction` and the dial domain/types. Add:

```ts
type DialRegistration = {
  action: DialAction;
  settings: CodexDialSettings;
  state: DialRuntimeState;
  queue: DialCommandQueue;
  pressed?: { binding: DialBindingId; item?: DialSelectorItem };
  lastFeedback?: string;
};
```

Add `private readonly dials = new Map<string, DialRegistration>();` and these public methods:

```ts
registerDial(action: DialAction, input: unknown): void;
updateDialSettings(action: DialAction, input: unknown): void;
unregisterDial(action: { id: string }): void;
rotateDial(action: DialAction, ticks: number): void;
beginDialPress(action: DialAction): Promise<void>;
finishDialPress(action: DialAction): Promise<void>;
touchDial(action: DialAction): Promise<void>;
```

Requirements for their bodies:

- Normalize every settings payload.
- Keep selector state per action ID.
- Use `reduceDialRotation`; enqueue every returned paired binding and render selectors immediately.
- Resolve `selector.activate` to the current selected agent/action.
- Save the resolved pressed binding so release goes to the same host/command even if selection changes.
- Momentary bindings dispatch down on press and up on release.
- One-shot press bindings run on dial down only.
- Touch momentary bindings run down then up in the same queue operation.
- Hold binding calls existing `beginRateLimitReset` and `finishRateLimitReset` using the dial action identity.
- A successful rate-limit reset release calls `action.showOk()`; a short hold remains a no-op.
- `usage.toggle-overview` flips only that registration's `state.usageOverview`, then re-renders it.
- `selector.activate` resolves the selected item at dial down and stores that resolved item through dial up.
- `none` is a no-op.
- Any dispatch error logs one concise message and calls `action.showAlert()`.

Map typed bindings only to existing methods:

```ts
"reasoning.decrease" -> adjustReasoning("decrease")
"reasoning.increase" -> adjustReasoning("increase")
"new-task" -> createTask()
"host.toggle" -> toggleTargetHost()
"usage.refresh" -> refreshUsage()
"micro.<slot>" -> sendMicroAction(slot, act)
"joystick.<direction>" -> sendJoystick(direction, act)
"keycap.<id>" -> runKeycap(id) on down only
```

Extend `sendAgent` to `sendAgent(slot: number, act: 0 | 1, expectedThreadKey?: string)`. Agent selector activation must call `sendAgent(item.agentSlot, act, item.threadKey)` and reject down dispatch when the current routed slot no longer has the expected thread key. Existing keypad callers omit the third argument. Do not accept arbitrary strings beyond `isDialBindingId`.

- [ ] **Step 5: Build the runtime view and render feedback**

Add private `dialRuntimeView(settings, state)` and `renderDial(registration)` methods. The view uses:

- `targetHealth()` for ordinary dial health.
- `targetSnapshot()?.reasoningEffort` for reasoning.
- `routedSlots` filtered to entries with `threadKey`, with identity `${host.hostId}:${threadKey}`.
- Current Micro layout keycap IDs mapped to human labels.
- `accountUsageSource()` and `selectUsageWindow` for usage.

Call `action.setFeedback` only when `JSON.stringify(feedback)` differs from `registration.lastFeedback`, mapping the color string to the bar definition:

```ts
await action.setFeedback({
  title: feedback.title,
  value: feedback.value,
  detail: feedback.detail,
  indicator: feedback.indicator,
  accent: { value: 100, bar_fill_c: feedback.accent }
});
```

Add all registered dials to `renderAll()`.

On register and settings update, call `action.setTriggerDescription` with instance-specific descriptions derived from normalized settings. Use `Rotate: "Adjust"` for paired mode or `Rotate: "Select"` for selectors; use the configured press/touch labels for `Push` and `Touch`. Failure to update descriptions is logged once per distinct error and does not stop feedback rendering.

- [ ] **Step 6: Run tests and typecheck**

```bash
npx tsx --test test/dial-domain.test.ts
npm run check
```

Expected: tests pass and TypeScript exits 0.

- [ ] **Step 7: Run two-stage subagent review and fix accepted findings**

The specification reviewer checks host routing, no rotation confirmation, no selector execution during rotation, independent per-action state, and hold protection. The quality reviewer checks release uses the saved pressed binding, queue errors do not poison later operations, settings normalization occurs at every boundary, and feedback caching is effective.

- [ ] **Step 8: Commit the controller runtime slice**

```bash
git add src/dial-types.ts src/dial-domain.ts src/controller.ts test/dial-domain.test.ts
git commit -m "feat: dispatch configurable Codex dial gestures"
```

## Task 5: Register the Stream Deck Encoder action and feedback layout

**Files:**
- Create: `src/dial-action.ts`
- Create: `test/dial-action.test.ts`
- Create: `static/layouts/codex-dial.json`
- Create: `static/imgs/dial.svg`
- Create: `static/imgs/dial@2x.svg`
- Modify: `src/plugin.ts`
- Modify: `static/manifest.json`
- Modify: `scripts/build.mjs`

- [ ] **Step 1: Add failing manifest, layout, build, and adapter tests**

Create `test/dial-action.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("manifest exposes one Encoder-only Codex Dial with a custom layout", async () => {
  const manifest = JSON.parse(await text("static/manifest.json")) as {
    Actions: Array<{ UUID: string; Controllers?: string[]; Encoder?: { layout?: string; TriggerDescription?: object } }>;
  };
  const dial = manifest.Actions.find(({ UUID }) => UUID === "com.simeo.codex-deck.codex-dial");
  assert.deepEqual(dial?.Controllers, ["Encoder"]);
  assert.equal(dial?.Encoder?.layout, "static/layouts/codex-dial.json");
  assert.deepEqual(Object.keys(dial?.Encoder?.TriggerDescription ?? {}).sort(), ["Push", "Rotate", "Touch"]);
});

test("dial action forwards all four Encoder event families", async () => {
  const source = await text("src/dial-action.ts");
  for (const handler of ["onDialRotate", "onDialDown", "onDialUp", "onTouchTap"]) assert.match(source, new RegExp(handler));
  assert.match(source, /action\.isDial\(\)/);
  assert.doesNotMatch(source, /onKeyDown|onKeyUp/);
});

test("custom layout stays inside the 200 by 100 Encoder canvas", async () => {
  const layout = JSON.parse(await text("static/layouts/codex-dial.json")) as { items: Array<{ key: string; rect: number[] }> };
  assert.deepEqual(layout.items.map(({ key }) => key).sort(), ["accent", "detail", "indicator", "title", "value"]);
  for (const { rect: [x, y, width, height] } of layout.items) {
    assert.ok(x >= 0 && y >= 0 && x + width <= 200 && y + height <= 100);
  }
});

test("build copies every Encoder asset", async () => {
  const source = await text("scripts/build.mjs");
  for (const path of ["codex-dial.html", "codex-dial.json", "dial.svg", "dial@2x.svg"]) assert.match(source, new RegExp(path.replace(".", "\\.")));
});
```

- [ ] **Step 2: Run the new test and observe failures**

Run `npx tsx --test test/dial-action.test.ts`.

Expected: FAIL because the adapter/layout do not exist and the manifest lacks the action.

- [ ] **Step 3: Create the thin Encoder event adapter**

Create `src/dial-action.ts`:

```ts
import {
  action, type DialDownEvent, type DialRotateEvent, type DialUpEvent,
  type DidReceiveSettingsEvent, SingletonAction, type TouchTapEvent,
  type WillAppearEvent, type WillDisappearEvent
} from "@elgato/streamdeck";
import type { DeckController } from "./controller.js";
import type { CodexDialSettings } from "./dial-types.js";

@action({ UUID: "com.simeo.codex-deck.codex-dial" })
export class CodexDialAction extends SingletonAction<CodexDialSettings> {
  constructor(private readonly controller: DeckController) { super(); }

  override onWillAppear(ev: WillAppearEvent<CodexDialSettings>): void {
    if (ev.action.isDial()) this.controller.registerDial(ev.action, ev.payload.settings);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<CodexDialSettings>): void {
    if (ev.action.isDial()) this.controller.updateDialSettings(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<CodexDialSettings>): void {
    this.controller.unregisterDial(ev.action);
  }
  override onDialRotate(ev: DialRotateEvent<CodexDialSettings>): void {
    this.controller.rotateDial(ev.action, ev.payload.ticks);
  }
  override async onDialDown(ev: DialDownEvent<CodexDialSettings>): Promise<void> {
    await this.controller.beginDialPress(ev.action);
  }
  override async onDialUp(ev: DialUpEvent<CodexDialSettings>): Promise<void> {
    await this.controller.finishDialPress(ev.action);
  }
  override async onTouchTap(ev: TouchTapEvent<CodexDialSettings>): Promise<void> {
    if (!ev.payload.hold) await this.controller.touchDial(ev.action);
  }
}
```

Register `new CodexDialAction(controller)` in `src/plugin.ts`.

- [ ] **Step 4: Add the Encoder manifest entry**

Add one action object without changing existing action objects:

```json
{
  "UUID": "com.simeo.codex-deck.codex-dial",
  "Name": "Codex Dial",
  "Tooltip": "Configurable Stream Deck + dial with independent rotation, press, touch, and live Codex feedback.",
  "Icon": "static/imgs/category-icon",
  "PropertyInspectorPath": "static/property-inspector/codex-dial.html",
  "Controllers": ["Encoder"],
  "Encoder": {
    "Icon": "static/imgs/dial",
    "layout": "static/layouts/codex-dial.json",
    "StackColor": "#7F8CFF",
    "TriggerDescription": {
      "Rotate": "Adjust or select",
      "Push": "Run the configured press action",
      "Touch": "Run the configured touch action"
    }
  },
  "States": [{ "Image": "static/imgs/key", "Title": "" }]
}
```

- [ ] **Step 5: Create and validate the custom layout**

Create `static/layouts/codex-dial.json` with exactly five keyed items:

```json
{
  "$schema": "https://schemas.elgato.com/streamdeck/plugins/layout.json",
  "id": "com.simeo.codex-deck.codex-dial.layout",
  "items": [
    { "key": "accent", "type": "bar", "rect": [8, 88, 184, 6], "value": 100, "range": { "min": 0, "max": 100 }, "bar_bg_c": "#242838", "bar_fill_c": "#7F8CFF", "border_w": 0 },
    { "key": "title", "type": "text", "rect": [10, 5, 180, 20], "value": "CODEX", "font": { "size": 12, "weight": 600 }, "color": "#AEB7FF", "alignment": "center" },
    { "key": "value", "type": "text", "rect": [8, 25, 184, 34], "value": "READY", "font": { "size": 24, "weight": 700 }, "color": "#F4F6FF", "alignment": "center" },
    { "key": "detail", "type": "text", "rect": [8, 61, 184, 20], "value": "TURN OR PRESS", "font": { "size": 11, "weight": 500 }, "color": "#AAB0C2", "alignment": "center" },
    { "key": "indicator", "type": "bar", "rect": [8, 82, 184, 4], "value": 0, "range": { "min": 0, "max": 100 }, "bar_bg_c": "#242838", "bar_fill_c": "#7F8CFF", "border_w": 0 }
  ]
}
```

- [ ] **Step 6: Add original dial icons and build copies**

Create `static/imgs/dial.svg` as original artwork:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
  <circle cx="36" cy="36" r="31" fill="#171a24" stroke="#7f8cff" stroke-width="4"/>
  <circle cx="36" cy="36" r="22" fill="#252a3a" stroke="#454d69" stroke-width="2"/>
  <path d="M36 12v12" stroke="#f4f6ff" stroke-width="4" stroke-linecap="round"/>
</svg>
```

Create `static/imgs/dial@2x.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <circle cx="72" cy="72" r="62" fill="#171a24" stroke="#7f8cff" stroke-width="8"/>
  <circle cx="72" cy="72" r="44" fill="#252a3a" stroke="#454d69" stroke-width="4"/>
  <path d="M72 24v24" stroke="#f4f6ff" stroke-width="8" stroke-linecap="round"/>
</svg>
```

These assets must not contain copied Codex or Elgato artwork.

Update `scripts/build.mjs` to create `static/layouts` in the output and copy:

```text
static/imgs/dial.svg
static/imgs/dial@2x.svg
static/layouts/codex-dial.json
static/property-inspector/codex-dial.html
```

The property inspector file is added in Task 6; Task 5's build test may remain red only for that missing file until Task 6 if `cp` executes during `npm run build`. To keep every task green, create a minimal valid `codex-dial.html` in Task 5 containing the Stream Deck socket registration and no fields, then replace it in Task 6.

- [ ] **Step 7: Run focused tests, build, and Stream Deck validation**

```bash
npx tsx --test test/dial-action.test.ts
npm run check
npm run validate
```

Expected: tests pass, typecheck exits 0, build succeeds, and `streamdeck validate` reports a valid plugin.

- [ ] **Step 8: Run two-stage subagent review and fix accepted findings**

The specification reviewer checks a single Encoder-only action, all event families, no keypad regression, and original assets. The quality reviewer checks `isDial`, touch-hold handling, layout bounds/schema, manifest paths, and build copies.

- [ ] **Step 9: Commit the Encoder integration slice**

```bash
git add src/dial-action.ts src/plugin.ts static/manifest.json static/layouts/codex-dial.json static/imgs/dial.svg static/imgs/dial@2x.svg static/property-inspector/codex-dial.html scripts/build.mjs test/dial-action.test.ts
git commit -m "feat: register the Stream Deck Plus Codex Dial"
```

## Task 6: Build the configurable property inspector

**Files:**
- Modify: `static/property-inspector/codex-dial.html`
- Modify: `test/dial-action.test.ts`

- [ ] **Step 1: Add failing property-inspector contract tests**

Append:

```ts
test("property inspector exposes presets and independent gesture controls", async () => {
  const source = await text("static/property-inspector/codex-dial.html");
  for (const id of ["preset", "rotation-kind", "counter-clockwise", "clockwise", "selector-source", "selector-items", "wrap", "press", "touch-tap", "feedback", "static-label"]) {
    assert.match(source, new RegExp(`id=["']${id}["']`));
  }
  assert.match(source, /setSettings/);
  assert.match(source, /version:\s*1/);
  assert.match(source, /customized:\s*true/);
  assert.match(source, /usage\.rate-limit-reset/);
});
```

- [ ] **Step 2: Run the focused test and observe missing controls**

Run `npx tsx --test test/dial-action.test.ts`.

Expected: FAIL on the first missing field ID.

- [ ] **Step 3: Implement the full property inspector**

Replace the minimal inspector with a dark, responsive form using the exact field IDs from Step 1. The JavaScript must:

1. Register the property inspector socket using `connectElgatoStreamDeckSocket`.
2. Parse incoming settings and default to the Reasoning preset.
3. Hold a local `PRESETS` object matching `expandDialPreset` exactly.
4. Populate binding selects from a hard-coded allow-listed catalog grouped as None, Selector, Reasoning, Agents/actions, Navigation, Codex keycaps, Usage, and Host.
5. Hide paired controls in selector mode and selector controls in paired mode.
6. Show selector item checkboxes with up/down ordering controls only for the Actions source.
7. Show static label only for static feedback.
8. Exclude `usage.rate-limit-reset` from rotation and touch catalogs; include it in press.
9. On preset change, replace all fields with the chosen preset and persist `customized: false`.
10. On any other field change, serialize the complete version-1 settings and persist `customized: true`.
11. Cap the static label at 40 characters and selected action items at 30.
12. Send only `setSettings`; do not send arbitrary plugin messages.

Use this persistence function verbatim:

```js
function persist(customized = true) {
  const payload = readForm();
  payload.version = 1;
  payload.customized = customized;
  settings = payload;
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ event: "setSettings", context, payload }));
  }
}
```

Every catalog value must match `isDialBindingId`; do not expose user-entered command IDs.

- [ ] **Step 4: Run focused tests and validate the bundle**

```bash
npx tsx --test test/dial-action.test.ts
npm run validate
```

Expected: property-inspector tests pass and plugin validation succeeds.

- [ ] **Step 5: Run two-stage subagent review and fix accepted findings**

The specification reviewer checks preset parity and independent controls. The quality reviewer compares every UI value to runtime allow lists, checks reset-credit restrictions, verifies ordered selector serialization, and tests reconnect/settings initialization logic by inspection.

- [ ] **Step 6: Commit the property inspector slice**

```bash
git add static/property-inspector/codex-dial.html test/dial-action.test.ts
git commit -m "feat: configure Codex dials per knob"
```

## Task 7: Document the feature and strengthen packaged-artifact checks

**Files:**
- Create: `docs/STREAM_DECK_PLUS.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/MACOS.md`
- Modify: `docs/WINDOWS.md`
- Modify: `test/release-audit.test.ts`

- [ ] **Step 1: Add failing documentation and artifact tests**

Extend the `test/release-audit.test.ts` imports with `existsSync` from `node:fs` and `fileURLToPath` from `node:url`. Append a test that runs `npm run build`, then asserts these bundle paths exist:

```ts
const packaged = fileURLToPath(new URL("../dist/com.simeo.codex-deck.sdPlugin/", import.meta.url));
for (const relative of [
  "static/property-inspector/codex-dial.html",
  "static/layouts/codex-dial.json",
  "static/imgs/dial.svg",
  "static/imgs/dial@2x.svg"
]) assert.equal(existsSync(join(packaged, relative)), true, `missing ${relative}`);
```

Add a documentation contract test in `test/dial-action.test.ts` that asserts `README.md` links `docs/STREAM_DECK_PLUS.md` and that the guide contains `Reasoning`, `Agents`, `Actions`, `Usage`, `rotate`, `press`, `touch`, `macOS`, and `Windows`.

- [ ] **Step 2: Run focused tests and observe the missing guide failure**

```bash
npx tsx --test test/dial-action.test.ts test/release-audit.test.ts
```

Expected: FAIL because `docs/STREAM_DECK_PLUS.md` does not exist and README lacks the link.

- [ ] **Step 3: Write the Stream Deck + guide**

Create `docs/STREAM_DECK_PLUS.md` with:

- Requirements and how to add `Codex Dial` to a Stream Deck + knob.
- A table for the Status-focused four-knob defaults.
- Exact rotation, press, and touch behavior for paired and selector modes.
- Property-inspector field reference.
- Rate-limit reset hold restriction.
- Reasoning `UNAVAILABLE` fallback explanation.
- Single-host and multi-host routing behavior.
- macOS physical verification section.
- Windows compatibility section explicitly stating CI/build coverage is not physical-device verification.
- Troubleshooting for `NO ITEMS`, `OFFLINE`, `DEGRADED`, `CONNECTING`, and stale feedback.

- [ ] **Step 4: Update existing docs**

- Add a feature bullet and guide link to `README.md`.
- Add the Encoder action, optional reasoning field, typed usage refresh, and feedback caching to `docs/ARCHITECTURE.md`.
- Add the guide link and Stream Deck + setup note to `docs/MACOS.md`.
- Add the same guide link and compatibility boundary to `docs/WINDOWS.md` without claiming physical testing.

- [ ] **Step 5: Run documentation, build, validation, and release audit**

```bash
npx tsx --test test/dial-action.test.ts test/release-audit.test.ts test/release-docs.test.ts
npm run validate
npm run audit:release
```

Expected: all focused tests pass, validation succeeds, and release audit reports success.

- [ ] **Step 6: Run two-stage subagent review and fix accepted findings**

The specification reviewer checks the approved defaults and testing claims. The quality reviewer checks all links/paths, packaged artifacts, private-data exclusion, and documentation consistency with manifest/property-inspector names.

- [ ] **Step 7: Commit the documentation slice**

```bash
git add docs/STREAM_DECK_PLUS.md README.md docs/ARCHITECTURE.md docs/MACOS.md docs/WINDOWS.md test/dial-action.test.ts test/release-audit.test.ts
git commit -m "docs: explain configurable Stream Deck Plus dials"
```

## Task 8: Run full automated verification and independent QA review

**Files:**
- Modify only files required by accepted review findings.

- [ ] **Step 1: Run the required clean verification sequence**

```bash
npm ci
npm run check
npm test
npm run validate
npm run audit:release
git diff --check main...HEAD
git status --short --branch
```

Expected:

- `npm ci` completes without modifying tracked files.
- TypeScript exits 0.
- Full test suite reports zero failures.
- Stream Deck validation succeeds.
- Release audit succeeds.
- Diff check reports no whitespace errors.
- Status lists no unintended tracked or untracked files.

- [ ] **Step 2: Dispatch a final specification-compliance subagent**

Give the reviewer the approved design spec, this plan, and `git diff main...HEAD`. Require a requirement-by-requirement report with file/line evidence and explicit checks for:

- Per-instance independence
- Paired and selector rotation
- Separate press and touch
- No reasoning confirmation
- Status-focused defaults
- Honest reasoning unavailable state
- Keypad/profile compatibility
- Relay and account-usage routing
- No arbitrary command surface
- Documentation/testing claim accuracy

- [ ] **Step 3: Dispatch a final code-quality/QA subagent**

Require review of settings trust boundaries, event lifecycles, async queue behavior, pressed-target stability, selector identity, feedback caching, renderer compatibility, relay version tolerance, property-inspector parity, and test gaps.

- [ ] **Step 4: Apply accepted review fixes test-first**

For each accepted functional issue, add or tighten a failing test, run it to observe failure, apply the narrow fix, and re-run the focused test. Stage only changed feature files.

- [ ] **Step 5: Commit review fixes if any**

```bash
git add src/dial-types.ts src/dial-domain.ts src/dial-action.ts src/types.ts src/codex-micro-renderer-bridge.ts src/codex-relay-client.ts src/relay-protocol.ts src/codex-relay-server.ts src/controller.ts src/plugin.ts static/manifest.json static/layouts/codex-dial.json static/imgs/dial.svg static/imgs/dial@2x.svg static/property-inspector/codex-dial.html scripts/build.mjs test/dial-domain.test.ts test/dial-action.test.ts test/micro-bridge.test.ts test/relay.test.ts test/release-audit.test.ts README.md docs/ARCHITECTURE.md docs/MACOS.md docs/WINDOWS.md docs/STREAM_DECK_PLUS.md
git commit -m "fix: address Codex dial review findings"
```

If no files changed, do not create an empty commit.

- [ ] **Step 6: Re-run the complete verification sequence from Step 1**

Expected: every command succeeds and the worktree is clean.

## Task 9: Install the development build and perform physical Stream Deck + QA

**Files:**
- No repository files unless an observed bug requires a test-first fix.
- External backups under the existing task workspace `work/backups/` only.
- Installed plugin/profile paths under the user's Stream Deck application support only.

- [ ] **Step 1: Record exact test environment**

Record without committing personal identifiers:

```bash
sw_vers
/Applications/Stream\ Deck.app/Contents/MacOS/Stream\ Deck --version 2>/dev/null || true
git rev-parse HEAD
```

Read Stream Deck device metadata to confirm the target is the 4 x 2 Stream Deck +, not Stream Deck 2.

- [ ] **Step 2: Create recoverable backups**

Copy the currently installed `com.simeo.codex-deck.sdPlugin` and the Stream Deck + profile root into timestamped directories under the task's existing `work/backups/`. Resolve exact source paths read-only before copying. Do not overwrite an earlier backup.

- [ ] **Step 3: Install the validated development bundle**

Stop only the Codex Deck plugin process if possible; otherwise quit and reopen Stream Deck without changing other profiles. Replace the installed plugin directory with the validated contents of `dist/com.simeo.codex-deck.sdPlugin`. Preserve user-only permissions and restart the plugin/app.

- [ ] **Step 4: Configure the Status-focused four-dial page**

On the existing Stream Deck + Codex page, add four `com.simeo.codex-deck.codex-dial` Encoder actions with preset settings:

```text
Dial 1: reasoning
Dial 2: agents
Dial 3: actions
Dial 4: usage
```

Do not alter the Stream Deck 2 profile. Preserve the existing eight keypad actions.

- [ ] **Step 5: Run the physical behavior matrix**

Verify and record pass/fail for:

1. Reasoning counter-clockwise/clockwise changes one level per detent with no confirmation.
2. Reasoning press does nothing; reasoning touch toggles Fast.
3. Agent rotation previews occupied tasks without focus change; press focuses the previewed task; touch opens Tasks.
4. Action rotation previews without execution; press runs the selected action; touch opens Settings.
5. Usage rotates Automatic/5-hour/Weekly; press toggles overview; touch refreshes current data.
6. Every touch region acts independently.
7. Rapid multi-tick rotation preserves count and order.
8. Feedback responds to Codex-side reasoning changes.
9. Disconnected/reconnected states render honestly and recover.
10. Existing eight keypad actions still operate.
11. Settings survive Stream Deck and Codex restarts.

- [ ] **Step 6: Fix any observed defect test-first and commit it**

For each defect, add a focused automated regression test, observe it fail, implement the narrow fix, run focused plus full verification, and commit:

```bash
git add src/dial-types.ts src/dial-domain.ts src/dial-action.ts src/types.ts src/codex-micro-renderer-bridge.ts src/codex-relay-client.ts src/relay-protocol.ts src/codex-relay-server.ts src/controller.ts src/plugin.ts static/manifest.json static/layouts/codex-dial.json static/imgs/dial.svg static/imgs/dial@2x.svg static/property-inspector/codex-dial.html scripts/build.mjs test/dial-domain.test.ts test/dial-action.test.ts test/micro-bridge.test.ts test/relay.test.ts test/release-audit.test.ts README.md docs/ARCHITECTURE.md docs/MACOS.md docs/WINDOWS.md docs/STREAM_DECK_PLUS.md
git commit -m "fix: correct Stream Deck Plus dial behavior"
```

- [ ] **Step 7: Re-run the physical matrix after fixes**

Expected: all eleven checks pass. If hardware or Codex state prevents a check, report it as unverified rather than passing it by inference.

## Task 10: Merge locally to main and verify the merged result

**Files:**
- No new source files beyond prior tasks.

- [ ] **Step 1: Invoke the finishing-development-branch workflow**

Confirm `feature/stream-deck-plus-dials` is clean, all checks pass, and physical QA evidence is recorded. Review `git log --oneline main..HEAD` and `git diff --stat main...HEAD`.

- [ ] **Step 2: Merge with a normal non-destructive merge**

```bash
git switch main
git merge --no-ff feature/stream-deck-plus-dials -m "merge: add configurable Stream Deck Plus dials"
```

Do not reset, force-push, or delete the feature branch during this task.

- [ ] **Step 3: Verify from merged main**

```bash
npm ci
npm run check
npm test
npm run validate
npm run audit:release
git status --short --branch
git log -1 --oneline --decorate
```

Expected: every command succeeds, status is clean on `main`, and the latest commit is the merge commit.

- [ ] **Step 4: Prepare the upstream pull-request handoff**

Check authenticated GitHub state without publishing. If the user has no fork remote, create a fork only after confirming the authenticated account, add it as `origin`, and retain `dazer1234/codex-stream-deck` as `upstream`. Push the feature branch and open the pull request only if external publication remains authorized at that point.

The pull-request body must include:

- Feature summary and screenshots or photos only if the user approves sharing them.
- Commit/test scope.
- Exact Codex, Stream Deck, macOS, and Stream Deck + model versions.
- Automated command results.
- Physical macOS behavior matrix.
- Explicit statement: Windows received CI/build validation but no physical Stream Deck + verification.
- Renderer-internal compatibility caveat.
- No personal profile data or proprietary assets.
