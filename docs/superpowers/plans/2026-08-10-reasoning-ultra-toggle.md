# Reasoning Dial Ultra Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Codex Dial its own `Include Ultra` setting and prevent a restricted Reasoning dial from issuing the command that would enter Ultra, locally or through the authenticated relay.

**Architecture:** Persist a strict boolean in the existing per-action dial settings, mirror it exactly in the property inspector, and carry it only on dial-originated reasoning commands. The target Codex renderer will atomically read the unique visible composer’s current model and effort, join that model to Codex’s live ordered model metadata, and either run one allow-listed reasoning command or return a typed `blocked-ultra` result. Typed relay results carry that non-error outcome back to the Stream Deck host so the dial can show a short `ULTRA OFF` notice without an alert or optimistic state change.

**Tech Stack:** TypeScript, Node.js test runner through `tsx --test`, Elgato Stream Deck SDK, CDP renderer bridge, React Query cache inspection, WebSocket relay, Stream Deck property-inspector HTML/JavaScript.

---

## File Map

- `src/dial-types.ts` — add the required per-dial boolean.
- `src/dial-domain.ts` — emit and normalize the field for every preset.
- `static/property-inspector/codex-dial.html` — expose, persist, and normalize `Include Ultra`.
- `src/types.ts` — define the typed reasoning policy/result shared by controller, bridge, and relay.
- `src/codex-micro-renderer-bridge.ts` — discover the active model’s ordered efforts and enforce the guard in the renderer.
- `src/relay-protocol.ts` — require a literal policy boolean and validate the typed result.
- `src/codex-relay-server.ts` — execute and return the renderer’s reasoning result.
- `src/codex-relay-client.ts` — resolve pending commands with the typed result.
- `src/controller.ts` — pass the dial setting, preserve unrestricted keypad behavior, and render `ULTRA OFF`.
- `test/dial-domain.test.ts` — settings and preset migration coverage.
- `test/dial-action.test.ts` — property-inspector/runtime parity and control behavior.
- `test/micro-bridge.test.ts` — live state discovery and guard behavior.
- `test/relay.test.ts` — relay trust-boundary and result round-trip coverage.
- `test/controller-dial.test.ts` — local/remote policy propagation and transient feedback.
- `docs/STREAM_DECK_PLUS.md` — user-facing checkbox and safety behavior.

## Task 1: Persist the Per-Dial Setting and Expose It in the Inspector

**Files:**
- Modify: `src/dial-types.ts`
- Modify: `src/dial-domain.ts`
- Modify: `static/property-inspector/codex-dial.html`
- Test: `test/dial-domain.test.ts`
- Test: `test/dial-action.test.ts`

- [ ] **Step 1: Write failing runtime normalization tests**

Add assertions beside the existing preset and normalization cases in `test/dial-domain.test.ts`:

```ts
test("dial settings default Include Ultra off and preserve only literal booleans", () => {
  assert.equal(expandDialPreset("reasoning").includeUltraReasoning, false);
  for (const preset of DIAL_PRESETS) {
    assert.equal(typeof expandDialPreset(preset).includeUltraReasoning, "boolean");
  }

  const base = expandDialPreset("reasoning");
  assert.equal(normalizeDialSettings({ ...base, includeUltraReasoning: true }).includeUltraReasoning, true);
  assert.equal(normalizeDialSettings({ ...base, includeUltraReasoning: false }).includeUltraReasoning, false);
  assert.equal(normalizeDialSettings({ ...base }).includeUltraReasoning, false);
  for (const malformed of [null, 0, 1, "true", {}, []]) {
    assert.equal(normalizeDialSettings({ ...base, includeUltraReasoning: malformed }).includeUltraReasoning, false);
  }
});
```

- [ ] **Step 2: Write failing property-inspector parity tests**

Extend `test/dial-action.test.ts` so its DOM-lite inspector harness proves:

```ts
assert.equal(inspectorNormalize({ ...reasoning, includeUltraReasoning: true }).includeUltraReasoning, true);
assert.equal(inspectorNormalize({ ...reasoning, includeUltraReasoning: "true" }).includeUltraReasoning, false);
assert.equal(readForm().includeUltraReasoning, includeUltraCheckbox.checked);
```

Also assert the checkbox label/help text, that applying incoming settings updates it, and that changing unrelated fields retains it in the complete `setSettings` payload.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='Include Ultra|property inspector' test/dial-domain.test.ts test/dial-action.test.ts
```

Expected: FAIL because the settings field and checkbox do not exist.

- [ ] **Step 4: Implement the strict shared settings contract**

Add to `CodexDialSettings` in `src/dial-types.ts`:

```ts
includeUltraReasoning: boolean;
```

Make `pairedPreset` and `selectorPreset` in `src/dial-domain.ts` emit `includeUltraReasoning: false`, and make `normalizeDialSettings` use:

```ts
includeUltraReasoning: hasOwn(input, "includeUltraReasoning") &&
  typeof input.includeUltraReasoning === "boolean"
  ? input.includeUltraReasoning
  : false,
```

Do not infer true from preset, binding, truthiness, or a string.

- [ ] **Step 5: Implement inspector parity**

Add this control to `static/property-inspector/codex-dial.html` near the paired reasoning controls:

```html
<label id="include-ultra-reasoning-row" class="checkbox-row" hidden>
  <input id="include-ultra-reasoning" type="checkbox">
  <span>
    Include Ultra
    <small>When off, clockwise reasoning stops below Ultra. Manual Codex selection is unchanged.</small>
  </span>
</label>
```

Add `includeUltraReasoning: false` to every `PRESETS` entry. In `normalizedSettings`, preserve only a literal boolean. In `applySettings`, set `.checked`; in `readForm`, always return the boolean. Show the row when either paired rotation binding is `reasoning.increase`, and attach the existing persist handler so changes immediately send the full settings object.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npx tsx --test test/dial-domain.test.ts test/dial-action.test.ts
npm run check
git diff --check
```

Expected: all pass.

- [ ] **Step 7: Commit the settings slice**

```bash
git add src/dial-types.ts src/dial-domain.ts static/property-inspector/codex-dial.html test/dial-domain.test.ts test/dial-action.test.ts
git commit -m "feat: configure Ultra per reasoning dial"
```

## Task 2: Enforce the Guard Against Live Renderer State

**Files:**
- Modify: `src/types.ts`
- Modify: `src/codex-micro-renderer-bridge.ts`
- Test: `test/micro-bridge.test.ts`

- [ ] **Step 1: Write failing pure decision tests**

Export a testable helper contract from the bridge and add:

```ts
test("restricted reasoning blocks only the live step into Ultra", () => {
  const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
  assert.equal(reasoningAdjustmentDecision("increase", false, "max", efforts), "blocked-ultra");
  assert.equal(reasoningAdjustmentDecision("increase", false, "xhigh", efforts), "apply");
  assert.equal(reasoningAdjustmentDecision("increase", true, "max", efforts), "apply");
  assert.equal(reasoningAdjustmentDecision("decrease", false, "ultra", efforts), "apply");
  assert.equal(reasoningAdjustmentDecision("increase", false, "max", []), "unavailable");
  assert.equal(reasoningAdjustmentDecision("increase", false, undefined, efforts), "unavailable");
});
```

Cover duplicate/malformed efforts by requiring an ordered, unique array of recognized nonblank strings with `ultra` appearing at most once.

- [ ] **Step 2: Write failing active-composer discovery tests**

In `test/micro-bridge.test.ts`, use fake visible reasoning triggers and fake React element props to prove the discovery function:

- accepts exactly one visible semantic reasoning trigger;
- reads effort from `data-selected-reasoning-effort`;
- reads the active model ID only from the trigger’s current `selectedValue` React subtree, not hidden measurement children;
- rejects multiple visible triggers, missing model IDs, and disagreement between candidates;
- joins that model ID to a `models/list` query record and preserves the server-provided `supportedReasoningEfforts` order.

- [ ] **Step 3: Write failing bridge command tests**

Extend the existing dedicated reasoning command tests so a fake `evaluate` proves:

```ts
assert.equal(await bridge.adjustReasoning("increase", { includeUltra: false }), "blocked-ultra");
assert.deepEqual(commands, []);
assert.equal(await bridge.adjustReasoning("increase", { includeUltra: true }), "applied");
assert.deepEqual(commands, ["composer.increaseReasoningEffort"]);
```

Also cover a lower restricted increase, decrease from Ultra, and missing live metadata. Missing metadata must issue no command; unrestricted callers may retain the existing direct command behavior.

- [ ] **Step 4: Run focused tests and verify RED**

```bash
npx tsx --test --test-name-pattern='reasoning.*Ultra|active composer reasoning|dedicated reasoning' test/micro-bridge.test.ts
```

Expected: FAIL because the policy, decision helper, and renderer discovery do not exist.

- [ ] **Step 5: Add shared result types**

In `src/types.ts`, add:

```ts
export type ReasoningAdjustmentPolicy = { includeUltra: boolean };
export type ReasoningAdjustmentResult = "applied" | "blocked-ultra";
```

Keep the bridge’s default unrestricted for existing callers:

```ts
async adjustReasoning(
  direction: ReasoningAdjustment,
  policy: ReasoningAdjustmentPolicy = { includeUltra: true }
): Promise<ReasoningAdjustmentResult>
```

- [ ] **Step 6: Implement atomic live-state enforcement**

In `src/codex-micro-renderer-bridge.ts`:

1. Reuse the verified selector `[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"]` and existing visibility rules.
2. From that unique element’s `__reactProps$...` value, traverse only the current `selectedValue` subtree and accept exactly one bounded `props.model` string. Explicitly ignore measurement/`aria-hidden` branches so stale width-measurement models cannot win.
3. Traverse the React root’s fibers for a query client, using the same bounded 30,000-fiber pattern as snapshots.
4. Find the current `models/list` query data, match the active model ID exactly, and normalize its ordered `supportedReasoningEfforts[].reasoningEffort` values.
5. In the same `Runtime.evaluate`, call `reasoningAdjustmentDecision`. Return `blocked-ultra` without resolving/importing the command runner when restricted. Throw `Codex reasoning metadata is unavailable.` for a restricted increase whose state is ambiguous. Otherwise invoke exactly one member of `REASONING_COMMANDS` and return `applied`.

Do not read or write `enabled-reasoning-efforts`, `show-ultra-in-model-picker-slider`, `model_picker_persists_ultra_effort`, or any dialog element.

- [ ] **Step 7: Run focused and structural checks**

```bash
npx tsx --test test/micro-bridge.test.ts
npm run check
git diff --check
```

Expected: all pass, including serialized-helper dependency tests.

- [ ] **Step 8: Commit the renderer slice**

```bash
git add src/types.ts src/codex-micro-renderer-bridge.ts test/micro-bridge.test.ts
git commit -m "feat: stop reasoning dial before Ultra"
```

## Task 3: Carry Typed Results Through Controller and Relay

**Files:**
- Modify: `src/relay-protocol.ts`
- Modify: `src/codex-relay-server.ts`
- Modify: `src/codex-relay-client.ts`
- Modify: `src/controller.ts`
- Modify: `test/relay.test.ts`
- Modify: `test/controller-dial.test.ts`

- [ ] **Step 1: Write failing relay parser tests**

Require reasoning commands to carry an explicit literal boolean:

```ts
assert.deepEqual(parseRelayCommand({
  kind: "reasoning", direction: "increase", includeUltra: false
}), { kind: "reasoning", direction: "increase", includeUltra: false });
for (const includeUltra of [undefined, null, 0, "false", {}]) {
  assert.equal(parseRelayCommand({ kind: "reasoning", direction: "increase", includeUltra }), null);
}
```

Add server-message tests accepting only `outcome: "applied" | "blocked-ultra"` on a successful result and rejecting unknown strings, outcomes on failed results, or extra malformed fields.

- [ ] **Step 2: Write failing local and remote controller tests**

In `test/controller-dial.test.ts`, prove:

- a dial with `includeUltraReasoning: false` calls the local bridge with `{ includeUltra: false }`;
- a true setting carries true;
- the public keypad path `controller.adjustReasoning("increase")` remains unrestricted;
- the remote command contains the explicit boolean;
- a local or remote `blocked-ultra` result sets feedback to title `REASONING`, value `ULTRA OFF`, detail `ENABLE IN DIAL SETTINGS`, with no `showAlert` call;
- after the short timer, authoritative reasoning feedback replaces the notice;
- disposed/replaced dial registrations cannot receive stale notice restoration.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npx tsx --test --test-name-pattern='reasoning.*includeUltra|blocked-ultra|ULTRA OFF' test/relay.test.ts test/controller-dial.test.ts
```

Expected: FAIL because relay commands/results and controller notices are still void/untyped.

- [ ] **Step 4: Implement the strict relay round trip**

Change the reasoning `RelayCommand` to:

```ts
{ kind: "reasoning"; direction: ReasoningAdjustment; includeUltra: boolean }
```

Add an optional successful result outcome:

```ts
type RelayResultMessage = {
  type: "result";
  protocol: 1;
  requestId: string;
  ok: boolean;
  outcome?: ReasoningAdjustmentResult;
  error?: string;
};
```

Have `executeRelayCommand` return the bridge result for reasoning, `sendResult` include the validated outcome, and `CodexRelayClient.send` resolve with it. Preserve the existing post-command snapshot publication ordering. Do not encode a block as an error.

- [ ] **Step 5: Implement controller propagation and notice**

Keep public non-dial reasoning unrestricted by sending `includeUltra: true`. For `reasoning.increase` and `reasoning.decrease` dial bindings, pass `registration.settings.includeUltraReasoning` both locally and remotely and inspect the returned outcome.

Generalize the existing registration-scoped temporary success suppression into a temporary notice helper, then add:

```ts
await action.setFeedback({
  title: "REASONING",
  value: "ULTRA OFF",
  detail: "ENABLE IN DIAL SETTINGS",
  indicator: 100,
  accent: { value: 100, bar_fill_c: "#FF9A3D" }
});
```

Use a 1,200 ms timer, clear it on settings changes/disposal, never call `showAlert` for `blocked-ultra`, clear `lastFeedback`, and re-render from the latest snapshot when the notice ends. No optimistic reasoning value is stored.

- [ ] **Step 6: Run focused and full slice checks**

```bash
npx tsx --test test/relay.test.ts test/controller-dial.test.ts
npm run check
git diff --check
```

Expected: all pass.

- [ ] **Step 7: Commit the command-flow slice**

```bash
git add src/relay-protocol.ts src/codex-relay-server.ts src/codex-relay-client.ts src/controller.ts test/relay.test.ts test/controller-dial.test.ts
git commit -m "feat: relay Ultra guard results"
```

## Task 4: Document, Validate, Install, and Physically Verify

**Files:**
- Modify: `docs/STREAM_DECK_PLUS.md`
- Modify: installed plugin package outside Git after all repository checks pass
- Modify: installed Stream Deck + profile outside Git after backup

- [ ] **Step 1: Update the Stream Deck + guide**

Document:

- `Include Ultra` is per knob and defaults off;
- off means clockwise stops before Ultra and briefly shows `ULTRA OFF`;
- on restores Ultra and Codex may show its own Full-access confirmation;
- manual Codex selection and keypad Reasoning Up remain unchanged;
- the plugin never confirms or dismisses the Codex safety dialog.

- [ ] **Step 2: Run fresh complete verification**

```bash
npm run check
npm test
npm run validate
npm run audit:release
git diff --check
git status --short
```

Expected: typecheck passes; all non-platform-skipped tests pass; Stream Deck validation passes; all release roots pass audit; diff check passes. If `npm run validate` regenerates tracked plugin PNG bytes, restore only those known generated images and rerun `git status --short` before committing.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/STREAM_DECK_PLUS.md
git commit -m "docs: explain the Reasoning Ultra guard"
```

- [ ] **Step 4: Request independent code and spec review**

Use `superpowers:requesting-code-review`. Address every Critical/Important finding with a separate red/green correction commit, then rerun the complete verification commands.

- [ ] **Step 5: Merge to main only after approval**

Use `superpowers:finishing-a-development-branch`; merge the reviewed branch into `main` without discarding unrelated work. Verify `git log -1 --oneline` and a clean repository worktree.

- [ ] **Step 6: Back up and install the verified macOS build**

Use exact local variables without writing a user-specific home path into release artifacts:

```bash
PLUGIN_ID='com.simeo.codex-deck.sdPlugin'
INSTALLED_PLUGIN="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/$PLUGIN_ID"
PROFILE_ROOT="$HOME/Library/Application Support/com.elgato.StreamDeck/ProfilesV3/F8241CEB-236C-467E-9A9A-F83FEC4307A4.sdProfile"
PROFILE_MANIFEST="$PROFILE_ROOT/Profiles/11F62414-1CB7-4E97-992F-3B568CD1382F/manifest.json"
```

Quit Elgato Stream Deck, back up `INSTALLED_PLUGIN` and `PROFILE_ROOT` under the workspace `work/backups/` directory, replace the installed plugin with the validated `dist/$PLUGIN_ID`, and update only Encoder `0,0` in `PROFILE_MANIFEST` so it contains:

```json
"includeUltraReasoning": false
```

Reopen `/Applications/Elgato Stream Deck.app`, confirm the Codex Deck plugin process is running, and re-read the profile JSON to prove the setting persisted.

- [ ] **Step 7: Perform physical Stream Deck + QA**

With the checkbox off, rotate through every lower level and prove the next clockwise detent at the ceiling shows `ULTRA OFF`, sends no command, and opens no Codex dialog. Turn back down and confirm decrease works. Check the box in the property inspector, retry, and confirm Codex owns any Ultra confirmation. Restart Stream Deck and Codex and confirm the per-knob setting persists.
