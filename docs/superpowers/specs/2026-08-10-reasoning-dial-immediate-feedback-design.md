# Reasoning Dial Immediate Feedback Design

## Problem

Reasoning detents send a Codex command but do not update the Stream Deck feedback afterward. The displayed level changes only when the controller's global 1.2-second snapshot poll runs, so a successful detent takes roughly 0–1.2 seconds plus rendering time to appear. Rapid detents queue behind that work and can feel slower. Action-selector rotation is local state and renders immediately, which explains the contrast.

The installed runtime log also shows repeated `Codex reasoning metadata is unavailable` failures. The earlier React-tree interpretation was disproved by a later read-only live probe: beneath the unique visible reasoning trigger, ordinary DOM contains a hidden measurement label `5.3 Codex Spark` and one visible model label `5.6 Sol`. The validated `models/list` query cache contains the uniquely matching record with `displayName` `GPT-5.6-Sol` and model ID `gpt-5.6-sol`. That record, not the DOM or a React sibling/`selectedValue` value, is authoritative for the ordered supported reasoning efforts. The current extractor therefore fails before dispatch because it authorizes the model from the wrong source even though all required data exists.

This design is a forward correction that supersedes the model-discovery behavior introduced by commits `c9067e5`, `3f8ca81`, and `3c6c7f2`. Those commits remain in history; no history rewrite is required.

## Goals

- Make a successful Reasoning detent update the Stream Deck as soon as Codex confirms the resulting level, without waiting for the 1.2-second background poll.
- Keep feedback authoritative. Never invent or optimistically advance a level Codex has not reported.
- Preserve the per-knob `Include Ultra` policy and the exact temporary `ULTRA OFF` notice.
- Discover the current model from the unique visible, non-hidden, non-measurement ordinary-DOM label beneath the unique visible reasoning trigger, then map it uniquely to a validated `models/list` record by `displayName`.
- Preserve local and current-generation relay behavior; legacy unrestricted peers may continue without immediate confirmed-level feedback.

## Non-goals

- Do not lower the global poll interval.
- Do not change the Action selector, keypad Reasoning controls, Fast Mode, or native Codex confirmation dialogs.
- Do not add optimistic animation or synthetic intermediate levels.
- Do not use React `selectedValue`, React siblings, or any other React model value to authorize the active model.
- Do not accept zero or multiple visible model labels, zero or multiple normalized catalog matches, or hidden, measurement, accessor-backed, proxy-backed, malformed, over-bound, or traversal-truncated model/catalog data.

## Considered Approaches

### 1. Confirmed result with immediate render — selected

The renderer returns both the command outcome and the confirmed current effort. The controller commits that exact value to the matching host snapshot and redraws dial feedback immediately. The background poll remains a reconciliation mechanism.

This is the only approach that is both snappy and honest. It reuses the confirmation already performed by the Ultra guard and adds the same bounded confirmation to unrestricted/decrease commands.

### 2. Immediate full snapshot refresh

Run `microBridge.refresh()` after every detent. This is authoritative but refreshes every Micro signal, adds avoidable React traversal and rendering work, and serializes that cost into rapid detents.

### 3. Optimistic local advancement

Advance the displayed level before Codex confirms it, then reconcile later. This feels instant but can show a level Codex rejected or did not support, contrary to the status-focused design.

## Architecture

### Confirmed execution result

Keep `ReasoningAdjustmentResult` as the outcome vocabulary (`applied` or `blocked-ultra`) and add a structured execution result:

```ts
type ReasoningAdjustmentExecution = {
  outcome: ReasoningAdjustmentResult;
  reasoningEffort?: string;
};
```

`reasoningEffort` is present only when the renderer authoritatively reads a bounded safe effort after the command, or when it blocks before Ultra with an authoritative current effort. An applied result without a confirmed effort remains valid for a legacy unrestricted relay response but does not trigger an immediate local display change.

### Renderer behavior

- Model-label discovery starts at the one visible semantic reasoning trigger and inspects only its ordinary DOM descendants. It excludes hidden and measurement nodes and accepts exactly one visible, non-empty, bounded label.
- The visible label is strictly normalized and compared only with the strictly normalized `displayName` of fully validated `models/list` query-cache records. Normalization is an exact token transform: accept bounded safe strings, trim and ASCII-case-fold them, tokenize only on spaces/hyphens, remove only the exact leading `gpt` token from catalog display names, and compare the entire remaining token sequence. It is not substring or fuzzy matching. The live `5.6 Sol` label must therefore map uniquely to the `GPT-5.6-Sol` record and its model ID `gpt-5.6-sol`; React `selectedValue` and sibling model data have no authorization role.
- Catalog extraction remains descriptor-safe and bounded. Zero or multiple label candidates, zero or multiple matching records, malformed/accessor/proxy-backed data, bounds exhaustion, or traversal ambiguity fail closed.
- Restricted increases read the ordered `supportedReasoningEfforts` from that same uniquely matched, fully validated record before dispatch. If the next effort is Ultra, they return `blocked-ultra` without running a command.
- Applied commands poll the visible reasoning trigger for a bounded confirmation and return the confirmed effort when observed.
- If an interior adjustment cannot be confirmed, the bridge fails honestly rather than fabricating the next value. A boundary no-op may return the unchanged authoritative value only when the current supported order proves the requested direction is already at its boundary.
- The existing renderer-global serialization and uncertainty reservation remain in force.

### Controller behavior

After a local result with `reasoningEffort`, the controller copies that value into the current local host snapshot and immediately rerenders registered dials. After a current-generation relay result with `reasoningEffort`, the relay client patches only the matching retained snapshot's reasoning field before the controller rerenders. Host identity and ready-generation checks remain mandatory.

The 1.2-second poll continues normally and replaces the field with the next authoritative snapshot. A command failure, missing confirmation, stale relay generation, or malformed result does not change displayed feedback.

### Relay protocol

Capable peers may include bounded `reasoningEffort` only on a successful reasoning result. The result parser remains exact-data-only and rejects accessors, extra keys, malformed efforts, an effort on failed/non-reasoning results, and capable reasoning success without an outcome. Legacy unrestricted peers without `reasoning-policy` may still map an outcome-less response to `applied`, but never manufacture a confirmed effort.

## Timing and UX Contract

- The dial redraw is causally attached to the successful command result; it must not depend on the scheduled 1.2-second poll.
- Tests will hold the scheduled refresh indefinitely and prove the dial still changes to the confirmed effort.
- Rapid detents remain serialized so every command is ordered, but each confirmed result can update feedback before the next queued detent completes.
- `ULTRA OFF` keeps its existing 1.2-second notice and lifecycle protections.

## Error Handling

- Metadata ambiguity or absence fails closed and reports the existing dial alert/error path.
- No confirmed effort means no immediate feedback mutation.
- Pre-command or stale relay snapshots cannot overwrite a newer confirmed local result; current connection-generation rules remain authoritative.
- The command runner remains restricted to the two verified reasoning commands and cannot bypass protected keycap access controls.

## Testing

- Unit-test ordinary-DOM label discovery with the current live shape: hidden measurement `5.3 Codex Spark`, visible `5.6 Sol`, current effort `high`, and a uniquely matched validated catalog record whose `displayName` is `GPT-5.6-Sol` and model ID is `gpt-5.6-sol`.
- Prove the matched record's ordered `supportedReasoningEfforts` is preserved without hardcoding an order not established by the live probe. Cover zero/multiple visible labels, normalization collisions, zero/multiple catalog matches, React-only model data, hidden/measurement nodes, accessors, proxies, malformed data, and depth/node/query traversal bounds.
- Execute the serialized renderer expression and prove applied/blocked results carry only authoritative efforts.
- Controller tests must prove immediate feedback with the global poll disabled, no update on failure/unconfirmed results, and ordered rapid detents.
- Relay tests must cover exact result parsing, current-generation snapshot patching, malformed efforts, legacy unrestricted compatibility, and restricted-peer fail-closed behavior.
- Run TypeScript checks, the complete test suite, Stream Deck package validation, the three-root release audit, and a live read-only Codex metadata probe before installation.

## Acceptance Criteria

- A normal Reasoning detent updates the Stream Deck immediately after Codex confirms the new level and does not wait for the background poll.
- The current live Codex shape yields effort `high`, visible model label `5.6 Sol`, and model ID `gpt-5.6-sol`; its supported effort order comes unchanged from that uniquely matched validated `GPT-5.6-Sol` record rather than from an unverified hardcoded order.
- Hidden measurement label `5.3 Codex Spark`, React sibling/`selectedValue` data, ambiguous normalization matches, and unsafe or truncated catalog data cannot authorize a model.
- Turning above the highest non-Ultra level with Ultra excluded still shows `ULTRA OFF` and runs no increase command.
- Action-selector behavior is unchanged.
- No unconfirmed, failed, stale-host, or malformed result changes the displayed reasoning level.
