# Fast Mode Feedback and Reasoning Dial Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stream Deck FAST keys show authoritative green/red state and make every reasoning detent invoke Codex's dedicated reasoning commands instead of composer focus navigation.

**Architecture:** Extend the existing renderer-owned `MicroSnapshot` with an optional strict Fast boolean, preserve it through the relay trust boundary, and feed it only into FAST key rendering. Keep commands authoritative: successful local Fast commands force a fresh snapshot, remote commands retain the relay's post-command barrier, and reasoning adjustment delegates to the allow-listed official `MIND+` / `MIND-` keycap command path.

**Tech Stack:** TypeScript, Node.js test runner through `tsx --test`, Elgato Stream Deck SDK, CDP renderer bridge, SVG data-URL rendering, WebSocket relay.

---

## File Map

- `src/types.ts` — add the optional snapshot Fast state.
- `src/codex-micro-renderer-bridge.ts` — read visible composer Fast state and route reasoning through official keycap commands.
- `src/relay-protocol.ts` — validate optional Fast state as a literal boolean.
- `src/render.ts` — apply green/red/neutral state backgrounds to imported and fallback keycaps.
- `src/controller.ts` — pass Fast state to FAST renderers and refresh after successful local Fast activation.
- `test/micro-bridge.test.ts` — renderer-state and reasoning-command regressions.
- `test/relay.test.ts` — relay snapshot Fast-state trust-boundary regressions.
- `test/render-theme.test.ts` — exact green/red/neutral keycap rendering regressions.
- `test/controller-dial.test.ts` — controller rendering and forced-refresh behavior.
- `docs/STREAM_DECK_PLUS.md` — document Fast feedback and dedicated reasoning behavior.

## Task 1: Carry Authoritative Fast State Through Snapshots

**Files:**
- Modify: `src/types.ts`
- Modify: `src/codex-micro-renderer-bridge.ts`
- Modify: `src/relay-protocol.ts`
- Test: `test/micro-bridge.test.ts`
- Test: `test/relay.test.ts`

- [ ] **Step 1: Write the failing visible-composer state test**

Add a focused test beside `renderer snapshots require one unique visible semantic reasoning target` in `test/micro-bridge.test.ts`:

```ts
test("renderer snapshots distinguish verified Fast on, Fast off, and unavailable state", () => {
  const reader = Reflect.get(microBridgeModule, "readActiveFastMode") as (
    elements: Array<{ semantic: boolean; visible: boolean; fast: boolean }>,
    isVisible: (element: { visible: boolean }) => boolean,
    hasFastIndicator: (element: { fast: boolean }) => boolean
  ) => boolean | undefined;
  const element = (semantic: boolean, visible: boolean, fast: boolean) => ({
    semantic, visible, fast,
    getAttribute(name: string) {
      return name === "data-composer-navigation-target" && semantic ? "reasoning" : null;
    }
  });

  assert.equal(reader([element(true, true, true)], (item) => item.visible, (item) => item.fast), true);
  assert.equal(reader([element(true, true, false)], (item) => item.visible, (item) => item.fast), false);
  assert.equal(reader([element(true, false, true)], (item) => item.visible, (item) => item.fast), undefined);
  assert.equal(reader([element(false, true, true)], (item) => item.visible, (item) => item.fast), undefined);
  assert.equal(reader(
    [element(true, true, true), element(true, true, false)],
    (item) => item.visible,
    (item) => item.fast
  ), undefined);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='renderer snapshots distinguish verified Fast' test/micro-bridge.test.ts
```

Expected: FAIL because `readActiveFastMode` is not exported.

- [ ] **Step 3: Implement the minimal visible-state reader and snapshot field**

In `src/types.ts`, add:

```ts
/** Whether the active visible composer has Fast service tier enabled. */
fastModeEnabled?: boolean;
```

to `MicroSnapshot` beside `reasoningEffort`.

In `src/codex-micro-renderer-bridge.ts`, reuse the reasoning element visibility contract and add:

```ts
export function readActiveFastMode(
  elements: Iterable<ReasoningEffortElement>,
  isVisible = defaultReasoningElementVisibility,
  hasFastIndicator = (element: ReasoningEffortElement): boolean =>
    Boolean((element as unknown as Element).querySelector(
      'svg[class*="ModelPickerTriggerInlineFastIcon"]'
    ))
): boolean | undefined {
  const candidates = new Set<boolean>();
  for (const element of elements) {
    if (!isVisible(element)) continue;
    if (element.getAttribute("data-composer-navigation-target") !== "reasoning") continue;
    candidates.add(hasFastIndicator(element));
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}
```

Extract the existing default visibility callback into `defaultReasoningElementVisibility` so both readers share it. Because the reader functions are serialized into the renderer expression, inject the helper before both readers as well:

```ts
const defaultReasoningElementVisibility = (${defaultReasoningElementVisibility.toString()});
const readActiveReasoningEffort = (${readActiveReasoningEffort.toString()});
const readActiveFastMode = (${readActiveFastMode.toString()});
```

Then query the same verified reasoning triggers and include the field only when it is a boolean:

```ts
const reasoningTargets = document.querySelectorAll(
  '[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]'
);
const reasoningEffort = readActiveReasoningEffort(reasoningTargets);
const fastModeEnabled = readActiveFastMode(reasoningTargets);

return {
  slots, activeThreadKey, activeThreadTitle, layout, agentSource, lightingAutoOff, theme,
  ...(reasoningEffort ? { reasoningEffort } : {}),
  ...(typeof fastModeEnabled === 'boolean' ? { fastModeEnabled } : {}),
  ...(usage ? { usage } : {})
};
```

- [ ] **Step 4: Run the focused bridge tests and verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern='visible semantic reasoning|verified Fast' test/micro-bridge.test.ts
```

Expected: 2 matching tests pass.

- [ ] **Step 5: Write the failing relay validation test**

Extend the optional-reasoning snapshot test in `test/relay.test.ts`:

```ts
test("relay snapshots accept only an optional literal Fast boolean", () => {
  const message = { type: "snapshot", protocol: 1, host, observedAt: 1, snapshot: structuredClone(snapshot) };
  message.snapshot.fastModeEnabled = true;
  assert.notEqual(parseRelayServerMessage(message), null);
  message.snapshot.fastModeEnabled = false;
  assert.notEqual(parseRelayServerMessage(message), null);
  for (const malformed of [null, 0, 1, "true", [], {}]) {
    message.snapshot.fastModeEnabled = malformed as never;
    assert.equal(parseRelayServerMessage(message), null);
  }
});
```

- [ ] **Step 6: Run the relay test and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='literal Fast boolean' test/relay.test.ts
```

Expected: FAIL because malformed Fast fields are currently accepted.

- [ ] **Step 7: Validate Fast state at the relay trust boundary**

In `isSnapshot()` in `src/relay-protocol.ts`, add:

```ts
if (value.fastModeEnabled !== undefined && typeof value.fastModeEnabled !== "boolean") return false;
```

- [ ] **Step 8: Run focused and full slice checks**

Run:

```bash
npx tsx --test test/micro-bridge.test.ts test/relay.test.ts
npm run check
git diff --check
```

Expected: all focused tests and type-check pass; diff check is silent.

- [ ] **Step 9: Commit the snapshot slice**

```bash
git add src/types.ts src/codex-micro-renderer-bridge.ts src/relay-protocol.ts test/micro-bridge.test.ts test/relay.test.ts
git commit -m "feat: expose authoritative Fast mode state"
```

## Task 2: Render and Refresh Fast State

**Files:**
- Modify: `src/render.ts`
- Modify: `src/controller.ts`
- Test: `test/render-theme.test.ts`
- Test: `test/controller-dial.test.ts`

- [ ] **Step 1: Write failing green/red/neutral renderer tests**

Add to `test/render-theme.test.ts`:

```ts
test("Fast key backgrounds are green on, red off, and neutral when unknown", () => {
  const icon = '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';
  const decode = (value: string) => decodeURIComponent(
    value.replace(/^data:image\/svg\+xml;charset=utf8,/, "")
  );
  const enabled = decode(renderImportedKeycap(icon, "dark", true));
  const disabled = decode(renderImportedKeycap(icon, "dark", false));
  const unknown = decode(renderImportedKeycap(icon, "dark"));

  assert.match(enabled, /data-toggle-state="on"/);
  assert.match(enabled, new RegExp(SIGNAL_COLORS.dark.complete, "i"));
  assert.match(disabled, /data-toggle-state="off"/);
  assert.match(disabled, new RegExp(SIGNAL_COLORS.dark.error, "i"));
  assert.match(unknown, /data-toggle-state="unknown"/);
  assert.doesNotMatch(unknown, /data-toggle-background=/);
});
```

Add the same state assertions for `renderFallbackKeycap("FAST", "dark", state)` so missing user artwork does not lose feedback.

- [ ] **Step 2: Run the render test and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='Fast key backgrounds' test/render-theme.test.ts
```

Expected: FAIL because the renderers do not accept or expose toggle state.

- [ ] **Step 3: Implement stateful keycap backgrounds**

Change both renderer signatures:

```ts
export function renderImportedKeycap(
  svg: string,
  theme: ThemeMode = "light",
  toggleState?: boolean
): string

export function renderFallbackKeycap(
  keycapId: string,
  theme: ThemeMode = "light",
  toggleState?: boolean
): string
```

For each renderer, derive:

```ts
const toggleColor = toggleState === true
  ? SIGNAL_COLORS[theme].complete
  : toggleState === false
    ? SIGNAL_COLORS[theme].error
    : undefined;
const toggleLabel = toggleState === true ? "on" : toggleState === false ? "off" : "unknown";
```

Mark the outer key and add a strong state wash only for known state:

```ts
<rect data-theme="${theme}" data-toggle-state="${toggleLabel}" ... />
${toggleColor ? `<rect data-toggle-background="${toggleLabel}" x="9" y="9" width="126" height="126" rx="14" fill="${toggleColor}" fill-opacity=".68"/>` : ""}
```

Keep the glyph above the wash and retain the existing borders.

- [ ] **Step 4: Run renderer tests and verify GREEN**

Run:

```bash
npx tsx --test test/render-theme.test.ts
```

Expected: all rendering tests pass.

- [ ] **Step 5: Write failing controller rendering and refresh tests**

Add focused controller tests that install a local snapshot whose `ACT06` keycap is `FAST` and register both a Micro action and a fixed `FAST` key. Assert their images decode to `data-toggle-state="on"` for `true`, `off` for `false`, and `unknown` when omitted.

Add a command test with a bridge spy:

```ts
test("successful local Fast activation refreshes once without refreshing release", async () => {
  const controller = new DeckController();
  const state = probe(controller);
  state.localHost = HOST;
  state.targetHostId = HOST.hostId;
  state.targetPlatform = HOST.platform;
  state.localSnapshot = hostSnapshot({ ...snapshot, fastModeEnabled: false });
  const events: Array<[string, 0 | 1]> = [];
  let refreshes = 0;
  state.microBridge = {
    async sendAction(slot, act) { events.push([slot, act]); },
    async refresh() { refreshes += 1; return { ...snapshot, fastModeEnabled: true }; }
  };

  await controller.sendMicroAction("ACT06", 1);
  await controller.sendMicroAction("ACT06", 0);

  assert.deepEqual(events, [["ACT06", 1], ["ACT06", 0]]);
  assert.equal(refreshes, 1);
});
```

Also assert a rejected Fast activation leaves `refreshes === 0` and the last snapshot unchanged.

- [ ] **Step 6: Run controller tests and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='Fast activation|FAST key state' test/controller-dial.test.ts
```

Expected: FAIL because controller rendering is neutral and activation does not refresh.

- [ ] **Step 7: Pass Fast state through the keycap cache and renderers**

Change `keycapImage` to accept `toggleState?: boolean`, include `on`, `off`, or `unknown` in its cache key, and pass the state to both imported and fallback renderers.

In `renderMicroAction`, derive state only for `keycapId === "FAST"`:

```ts
const toggleState = keycapId === "FAST" ? snapshot?.fastModeEnabled : undefined;
const image = await this.keycapImage(keycapId, snapshot?.theme ?? "dark", toggleState);
```

In `renderFixedAction`, pass the same state only when `registration.source.kind === "local"` and its keycap ID is `FAST`. All other keycaps remain neutral.

- [ ] **Step 8: Refresh only after successful local Fast activation**

Add private local command helpers in `src/controller.ts`:

```ts
private async sendLocalMicroAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
  const isFastActivation = act === 1 &&
    this.localSnapshot?.snapshot.layout.slots[slot]?.keycapId === "FAST";
  await this.microBridge.sendAction(slot, act);
  if (isFastActivation) await this.refresh();
}

private async runLocalKeycap(keycapId: OfficialKeycapId): Promise<void> {
  await this.microBridge.runKeycap(keycapId);
  if (keycapId === "FAST") await this.refresh();
}
```

Use `sendLocalMicroAction` from `sendMicroAction` and `runLocalKeycap` from `runKeycap` and the dial `keycap.*` local callback. Do not refresh after remote commands because the relay already publishes a fresh post-command snapshot before acknowledging success.

- [ ] **Step 9: Run focused and full slice checks**

Run:

```bash
npx tsx --test test/render-theme.test.ts test/controller-dial.test.ts
npm run check
git diff --check
```

Expected: focused tests and type-check pass; diff check is silent.

- [ ] **Step 10: Commit the feedback slice**

```bash
git add src/render.ts src/controller.ts test/render-theme.test.ts test/controller-dial.test.ts
git commit -m "fix: show live Fast mode feedback"
```

## Task 3: Route Reasoning Through Dedicated Commands

**Files:**
- Modify: `src/codex-micro-renderer-bridge.ts`
- Test: `test/micro-bridge.test.ts`
- Test: `test/controller-dial.test.ts`

- [ ] **Step 1: Write the failing bridge command-routing test**

Add to `test/micro-bridge.test.ts`:

```ts
test("reasoning adjustment delegates to official commands instead of raw encoder navigation", async () => {
  const bridge = new microBridgeModule.CodexMicroRendererBridge(() => {});
  const keycaps: string[] = [];
  let rawDispatches = 0;
  const probe = bridge as unknown as {
    runKeycap: (id: string) => Promise<void>;
    dispatch: () => Promise<void>;
  };
  probe.runKeycap = async (id) => { keycaps.push(id); };
  probe.dispatch = async () => { rawDispatches += 1; };

  await bridge.adjustReasoning("increase");
  await bridge.adjustReasoning("decrease");

  assert.deepEqual(keycaps, ["MIND+", "MIND-"]);
  assert.equal(rawDispatches, 0);
});
```

- [ ] **Step 2: Run the bridge test and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='official commands instead of raw encoder' test/micro-bridge.test.ts
```

Expected: FAIL because `adjustReasoning` calls `dispatch` with `ENC_CC` / `ENC_CW`.

- [ ] **Step 3: Replace raw reasoning encoder events**

Remove `REASONING_ENCODER_KEYS` and implement:

```ts
async adjustReasoning(direction: ReasoningAdjustment): Promise<void> {
  await this.runKeycap(direction === "increase" ? "MIND+" : "MIND-");
}
```

Leave `sendEncoder(act)` unchanged for the separate legacy encoder-click action.

- [ ] **Step 4: Add one-detent controller regression**

Extend the paired reasoning dial test in `test/controller-dial.test.ts` to rotate one tick in each direction and assert exactly one `adjustReasoning("increase")` and one `adjustReasoning("decrease")`, with no `sendEncoder` calls.

- [ ] **Step 5: Run focused and full slice checks**

Run:

```bash
npx tsx --test test/micro-bridge.test.ts test/controller-dial.test.ts
npm run check
git diff --check
```

Expected: focused tests and type-check pass; diff check is silent.

- [ ] **Step 6: Commit the reasoning slice**

```bash
git add src/codex-micro-renderer-bridge.ts test/micro-bridge.test.ts test/controller-dial.test.ts
git commit -m "fix: use dedicated reasoning commands"
```

## Task 4: Documentation, Release Gates, and Installation

**Files:**
- Modify: `docs/STREAM_DECK_PLUS.md`
- Test: all project tests and release gates
- Install: user-local Stream Deck plugin and existing Plus profile

- [ ] **Step 1: Document the corrected behavior**

Update the status-focused defaults section in `docs/STREAM_DECK_PLUS.md` to state:

```md
The Fast key uses authoritative composer state: green means Fast Mode is enabled, red means it is disabled, and the normal neutral surface means the live state is unavailable. Reasoning rotation invokes Codex's dedicated increase/decrease commands; it does not move keyboard focus through composer controls.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run check
npm test
npm run validate
npm run audit:release
git diff --check
```

Expected: type-check passes; 241 existing tests plus the new regressions pass with only the existing Windows-specific skip; Stream Deck validation and all three release roots pass.

Restore only the two known build-regenerated files if validation changes them:

```bash
git restore --source=HEAD -- static/imgs/plugin-icon.png static/imgs/plugin-icon@2x.png
```

- [ ] **Step 3: Commit documentation**

```bash
git add docs/STREAM_DECK_PLUS.md
git commit -m "docs: explain Fast and reasoning feedback"
```

- [ ] **Step 4: Obtain independent final review**

Give the reviewer the approved design, this plan, the base SHA before Task 1, and current HEAD. Require explicit review of renderer trust boundaries, command routing, refresh ordering, remote/local behavior, SVG contrast, and test claims. Fix and re-review every Critical or Important finding before installation.

- [ ] **Step 5: Back up and install the verified bundle**

Quit Stream Deck cleanly. Create a new timestamped backup under:

```text
$REPO_PARENT/backups/
```

Back up the installed plugin and the Stream Deck + profile, atomically replace only:

```text
$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.simeo.codex-deck.sdPlugin
```

with the verified `dist/com.simeo.codex-deck.sdPlugin`, then relaunch Stream Deck.

- [ ] **Step 6: Verify the live installation**

Verify the plugin process starts from the canonical installed path, its log reaches `local=ready`, the Plus page retains 8 keypad and 4 Encoder actions, and the Reasoning/Agents/Actions/Usage presets remain persisted. Confirm the installed manifest and plugin bundle hashes match `dist` before the app mutates logs.

- [ ] **Step 7: Merge locally into main**

After all gates and live checks are green:

```bash
git switch main
git merge --ff-only fix/fast-mode-reasoning-controls
npm run check
npm test
git status --short --branch
```

Expected: local `main` contains all slice commits, tests pass, and the worktree is clean. Keep the feature branch available for the later upstream pull request; do not push or publish anything.
