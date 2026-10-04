# Reasoning Dial Immediate Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update Reasoning dial feedback immediately from Codex's confirmed result while repairing current live model discovery without weakening the Ultra guard.

**Architecture:** Extend reasoning execution with an optional confirmed effort and commit it to the matching host snapshot before immediately rendering dials. Local commits advance `localSnapshotGeneration`; remote commits use an additive protocol-v1 `reasoning-feedback` opt-in and a forced post-command snapshot barrier before the result. Collect bounded visible ordinary-DOM leaf text candidates beneath the unique visible reasoning trigger, strictly normalize each, and accept only when they identify exactly one descriptor-safe, bounded, fully validated `models/list` record whose ordered supported efforts remain authoritative.

**Tech Stack:** TypeScript, Node test runner via `tsx --test`, Elgato Stream Deck SDK, Electron CDP renderer evaluation, WebSocket relay protocol, Swift source contract.

---

### Task 1: Recover the current live reasoning model from visible leaf candidates

**Files:**
- Modify: `src/codex-micro-renderer-bridge.ts`
- Test: `test/micro-bridge.test.ts`

- [ ] **Step 1: Write the failing current-shape DOM-leaf test**

Add a fixture in which the unique visible reasoning trigger reports effort `high` and its ordinary DOM descendants contain hidden measurement label `5.3 Codex Spark` plus multiple visible leaf text candidates, including effort `high` and model label `5.6 Sol`. Pair it with a validated `models/list` record whose `displayName` is `GPT-5.6-Sol`, model ID is `gpt-5.6-sol`, and `supportedReasoningEfforts` has a distinctive test order. Assert:

```ts
assert.deepEqual(readActiveReasoningMetadata([trigger], reactRootFiber, isVisible), {
  currentEffort: "high",
  modelId: "gpt-5.6-sol",
  supportedEfforts: expectedEffortsFromMatchedRecord
});
```

Also prove unmatched visible candidates such as `high` are ignored and repeated/unmatched DOM leaves do not create ambiguity when exactly one validated catalog record matches. Assert that zero matching records, more than one distinct matching `displayName` record across all normalized candidates, label-normalization collisions that identify distinct records, React-only sibling/`selectedValue` models, hidden/measurement candidates, accessors, proxies, malformed strings/records, and DOM/catalog depth, node, array, query, or property exhaustion return `undefined` without invoking executable properties. Include a case proving the hidden `5.3 Codex Spark` measurement label cannot select its catalog record.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test --test-name-pattern='visible reasoning model leaf|reasoning metadata' test/micro-bridge.test.ts`

Expected: FAIL because the current extractor authorizes a model from React `selectedValue`/sibling data and does not map the visible ordinary-DOM label to a validated catalog `displayName`.

- [ ] **Step 3: Implement bounded DOM-leaf discovery and catalog resolution**

Replace React model discovery with a helper that, under the unique visible semantic reasoning trigger, collects all bounded visible, non-hidden, non-measurement ordinary-DOM leaf text candidates with explicit string/node/depth bounds. Normalize each bounded safe DOM candidate and catalog `displayName` by trimming, ASCII-case-folding, and tokenizing only on spaces/hyphens; remove only an exact leading `gpt` token from catalog values, then compare complete token sequences, never substrings or fuzzy matches.

Replace the separate model-ID effort lookup with bounded `models/list` extraction that fully validates each candidate record as safe own data before comparing its normalized `displayName` against every normalized DOM candidate. Ignore unmatched candidates such as effort `high`; accept only when the comparison yields exactly one distinct matching validated record, and return that same record's safe model ID and `supportedReasoningEfforts` in original order. Do not inspect or accept React `selectedValue` or sibling model values as model authorization. Reuse descriptor-safe own-data readers for cache data and fail closed on zero matches, more than one distinct matching record, malformed/accessor/proxy-backed data, any exhausted bound, or traversal ambiguity.

- [ ] **Step 4: Run focused and bridge tests**

Run:

```bash
npx tsx --test --test-name-pattern='reasoning model|reasoning metadata' test/micro-bridge.test.ts
npx tsx --test test/micro-bridge.test.ts
```

Expected: all selected tests and the full bridge file pass.

- [ ] **Step 5: Commit the slice**

```bash
git add src/codex-micro-renderer-bridge.ts test/micro-bridge.test.ts
git commit -m "fix: read current Codex reasoning model"
```

This forward correction supersedes the model-discovery behavior introduced by commits `c9067e5`, `3f8ca81`, and `3c6c7f2`; preserve those commits in history rather than rewriting them.

### Task 2: Return confirmed reasoning execution data

**Files:**
- Modify: `src/types.ts`
- Modify: `src/codex-micro-renderer-bridge.ts`
- Modify: `src/controller.ts` for mechanical outcome extraction only
- Modify: `src/codex-relay-server.ts` for mechanical outcome extraction only
- Modify: `test/controller-dial.test.ts` and `test/relay.test.ts` stubs for the structured bridge result
- Test: `test/micro-bridge.test.ts`

- [ ] **Step 1: Write failing result and serialized-expression tests**

Define the wished-for API in tests:

```ts
assert.deepEqual(
  await bridge.adjustReasoning("increase", { includeUltra: false }),
  { outcome: "applied", reasoningEffort: "xhigh" }
);
assert.deepEqual(
  await bridge.adjustReasoning("increase", { includeUltra: false }),
  { outcome: "blocked-ultra", reasoningEffort: "max" }
);
```

Execute the real serialized expressions. Prove a failed or unconfirmed interior command does not fabricate an effort, a proven boundary no-op may return the unchanged effort, and concurrent detents remain serialized.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx --test --test-name-pattern='confirmed reasoning|guarded reasoning' test/micro-bridge.test.ts`

Expected: FAIL because `adjustReasoning` returns only outcome strings.

- [ ] **Step 3: Add the structured execution type**

Add to `src/types.ts`:

```ts
export type ReasoningAdjustmentExecution = {
  outcome: ReasoningAdjustmentResult;
  reasoningEffort?: string;
};
```

Make all bridge reasoning paths return this type. Poll `readActiveReasoningEffort` after the verified command, include only safe confirmed values, preserve the global mutex and uncertainty reservation, and fail honestly when an interior transition cannot be confirmed. Mechanically extract `.outcome` in the controller and relay server so existing behavior remains type-safe until Task 3 consumes the new effort. Update typed test stubs without adding immediate-render or relay-effort behavior early.

- [ ] **Step 4: Run bridge tests and typecheck**

Run:

```bash
npx tsx --test test/micro-bridge.test.ts
npm run check
```

Expected: bridge tests and the full TypeScript check pass; relay/controller behavior remains unchanged except for consuming the structured outcome.

- [ ] **Step 5: Commit the slice**

```bash
git add src/types.ts src/codex-micro-renderer-bridge.ts src/controller.ts src/codex-relay-server.ts test/micro-bridge.test.ts test/controller-dial.test.ts test/relay.test.ts
git commit -m "feat: return confirmed reasoning effort"
```

### Task 3: Propagate and render confirmed effort without stale regressions

**Files:**
- Modify: `src/relay-protocol.ts`
- Modify: `src/codex-relay-server.ts`
- Modify: `src/codex-relay-client.ts`
- Modify: `src/controller.ts`
- Modify: `ios/CodexDeckMobile/Models/RelayModels.swift` only if decoding requires an explicit ignored field
- Test: `test/relay.test.ts`
- Test: `test/controller-dial.test.ts`
- Test: `ios/CodexDeckMobileTests/MobileMergeTests.swift` only if Swift decoding changes

- [ ] **Step 1: Write failing protocol, ordering, generation, and no-poll tests**

Add `RELAY_REASONING_FEEDBACK_CAPABILITY = "reasoning-feedback"` to the wished-for protocol. Cover a capable client command and successful result with these exact additive v1 shapes:

```json
{"kind":"reasoning","direction":"increase","includeUltra":false,"includeReasoningFeedback":true}
{"type":"result","protocol":1,"requestId":"r1","ok":true,"outcome":"applied","reasoningEffort":"xhigh"}
```

Reject `includeReasoningFeedback: false`, unknown/extra command keys, blank/oversized/malformed effort, effort on failure, effort on a non-reasoning or non-opted-in pending command, accessors, symbols, and extra result keys. Prove only a request recorded against the current ready connection generation and host can patch the retained remote snapshot.

Add explicit rolling-upgrade cases:

- Old client to new server sends no feedback flag; even if the new bridge confirms an effort, the server returns no `reasoningEffort` key.
- New client to old server sees no `reasoning-feedback` capability, sends the legacy command shape, accepts the legacy reasoning outcome, and preserves the existing outcome-less unrestricted mapping when `reasoning-policy` is absent.
- New client to new server advertises/detects `reasoning-feedback`, sends `includeReasoningFeedback: true`, and receives the exact confirmed effort.
- Restricted reasoning remains rejected before send unless the same current-ready peer also advertises `reasoning-policy`.

Add a deterministic server/client ordering test in one connection generation. Hold a pre-command `control.refresh()`, execute an opted-in reasoning command, and prove no result is sent while that read is held. Release it, then assert the socket/client observes the old snapshot, a forced fresh post-command snapshot, and only then the result. After the result patches the retained remote snapshot, prove no pre-command snapshot can arrive or commit and regress the displayed effort.

For local feedback, hold `microBridge.refresh()` after it captures the current `localSnapshotGeneration`, return `{ outcome: "applied", reasoningEffort: "xhigh" }` from the command, and prove the controller advances the generation, patches the local snapshot, and renders `XHIGH` without waiting for the poll. Release the held refresh with an older effort and prove both snapshot and dial remain `xhigh`. Also cover remote current-generation parity, rapid ordered detents, `ULTRA OFF`, and failure/no-confirmation cases.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='reasoning feedback|reasoning outcome|pre-command reasoning' test/relay.test.ts
npx tsx --test --test-name-pattern='confirmed reasoning feedback|pre-command reasoning|Reasoning dial' test/controller-dial.test.ts
```

Expected: FAIL because protocol v1 has no feedback opt-in/result field, the relay does not place a forced post-command snapshot barrier before the result, and the controller neither invalidates an older local refresh nor commits/renders confirmed effort.

- [ ] **Step 3: Implement additive negotiation, ordered relay commit, and local invalidation**

Keep protocol version 1 and add the explicit `reasoning-feedback` ready capability. Permit the exact `includeReasoningFeedback: true` command key only on reasoning commands. The client adds it only when the current ready connection advertises the capability; otherwise it sends the legacy command shape. Keep `reasoning-policy` gating independent and unchanged. Record command kind, feedback opt-in, ready host ID, and connection generation in the pending entry.

The server may serialize `reasoningEffort` only when the reasoning command opted in and its structured execution returned a safe confirmed effort; opted-in success without an exact outcome/effort fails rather than emitting a partial feedback result. When the flag is absent, strip the effort and emit the legacy-compatible result shape. On opted-in success, call and await `publishSnapshot(undefined, true)` before `sendResult`. This reuses `currentSnapshotMessage(true)`: it captures and awaits any prior `snapshotInFlight`, ignores only that prior read's rejection, performs a new `control.refresh()`, broadcasts the forced fresh snapshot, and then allows the result send. Since an already-awaiting older publisher sends first and all frames use the same WebSocket, FIFO order is old snapshot, fresh snapshot, result.

On the client, accept and apply effort only for the correlated opted-in reasoning request while its recorded generation and host still match the current ready connection and retained snapshot. Patch only `snapshot.snapshot.reasoningEffort`; preserve the rest of the snapshot and `observedAt`. Exact parsing must reject feedback fields in every uncorrelated shape.

For a local confirmed result, synchronously increment `localSnapshotGeneration` before immutably replacing `localSnapshot.snapshot.reasoningEffort`, with no `await` between invalidation and replacement. This makes any `refreshOnce()` that captured the old generation return before committing. Immediately call the existing registration-safe dial renderer. Remote commands rely on the server barrier and current-generation client patch before the controller renders. Do nothing on missing effort, command error, stale host/generation, or malformed result, and preserve `ULTRA OFF` notice serialization.

- [ ] **Step 4: Run controller, relay, bridge, and type checks**

Run:

```bash
npx tsx --test test/controller-dial.test.ts test/relay.test.ts test/micro-bridge.test.ts
npm run check
```

Expected: every focused test and the full TypeScript check pass in this commit. The immediate-feedback tests do not require the 1.2-second timer; held pre-command local/remote reads cannot regress confirmed feedback; and both rolling-upgrade directions retain their legacy shapes.

- [ ] **Step 5: Commit the slice**

```bash
git add src/relay-protocol.ts src/codex-relay-server.ts src/codex-relay-client.ts src/controller.ts test/relay.test.ts test/controller-dial.test.ts
# If Swift decoding changed, also stage the two conditional iOS files listed above.
git commit -m "fix: render confirmed reasoning feedback immediately"
```

### Task 4: Document, review, verify, merge, and install

**Files:**
- Modify: `docs/STREAM_DECK_PLUS.md`
- Test: `test/dial-action.test.ts`

- [ ] **Step 1: Add the test-only failing guide assertion**

In `test/dial-action.test.ts`, add assertions requiring the guide to state that Reasoning feedback updates from Codex's confirmed level immediately, without waiting for the background poll, and that background polling only reconciles it. Do not edit `docs/STREAM_DECK_PLUS.md` in this step, and do not assert optimistic or zero-latency behavior.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test --test-name-pattern='Stream Deck Plus guide' test/dial-action.test.ts`

Expected: FAIL because `docs/STREAM_DECK_PLUS.md` does not yet contain the immediate-confirmed-feedback and background-reconciliation wording.

- [ ] **Step 3: Document the confirmed feedback contract**

Update `docs/STREAM_DECK_PLUS.md` to state that a successful Reasoning detent redraws from Codex's confirmed effort immediately without waiting for the scheduled poll, while the background poll continues as reconciliation. Do not claim optimistic feedback or zero latency.

- [ ] **Step 4: Rerun the focused test and verify GREEN**

Run: `npx tsx --test --test-name-pattern='Stream Deck Plus guide' test/dial-action.test.ts`

Expected: PASS with the new guide assertion satisfied.

- [ ] **Step 5: Run full verification**

Run:

```bash
npx tsx --test test/dial-action.test.ts
npm run check
npm test
npm run validate
npm run audit:release
git diff --check
git status --short
```

Expected: 0 failures; only the intentional platform skip; Stream Deck validation and all release roots pass. Restore only the two known validator-regenerated plugin PNGs if needed.

- [ ] **Step 6: Run a live read-only metadata probe**

Against the current Codex main renderer, verify without executing a command that the unique visible trigger reports effort `high`; its ordinary DOM contains hidden measurement label `5.3 Codex Spark` and multiple visible leaf candidates including effort `high` and model label `5.6 Sol`; strict normalization ignores unmatched effort text and identifies exactly one validated `models/list` record with `displayName` `GPT-5.6-Sol` and model ID `gpt-5.6-sol`; and the result preserves that same record's supported reasoning effort order. Record the observed order from the live record rather than asserting an unverified hardcoded sequence.

- [ ] **Step 7: Request independent final review**

Review the complete diff for ordinary-DOM visibility/measurement filtering, strict label normalization, unique catalog matching, descriptor and traversal safety, absence of React model authorization, protected command isolation, confirmation honesty, relay generation handling, registration-safe immediate redraw, background-poll reconciliation, rapid-detent serialization, notice races, and packaging. Fix every Critical or Important finding with a separate RED/GREEN correction commit and re-review.

- [ ] **Step 8: Commit docs, merge, and verify main**

```bash
git add docs/STREAM_DECK_PLUS.md test/dial-action.test.ts
git commit -m "docs: explain immediate reasoning feedback"
git switch main
git merge --ff-only fix/reasoning-dial-feedback-latency
npm run check
npm test
```

- [ ] **Step 9: Back up and install**

Quit Stream Deck, create timestamped backups of the installed `com.simeo.codex-deck.sdPlugin` and active Stream Deck+ profile, atomically replace the plugin with `dist/com.simeo.codex-deck.sdPlugin`, relaunch Stream Deck, and verify matching bundle hashes, `local=ready`, layout synchronization, explicit `includeUltraReasoning:false`, and a clean `main` worktree.
