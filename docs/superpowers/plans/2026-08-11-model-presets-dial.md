# Model Presets Dial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-knob Stream Deck + Model Presets dial that immediately and truthfully switches among configured Codex model/reasoning pairs.

**Architecture:** Extend the existing strict dial-settings and snapshot contracts with a bounded model catalog and a dedicated model-presets rotation. Invoke Codex's native paired `onSelectModel(modelId, effort)` callback once under the existing renderer-global reasoning guard, confirm the re-rendered pair, then propagate confirmed local or capability-negotiated relay feedback with generation fencing.

**Tech Stack:** TypeScript 5.9, Node.js 20+, `@elgato/streamdeck` 2.1, inline Stream Deck property-inspector HTML/JavaScript, WebSocket relay protocol v1, Node test runner through `tsx`.

---

## File structure

- `src/dial-types.ts`: versioned dial settings, Model Presets entry/rotation/feedback types, transient runtime catalog and switching state.
- `src/dial-domain.ts`: strict settings migration/normalization, valid-preset resolution, direction-only rotation planning, and truthful LCD feedback.
- `src/types.ts`: normalized model catalog and confirmed composite request/result types shared by renderer, controller, and relay.
- `src/codex-micro-renderer-bridge.ts`: descriptor-safe catalog snapshot extraction, native paired model selector resolution, serialization, invocation, and confirmation.
- `src/dial-action.ts`: Stream Deck SDK property-inspector request forwarding.
- `src/controller.ts`: target-host catalog responses, direction-only dial queue execution, local generation fencing, transient switching/error state, and remote dispatch.
- `src/relay-protocol.ts`: strict capability, command, result, and snapshot wire types/parsers.
- `src/codex-relay-server.ts`: composite command execution and forced-snapshot-before-result ordering.
- `src/codex-relay-client.ts`: capability admission, pending-command identity fencing, and immutable confirmed pair patching.
- `static/property-inspector/codex-dial.html`: live per-knob model/effort editor with add/remove/drag/keyboard reorder and reconnect safety.
- `test/dial-domain.test.ts`: settings, migration, resolver, wrap, unavailable, Ultra, and feedback tests.
- `test/micro-bridge.test.ts`: catalog extraction, hostile renderer shapes, paired callback, confirmation, concurrency, and timeout tests.
- `test/dial-action.test.ts`: adapter and property-inspector behavior tests.
- `test/controller-dial.test.ts`: catalog responses, queue timing, switching/error feedback, local patching, and lifecycle tests.
- `test/relay.test.ts`: protocol strictness, capability compatibility, FIFO ordering, and identity fencing tests.
- `docs/STREAM_DECK_PLUS.md`, `README.md`, `CHANGELOG.md`: user-facing setup, behavior, compatibility, and release notes.

### Task 1: Versioned Model Presets settings and pure dial domain

**Files:**
- Modify: `src/dial-types.ts`
- Modify: `src/dial-domain.ts`
- Test: `test/dial-domain.test.ts`

- [ ] **Step 1: Add failing version-2 migration and hostile-settings tests**

Add fixtures that assert all existing version-1 presets normalize to version 2 without behavior changes, while Model Presets accepts only an exact bounded unique list:

```ts
const modelPresets = {
  version: 2,
  preset: "model-presets",
  customized: false,
  includeUltraReasoning: false,
  rotation: { kind: "model-presets" },
  press: "none",
  touchTap: "keycap.FAST",
  feedback: "model-presets",
  modelPresets: [
    { modelId: "gpt-5.6-sol", reasoningEffort: "high" },
    { modelId: "gpt-5.6-sol", reasoningEffort: "medium" },
    { modelId: "gpt-5.6-terra", reasoningEffort: "medium" }
  ]
};
assert.deepEqual(normalizeDialSettings(modelPresets), modelPresets);
assert.equal(normalizeDialSettings(version1Reasoning).version, 2);
```

Cover zero, one, and twelve entries; thirteen entries; duplicates; inherited fields; custom prototypes; symbols; accessors with zero getter calls; unsafe identifiers; and extra nested keys. A malformed v2 payload must equal `expandDialPreset("model-presets")`, never a partial merge.

- [ ] **Step 2: Run the domain tests and capture RED**

Run:

```bash
npx tsx --test --test-name-pattern "model preset|version 2|migration" test/dial-domain.test.ts
```

Expected: failures because `model-presets`, settings version 2, and entry normalization do not exist.

- [ ] **Step 3: Define the discriminated settings and runtime types**

Refactor the current settings interface into a version-neutral base plus exact discriminated variants. Keep `JsonObject` index compatibility explicitly:

```ts
export interface ModelPresetEntry extends JsonObject {
  modelId: string;
  reasoningEffort: string;
}
export interface ModelPresetRotation extends JsonObject { kind: "model-presets" }

export interface CodexDialSettingsBase extends JsonObject {
  customized: boolean;
  includeUltraReasoning: boolean;
  press: DialBindingId;
  touchTap: DialBindingId;
  staticLabel?: string;
}

export interface ExistingDialSettingsV2 extends CodexDialSettingsBase {
  version: 2;
  preset: LegacyDialPreset;
  rotation: PairedDialRotation | SelectorDialRotation;
  feedback: LegacyDialFeedbackMode;
}

export interface ModelPresetsDialSettings extends CodexDialSettingsBase {
  version: 2;
  preset: "model-presets";
  rotation: ModelPresetRotation;
  feedback: "model-presets";
  modelPresets: ModelPresetEntry[];
}

export type CodexDialSettings = ExistingDialSettingsV2 | ModelPresetsDialSettings;
```

Preserve a private/exported `CodexDialSettingsV1` input type for migration, with legacy preset/rotation/feedback discriminants only. Add `model-presets` to the public preset and feedback constants while defining `LegacyDialPreset` and `LegacyDialFeedbackMode` as their exclusions. Add transient `modelCatalog`, `activeModelId`, `activeModelDisplayName`, and `modelPresetSwitching` fields to the runtime view/state rather than settings.

- [ ] **Step 4: Implement strict migration, defaults, and normalization**

Use own data descriptors before reading nested arrays. Preserve the current model-ID grammar and 128-character bound, and use `isSafeReasoningIdentifier` with its 64-character bound for efforts. Reject duplicates, require at most twelve entries, and emit complete v2 objects. `expandDialPreset("model-presets")` returns the approved press/touch/feedback defaults and a syntactically empty list; live preferred-pair seeding belongs to the inspector after authoritative catalog receipt.

- [ ] **Step 5: Add failing pure resolver, wrap, and feedback tests**

Define tests around a pure API:

```ts
resolveModelPresetDirection(settings, view, "clockwise")
resolveModelPresetDirection(settings, view, "counter-clockwise")
```

Assert exact active pair moves next/previous with wrapping, an unlisted pair selects first/last, catalog-proven invalid and Ultra-disabled entries are skipped, missing catalog returns `{kind:"unavailable"}`, and authoritative zero-valid returns `{kind:"empty"}`. Assert feedback for confirmed listed, unlisted, switching, empty, unavailable, and unhealthy states.

- [ ] **Step 6: Run the pure tests and capture RED**

Run the same focused command. Expected: resolver and feedback assertions fail because those branches are absent.

- [ ] **Step 7: Implement the pure resolver and feedback**

Return a direction plan, not a prematurely captured target:

```ts
type ModelPresetResolution =
  | { kind: "target"; entry: ModelPresetEntry; index: number; count: number }
  | { kind: "empty" }
  | { kind: "unavailable" };
```

Keep `reduceDialRotation` from resolving Model Presets. The controller will enqueue one direction closure per detent. Render `SWITCHING…` from transient state and never display a target pair before confirmation.

- [ ] **Step 8: Verify and commit Task 1**

Run:

```bash
npx tsx --test test/dial-domain.test.ts
npm run check
git diff --check
```

Expected: all pass. Commit only the three scoped files:

```bash
git add src/dial-types.ts src/dial-domain.ts test/dial-domain.test.ts
git commit -m "feat: add model preset dial settings"
```

### Task 2: Authoritative full model catalog in snapshots

**Files:**
- Modify: `src/types.ts`
- Modify: `src/codex-micro-renderer-bridge.ts`
- Modify: `src/relay-protocol.ts`
- Test: `test/micro-bridge.test.ts`
- Test: `test/relay.test.ts`

- [ ] **Step 1: Add failing catalog extraction and snapshot tests**

Refactor the existing Sol/Terra fixtures to assert a complete result:

```ts
{
  activeModelId: "gpt-5.6-sol",
  activeModelDisplayName: "5.6 Sol",
  reasoningEffort: "high",
  modelCatalog: [
    { modelId: "gpt-5.6-sol", displayName: "5.6 Sol", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"] },
    { modelId: "gpt-5.6-terra", displayName: "5.6 Terra", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"] }
  ]
}
```

Retain all current hidden measurement, effort-label, five-part query-key, duplicate-identical, conflicting-record, accessor, proxy, traversal-bound, and unsafe-scalar cases. Add relay snapshot parser cases for catalog maximum 32 entries, maximum 16 efforts per model, exact own keys, and a package payload below the existing 64 KiB WebSocket limit.

- [ ] **Step 2: Run focused tests and capture RED**

```bash
npx tsx --test --test-name-pattern "model catalog|active model|snapshot" test/micro-bridge.test.ts test/relay.test.ts
```

Expected: missing snapshot fields and catalog validation failures.

- [ ] **Step 3: Define normalized shared catalog types**

Add:

```ts
export type CodexModelCatalogEntry = {
  modelId: string;
  displayName: string;
  supportedReasoningEfforts: string[];
};
```

Extend `MicroSnapshot` with optional `activeModelId`, `activeModelDisplayName`, and `modelCatalog`. Bound model IDs to 128 characters with the existing safe grammar, reasoning identifiers to 64 characters, display names to 80 characters, entries to 32, and efforts per entry to 16.

- [ ] **Step 4: Refactor catalog extraction without weakening authorization**

Split the current single-match helper into:

```ts
readReasoningModelCatalog(reactRoot): CodexModelCatalogEntry[] | undefined
matchActiveReasoningModel(visibleLabels, catalog): CodexModelCatalogEntry | undefined
```

Preserve query-client clone gating, exact two- or five-part query keys, exact own array shapes, record deduplication, and distinct-conflict rejection. Serialize these helpers into `SNAPSHOT_EXPRESSION`, derive the active record from the unique visible trigger, and emit all three fields together or omit all catalog/model fields when authority is unavailable.

- [ ] **Step 5: Validate catalog fields at the relay boundary**

Extend `isSnapshot` with descriptor-safe exact validation. Do not trim or coerce identifiers. Reject partial active-model pairs, unknown properties, duplicate model IDs, duplicate efforts, or active IDs absent from the catalog.

- [ ] **Step 6: Verify and commit Task 2**

```bash
npx tsx --test test/micro-bridge.test.ts test/relay.test.ts
npm run check
git diff --check
git add src/types.ts src/codex-micro-renderer-bridge.ts src/relay-protocol.ts test/micro-bridge.test.ts test/relay.test.ts
git commit -m "feat: expose the active Codex model catalog"
```

### Task 3: Native paired model-and-reasoning bridge operation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/codex-micro-renderer-bridge.ts`
- Test: `test/micro-bridge.test.ts`

- [ ] **Step 1: Capture the current callback seam without invoking it**

Run a read-only CDP probe against the installed Codex renderer. It must locate the unique visible semantic reasoning trigger, walk at most 50 React ancestors through own data descriptors, and print only sanitized callback metadata: required own property names, primitive model/effort values, callback arities, normalized `Function.prototype.toString.call` shapes, and bounded catalog records. It must not call either callback. Record the verified 26.803.41515 fixture in the test file:

```ts
{
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  onSelectModelSource: "(e,t)=>{ye(e,t)}",
  onSelectReasoningEffortSource: "e=>{ye(_,e)}",
  onSelectModelArity: 2,
  onSelectReasoningEffortArity: 1
}
```

If no healthy live renderer is available, use this already recorded fixture and defer only the repeated live probe to Task 7; do not change the predicate.

- [ ] **Step 2: Add failing selector-resolution tests**

Extend the guarded renderer harness with a unique semantic trigger whose bounded React ancestor owns data properties `model`, `reasoningEffort`, `models`, `onSelectModel`, and `onSelectReasoningEffort`. Assert that the resolver returns exactly one paired callback only when:

```ts
onSelectModel.length === 2
onSelectReasoningEffort.length === 1
```

and both are tightly anchored direct forwarders associated with the same exact catalog. Normalize only insignificant whitespace, then require the two-argument wrapper to match `(a,b)=>{callee(a,b)}` and the one-argument wrapper to match `b=>{sameCallee(capturedModel,b)}` with the same safe callee identifier. Use `Function.prototype.toString.call(callback)`, not a callback-owned method. Reject native-code strings, extra statements, return expressions, `.call`/`.apply`, different callees, computed calls, async wrappers, and any ambiguity. Add zero-invocation rejection cases for accessors, proxies, duplicate ancestors, missing core props, wrong arity, non-forwarder source, unsupported pair, and hidden/multiple triggers.

- [ ] **Step 3: Run selector tests and capture RED**

```bash
npx tsx --test --test-name-pattern "model preset selector|paired model" test/micro-bridge.test.ts
```

Expected: `applyModelPreset` and selector helpers do not exist.

- [ ] **Step 4: Define request/result types and the bridge method**

```ts
export type ModelPresetRequest = {
  modelId: string;
  reasoningEffort: string;
  includeUltra: boolean;
};
export type ModelPresetExecution = {
  modelId: string;
  reasoningEffort: string;
};
```

Add `CodexMicroRendererBridge.applyModelPreset(request): Promise<ModelPresetExecution>`.

- [ ] **Step 5: Implement descriptor-safe active component resolution**

Starting from the exactly-one visible reasoning trigger, require one own `__reactFiber$*` property, walk at most 50 `.return` ancestors through own data descriptors, and accept exactly one qualifying memoized-props object. Validate the component's bounded `models` catalog independently against the authoritative query-client catalog. Never invoke getters, DOM clicks, keyboard events, focus methods, or Electron IPC.

- [ ] **Step 6: Add failing invocation, confirmation, and concurrency tests**

Prove one invocation receives the exact pair:

```ts
assert.deepEqual(selectorCalls, [["gpt-5.6-terra", "medium"]]);
assert.deepEqual(result, { modelId: "gpt-5.6-terra", reasoningEffort: "medium" });
```

Cover same-pair no-op with zero calls, microtask and macrotask re-render confirmation, timeout, partial model-only state, missing re-rendered seam, mixed concurrent `adjustReasoning`/`applyModelPreset`, a queued second preset, disconnect namespace rotation, and late old responses. Assert only one callback invocation per request.

- [ ] **Step 7: Run invocation tests and capture RED**

Run the focused test file. Expected: invocation/confirmation/concurrency cases fail.

- [ ] **Step 8: Implement the guarded one-shot operation**

Share `globalThis.__codexDeckReasoningGuardStates` and `evaluationNamespace` with ordinary Reasoning. Inside the lock: validate current authority and Ultra policy; return the current pair for an exact no-op; reserve uncertainty; invoke `onSelectModel(modelId, reasoningEffort)` once; re-resolve the entire seam on immediate, microtask, and bounded 8 ms macrotask polls; clear uncertainty only after exact pair confirmation. On failure retain uncertainty, return an internal sentinel so metadata refusal does not disconnect, and rotate the namespace only for transport/evaluation failures.

- [ ] **Step 9: Verify and commit Task 3**

```bash
npx tsx --test test/micro-bridge.test.ts
npm run check
git diff --check
git add src/types.ts src/codex-micro-renderer-bridge.ts test/micro-bridge.test.ts
git commit -m "feat: apply confirmed Codex model presets"
```

### Task 4: Live property-inspector catalog and per-knob editor

**Files:**
- Modify: `src/dial-action.ts`
- Modify: `src/controller.ts`
- Modify: `static/property-inspector/codex-dial.html`
- Test: `test/dial-action.test.ts`
- Test: `test/controller-dial.test.ts`

- [ ] **Step 1: Add failing action-channel and visible-inspector lifecycle tests**

Add adapter tests for `onPropertyInspectorDidAppear` and `onSendToPlugin`. Only the exact plain request is accepted:

```ts
{ kind: "request-model-catalog", requestGeneration: 7 }
```

The controller response is exact plain data containing a controller-assigned monotonic catalog revision, current host ID/platform, snapshot generation, active pair, and catalog. Add `onPropertyInspectorDidAppear` registration and `onPropertyInspectorDidDisappear` unregistration tests. While the same inspector remains open, switching the target host, reconnecting with a new identity/generation, or receiving a changed authoritative catalog must push a newer revision through that exact action. Accessors, extras, symbols, wrong contexts, stale action registrations, and unavailable authority produce an exact unavailable response without throwing. A reply arriving after disappear/reappear must not overwrite the newer registration.

- [ ] **Step 2: Run adapter/controller tests and capture RED**

```bash
npx tsx --test --test-name-pattern "model catalog|property inspector" test/dial-action.test.ts test/controller-dial.test.ts
```

Expected: missing SDK handlers and controller response method.

- [ ] **Step 3: Implement the plugin-to-inspector request and push path**

Import `PropertyInspectorDidAppearEvent`, `PropertyInspectorDidDisappearEvent`, and `SendToPluginEvent` in `src/dial-action.ts`. Delegate through the exact dial action, and use `ev.action.sendToPropertyInspector(payload)` so replies cannot leak to another visible inspector. In `DeckController`, keep a visible-inspector registration keyed by action ID and registration generation, dedupe the last sent catalog signature, and assign a monotonic catalog revision. Snapshot and clone only the current target host's normalized catalog and identity/generation. Push a new or unavailable catalog on target toggle, relay ready/disconnect/identity change, local or remote snapshot generation change, and initial appear/request. Dispose the registration on disappear or action replacement and catch every send failure.

- [ ] **Step 4: Add failing inspector editor tests**

Extend the existing DOM-lite harness for:

- Model Presets option and panel;
- preferred-pair seeding only after authoritative catalog receipt;
- model dropdowns and model-specific effort dropdowns;
- Add, Remove, drag reorder, Move Up, and Move Down;
- twelve-row cap and duplicate prevention;
- Include Ultra filtering that preserves disabled Ultra rows;
- unavailable versus unknown rows;
- offline saved-row preservation;
- complete v2 `setSettings` payloads;
- stale socket, monotonic catalog revision, host switch without inspector reopen, disappear/reappear, and pre-open edit fencing.

- [ ] **Step 5: Run inspector tests and capture RED**

Run `test/dial-action.test.ts`. Expected: missing controls and message handling failures.

- [ ] **Step 6: Implement the live editor**

Add a dedicated panel and render rows from saved settings plus transient catalog state. Request catalog after registration, then accept controller pushes only on the current WebSocket when their catalog revision is strictly newer than the last accepted revision. Reset the accepted revision on reconnect; host identity and snapshot generation remain display/diagnostic fields, while the controller's monotonic revision supplies ordering. Persist stable IDs/efforts only. Implement HTML5 drag ordering plus the same operation through accessible buttons and labels.

- [ ] **Step 7: Verify and commit Task 4**

```bash
npx tsx --test test/dial-action.test.ts test/controller-dial.test.ts
npm run check
git diff --check
git add src/dial-action.ts src/controller.ts static/property-inspector/codex-dial.html test/dial-action.test.ts test/controller-dial.test.ts
git commit -m "feat: configure model presets per dial"
```

### Task 5: Local dial queue, switching feedback, and confirmed snapshot patch

**Files:**
- Modify: `src/dial-types.ts`
- Modify: `src/dial-domain.ts`
- Modify: `src/controller.ts`
- Test: `test/dial-domain.test.ts`
- Test: `test/controller-dial.test.ts`

- [ ] **Step 1: Add failing direction-only queue tests**

Simulate three rapid clockwise detents from the first of three pairs while holding each bridge result. Assert operations begin in order and resolve targets only at execution time: second, third, first. Add counter-clockwise wrap, unlisted first/last, invalid-entry skip, full queue rejection, replacement/disposal, and target-host change before execution.

- [ ] **Step 2: Run queue tests and capture RED**

```bash
npx tsx --test --test-name-pattern "model preset|rapid detent|switching" test/controller-dial.test.ts test/dial-domain.test.ts
```

Expected: `rotateDial` has no model-presets branch and no composite dispatch.

- [ ] **Step 3: Implement queued direction execution**

In `rotateDial`, special-case `{kind:"model-presets"}`. Validate tick count and queue capacity, then enqueue one closure per detent containing only clockwise/counter-clockwise and registration identity. At closure start recheck the registration, obtain the latest target view, call the pure resolver, and only then construct `ModelPresetRequest`.

- [ ] **Step 4: Add failing feedback, local patch, and race tests**

Assert `SWITCHING…` renders before bridge resolution without displaying the target. On success assert local snapshot generation increments, both model and effort patch immutably, same registration redraws, and a held pre-command poll cannot overwrite. On partial/refused execution assert a forced refresh wins, actual pair renders `UNLISTED`, a temporary error restores current feedback safely, and no rollback command occurs.

- [ ] **Step 5: Run lifecycle tests and capture RED**

Expected: switching/patch/reconciliation assertions fail.

- [ ] **Step 6: Implement local dispatch and registration-safe feedback**

Add a dedicated `sendModelPresetToHost` path rather than overloading reasoning result parsing. Use explicit in-flight state serialized with `registration.rendering`; do not reuse `noticeActive` as the switching state. Parse the bridge result through exact descriptor-safe validation. Advance `localSnapshotGeneration` before the protected operation, patch only a valid exact confirmed result, and force authoritative reconciliation after failure.

- [ ] **Step 7: Verify and commit Task 5**

```bash
npx tsx --test test/dial-domain.test.ts test/controller-dial.test.ts test/micro-bridge.test.ts
npm run check
git diff --check
git add src/dial-types.ts src/dial-domain.ts src/controller.ts test/dial-domain.test.ts test/controller-dial.test.ts
git commit -m "feat: switch model presets from the dial"
```

### Task 6: Capability-negotiated relay support

**Files:**
- Modify: `src/relay-protocol.ts`
- Modify: `src/codex-relay-server.ts`
- Modify: `src/codex-relay-client.ts`
- Modify: `src/controller.ts`
- Test: `test/relay.test.ts`
- Test: `test/controller-dial.test.ts`

- [ ] **Step 1: Add failing strict protocol and compatibility tests**

Define a capability `model-presets` and exact wire shapes:

```ts
{
  kind: "model-preset",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "high",
  includeUltra: false,
  includeModelPresetFeedback: true
}
```

and a successful result carrying both confirmed identifiers. Test extra/missing/accessor/symbol/unsafe/oversized fields. Test new-to-old refusal before `socket.send`, old-to-new unchanged behavior, and new-to-new acceptance.

- [ ] **Step 2: Run relay tests and capture RED**

```bash
npx tsx --test --test-name-pattern "model preset|model-presets" test/relay.test.ts test/controller-dial.test.ts
```

Expected: missing protocol command, capability, and result type.

- [ ] **Step 3: Implement protocol, server, and client parsing**

Extend the v1 additive capability list. Require capability only for the new command. Generalize pending command metadata and result unions without treating a model-preset result as a reasoning outcome. The server invokes `applyModelPreset`, validates exact output, forces a fresh snapshot, publishes it, then sends the result.

- [ ] **Step 4: Add failing FIFO and identity-fence tests**

Hold a pre-command snapshot, issue the model preset, and assert the server waits it out, forces/publishes a newer snapshot, then acknowledges. Test result rejection after socket generation, host ID, platform, ready identity, or snapshot generation changes. Assert the client patch is immutable and only affects the exact current host snapshot.

- [ ] **Step 5: Run ordering tests and capture RED**

Expected: old reasoning-only ordering and pending correlation are insufficient.

- [ ] **Step 6: Implement remote dispatch and confirmed redraw**

Wire `applyModelPreset` into the relay control created by `DeckController.start`. Refuse unsupported peers before send. Accept results only for the exact current generation and host identity after the forced snapshot barrier, patch both identifiers, and redraw only the current dial registration. On any mismatch reject and retain the last authoritative state.

- [ ] **Step 7: Verify and commit Task 6**

```bash
npx tsx --test test/relay.test.ts test/controller-dial.test.ts
npm run check
git diff --check
git add src/relay-protocol.ts src/codex-relay-server.ts src/codex-relay-client.ts src/controller.ts test/relay.test.ts test/controller-dial.test.ts
git commit -m "feat: relay confirmed model preset changes"
```

### Task 7: Documentation, independent review, release gates, merge, and install

**Files:**
- Modify: `docs/STREAM_DECK_PLUS.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `test/dial-action.test.ts`

- [ ] **Step 1: Add a failing documentation-contract test**

Assert the guide documents immediate wrapped application, per-knob live dropdowns, the three preferred defaults, truthful switching/confirmed/unlisted feedback, Ultra policy, unavailable-entry preservation/skipping, and no keyboard/focus navigation.

- [ ] **Step 2: Run the guide test and capture RED**

```bash
npx tsx --test --test-name-pattern "Stream Deck Plus guide" test/dial-action.test.ts
```

Expected: new exact claims are absent.

- [ ] **Step 3: Update user-facing documentation**

Add Model Presets to the recommended layout, configuration table, behavior section, troubleshooting, compatibility boundary, and physical QA checklist. Add concise README and changelog entries without claiming Windows physical verification.

- [ ] **Step 4: Run focused docs tests and commit**

```bash
npx tsx --test test/dial-action.test.ts test/release-audit.test.ts
git diff --check
git add docs/STREAM_DECK_PLUS.md README.md CHANGELOG.md test/dial-action.test.ts
git commit -m "docs: explain the model presets dial"
```

- [ ] **Step 5: Run independent final subagent reviews**

Dispatch separate read-only spec-conformance, code-quality/security, and release-QA reviewers over `main...HEAD`. Correct every Critical or Important finding through a failing regression, minimal fix, focused verification, and a separate commit. Repeat review until approved.

- [ ] **Step 6: Run all release gates serially**

```bash
npm run check
npm test
npm run build
npm run validate
npm run audit:release
git diff --check main...HEAD
git status --short
```

Expected: typecheck passes; every test passes except the existing intentional platform skip; Stream Deck validation succeeds; all three release roots pass audit; range diff is clean; only validator-regenerated tracked plugin PNGs may be dirty. Restore only those two known generated PNGs before proceeding.

- [ ] **Step 7: Run safe live and physical QA**

First run a read-only production-expression probe that confirms the current catalog, unique active component, direct paired callback resolver, and current pair without invoking the callback. Back up the installed plugin, watcher runtime, LaunchAgent, and active Stream Deck + profile. Install the candidate, preserve a healthy Codex process, then physically verify the three preferred pairs, both wrap directions, rapid detents, Fast touch, restart persistence, and unavailable-entry handling. Record exact Codex, Stream Deck, macOS, and plugin versions.

- [ ] **Step 8: Merge and verify local main**

With a clean feature branch and approved reviews:

```bash
git switch main
git merge --ff-only feat/model-presets-dial
npm run check
npm test
```

Expected: fast-forward succeeds and post-merge verification is green. Retain `feat/model-presets-dial` for the future pull request and do not push remotely.

- [ ] **Step 9: Install the merged build and verify live readiness**

Build from merged `main`, replace only the backed-up `com.simeo.codex-deck.sdPlugin`, reinstall the macOS watcher runtime, relaunch Stream Deck, and verify matching hashes, a running LaunchAgent, the existing Codex PID/bridge when healthy, `local=ready`, and `Codex Micro layout synchronized`. Confirm the Reasoning knob and all existing keypad actions remain unchanged.
