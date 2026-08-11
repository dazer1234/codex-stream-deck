# Reasoning Dial Immediate Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update Reasoning dial feedback immediately from Codex's confirmed result while repairing current live model discovery without weakening the Ultra guard.

**Architecture:** Extend reasoning execution with an optional confirmed effort, propagate it through the exact relay result contract, and commit it to the matching host snapshot before immediately rendering dials. Read the unique visible ordinary-DOM model label beneath the unique visible reasoning trigger, strictly normalize it, and resolve it uniquely to a descriptor-safe, bounded, fully validated `models/list` record whose ordered supported efforts remain authoritative.

**Tech Stack:** TypeScript, Node test runner via `tsx --test`, Elgato Stream Deck SDK, Electron CDP renderer evaluation, WebSocket relay protocol, Swift source contract.

---

### Task 1: Recover the current live reasoning model from its visible label

**Files:**
- Modify: `src/codex-micro-renderer-bridge.ts`
- Test: `test/micro-bridge.test.ts`

- [ ] **Step 1: Write the failing current-shape DOM-label test**

Add a fixture in which the unique visible reasoning trigger reports effort `high` and its ordinary DOM descendants contain a hidden measurement label `5.3 Codex Spark` plus the unique visible label `5.6 Sol`. Pair it with a validated `models/list` record whose `displayName` is `GPT-5.6-Sol`, model ID is `gpt-5.6-sol`, and `supportedReasoningEfforts` has a distinctive test order. Assert:

```ts
assert.deepEqual(readActiveReasoningMetadata([trigger], reactRootFiber, isVisible), {
  currentEffort: "high",
  modelId: "gpt-5.6-sol",
  supportedEfforts: expectedEffortsFromMatchedRecord
});
```

Also assert that zero or multiple visible labels, label-normalization collisions, zero or multiple matching `displayName` records, React-only sibling/`selectedValue` models, hidden/measurement labels, accessors, proxies, malformed strings/records, and DOM/catalog depth, node, array, query, or property exhaustion return `undefined` without invoking executable properties. Include a case proving the hidden `5.3 Codex Spark` measurement label cannot select its catalog record.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test --test-name-pattern='visible reasoning model label|reasoning metadata' test/micro-bridge.test.ts`

Expected: FAIL because the current extractor authorizes a model from React `selectedValue`/sibling data and does not map the visible ordinary-DOM label to a validated catalog `displayName`.

- [ ] **Step 3: Implement bounded DOM-label discovery and catalog resolution**

Replace React model discovery with a helper that, under the unique visible semantic reasoning trigger, collects the unique visible, non-hidden, non-measurement ordinary-DOM model label with explicit string/node/depth bounds. Normalize bounded safe labels by trimming and ASCII-case-folding, tokenizing only on spaces/hyphens, and removing only an exact leading `gpt` token from catalog `displayName` values; compare the complete remaining token sequence, never a substring or fuzzy match.

Replace the separate model-ID effort lookup with bounded `models/list` extraction that validates each candidate record as safe own data before matching its normalized `displayName`, requires exactly one matching record, and returns that same record's safe model ID and `supportedReasoningEfforts` in original order. Do not inspect or accept React `selectedValue` or sibling model values as model authorization. Reuse descriptor-safe own-data readers for cache data and fail closed on zero/multiple matches, malformed/accessor/proxy-backed data, any exhausted bound, or traversal ambiguity.

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

Make all bridge reasoning paths return this type. Poll `readActiveReasoningEffort` after the verified command, include only safe confirmed values, preserve the global mutex and uncertainty reservation, and fail honestly when an interior transition cannot be confirmed. Mechanically extract `.outcome` in the controller and relay server so existing behavior remains type-safe until Tasks 3 and 4 consume the new effort. Update typed test stubs without adding immediate-render or relay-effort behavior early.

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

### Task 3: Propagate confirmed effort through the relay safely

**Files:**
- Modify: `src/relay-protocol.ts`
- Modify: `src/codex-relay-server.ts`
- Modify: `src/codex-relay-client.ts`
- Modify: `ios/CodexDeckMobile/Models/RelayModels.swift` only if decoding requires an explicit ignored field
- Test: `test/relay.test.ts`
- Test: `ios/CodexDeckMobileTests/MobileMergeTests.swift` only if Swift decoding changes

- [ ] **Step 1: Write failing exact-shape and generation tests**

Cover a capable reasoning success with:

```json
{"type":"result","protocol":1,"requestId":"r1","ok":true,"outcome":"applied","reasoningEffort":"xhigh"}
```

Reject blank/oversized/malformed effort, effort on failure, effort on non-reasoning pending commands, accessors, symbols, and extra keys. Prove only a current ready-generation reasoning request can patch the retained remote snapshot. Preserve legacy unrestricted outcome-less mapping without a fabricated effort.

- [ ] **Step 2: Run relay tests and verify RED**

Run: `npx tsx --test --test-name-pattern='reasoning effort|reasoning outcome' test/relay.test.ts`

Expected: FAIL because relay results cannot carry or commit a confirmed effort.

- [ ] **Step 3: Implement the exact protocol and client commit**

Add optional bounded `reasoningEffort` only to successful typed reasoning results. Correlate validation with the pending command kind and current ready connection generation. Patch only `snapshot.snapshot.reasoningEffort`; do not change the rest of the snapshot or its observation time.

- [ ] **Step 4: Run relay tests and typecheck**

Run:

```bash
npx tsx --test test/relay.test.ts
npm run check
```

Expected: relay tests and typecheck pass after Task 4 propagation is complete.

- [ ] **Step 5: Commit the slice**

```bash
git add src/relay-protocol.ts src/codex-relay-server.ts src/codex-relay-client.ts test/relay.test.ts
git commit -m "feat: relay confirmed reasoning effort"
```

### Task 4: Render confirmed feedback immediately

**Files:**
- Modify: `src/controller.ts`
- Test: `test/controller-dial.test.ts`

- [ ] **Step 1: Write the failing no-poll controller test**

Hold the global refresh indefinitely, return `{ outcome: "applied", reasoningEffort: "xhigh" }` from the local bridge, rotate one detent, await the dial queue, and assert the final Encoder feedback is `XHIGH`. Add remote current-generation parity, rapid ordered detents, blocked notice, and failure/no-confirmation cases.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx --test --test-name-pattern='confirmed reasoning feedback|Reasoning dial' test/controller-dial.test.ts`

Expected: FAIL because the controller neither commits the returned effort nor rerenders after the command.

- [ ] **Step 3: Commit and render the confirmed value**

For local results, immutably copy the current matching `localSnapshot` with the confirmed `reasoningEffort`. For remote results, rely on the relay client's current-generation patch. Immediately call the existing registration-safe dial renderer after the snapshot commit. Do nothing on missing effort, errors, stale host identity, or malformed results. Preserve `ULTRA OFF` notice serialization.

- [ ] **Step 4: Run controller, relay, bridge, and type checks**

Run:

```bash
npx tsx --test test/controller-dial.test.ts test/relay.test.ts test/micro-bridge.test.ts
npm run check
```

Expected: all focused tests pass and no 1.2-second timer is needed by the immediate-feedback test.

- [ ] **Step 5: Commit the slice**

```bash
git add src/controller.ts test/controller-dial.test.ts
git commit -m "fix: render reasoning feedback immediately"
```

### Task 5: Document, review, verify, merge, and install

**Files:**
- Modify: `docs/STREAM_DECK_PLUS.md`
- Test: `test/dial-action.test.ts`

- [ ] **Step 1: Add a failing guide assertion and document the contract**

Assert the guide states Reasoning feedback updates from Codex's confirmed level immediately and background polling only reconciles it. Do not claim optimistic or zero-latency behavior.

- [ ] **Step 2: Run documentation and full verification**

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

- [ ] **Step 3: Run a live read-only metadata probe**

Against the current Codex main renderer, verify without executing a command that the unique visible trigger reports effort `high`; its ordinary DOM contains hidden measurement label `5.3 Codex Spark` and unique visible label `5.6 Sol`; strict normalization maps that label uniquely to the validated `models/list` record with `displayName` `GPT-5.6-Sol` and model ID `gpt-5.6-sol`; and the result preserves that same record's supported reasoning effort order. Record the observed order from the live record rather than asserting an unverified hardcoded sequence.

- [ ] **Step 4: Request independent final review**

Review the complete diff for ordinary-DOM visibility/measurement filtering, strict label normalization, unique catalog matching, descriptor and traversal safety, absence of React model authorization, protected command isolation, confirmation honesty, relay generation handling, registration-safe immediate redraw, background-poll reconciliation, rapid-detent serialization, notice races, and packaging. Fix every Critical or Important finding with a separate RED/GREEN correction commit and re-review.

- [ ] **Step 5: Commit docs, merge, and verify main**

```bash
git add docs/STREAM_DECK_PLUS.md test/dial-action.test.ts
git commit -m "docs: explain immediate reasoning feedback"
git switch main
git merge --ff-only fix/reasoning-dial-feedback-latency
npm run check
npm test
```

- [ ] **Step 6: Back up and install**

Quit Stream Deck, create timestamped backups of the installed `com.simeo.codex-deck.sdPlugin` and active Stream Deck+ profile, atomically replace the plugin with `dist/com.simeo.codex-deck.sdPlugin`, relaunch Stream Deck, and verify matching bundle hashes, `local=ready`, layout synchronization, explicit `includeUltraReasoning:false`, and a clean `main` worktree.
