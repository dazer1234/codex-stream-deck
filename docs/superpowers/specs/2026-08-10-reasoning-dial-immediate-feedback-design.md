# Reasoning Dial Immediate Feedback Design

## Problem

Reasoning detents send a Codex command but do not update the Stream Deck feedback afterward. The displayed level changes only when the controller's global 1.2-second snapshot poll runs, so a successful detent takes roughly 0–1.2 seconds plus rendering time to appear. Rapid detents queue behind that work and can feel slower. Action-selector rotation is local state and renders immediately, which explains the contrast.

The installed runtime log also shows repeated `Codex reasoning metadata is unavailable` failures. The earlier React-tree interpretation was disproved by a later read-only live probe: beneath the unique visible reasoning trigger, ordinary DOM contains a hidden measurement label `5.3 Codex Spark` and multiple visible leaf texts, including current effort `high` and model label `5.6 Sol`. The validated `models/list` query cache contains the one catalog record matched by those candidates: `displayName` `GPT-5.6-Sol` and model ID `gpt-5.6-sol`. That record, not the DOM or a React sibling/`selectedValue` value, is authoritative for the ordered supported reasoning efforts. The current extractor therefore fails before dispatch because it authorizes the model from the wrong source even though all required data exists.

This design is a forward correction that supersedes the model-discovery behavior introduced by commits `c9067e5`, `3f8ca81`, and `3c6c7f2`. Those commits remain in history; no history rewrite is required.

## Goals

- Make a successful Reasoning detent update the Stream Deck as soon as Codex confirms the resulting level, without waiting for the 1.2-second background poll.
- Keep feedback authoritative. Never invent or optimistically advance a level Codex has not reported.
- Prevent pre-command local or remote snapshot work from regressing a confirmed feedback patch.
- Preserve the per-knob `Include Ultra` policy and the exact temporary `ULTRA OFF` notice.
- Discover bounded visible, non-hidden, non-measurement ordinary-DOM leaf text candidates beneath the unique visible reasoning trigger, then accept only when their normalized values identify exactly one validated `models/list` record by `displayName`.
- Preserve protocol-v1 rolling upgrades by negotiating confirmed effort feedback separately from the existing reasoning policy.
- Preserve local and current-generation relay behavior; legacy unrestricted peers may continue without immediate confirmed-level feedback.

## Non-goals

- Do not lower the global poll interval.
- Do not add a new control or change the approved dial UI.
- Do not change the Action selector, keypad Reasoning controls, Fast Mode, or native Codex confirmation dialogs.
- Do not add optimistic animation or synthetic intermediate levels.
- Do not use React `selectedValue`, React siblings, or any other React model value to authorize the active model.
- Do not accept a candidate set that maps to zero or more than one distinct normalized catalog record, or hidden, measurement, accessor-backed, proxy-backed, malformed, over-bound, or traversal-truncated model/catalog data. Multiple visible leaves are expected; unmatched leaves such as the current effort are ignored.

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

- Model-label discovery starts at the one visible semantic reasoning trigger and inspects only bounded ordinary-DOM leaf text descendants. It excludes hidden and measurement nodes and collects every visible, non-empty, bounded leaf candidate; multiple candidates are normal because the trigger also renders the current effort.
- Each DOM candidate is strictly normalized and compared only with the strictly normalized `displayName` of fully validated `models/list` query-cache records. Normalization is an exact token transform: accept bounded safe strings, trim and ASCII-case-fold them, tokenize only on spaces/hyphens, remove only the exact leading `gpt` token from catalog display names, and compare the entire remaining token sequence. It is not substring or fuzzy matching. In the live shape, `high` is unmatched and ignored while `5.6 Sol` identifies the `GPT-5.6-Sol` record and its model ID `gpt-5.6-sol`; React `selectedValue` and sibling model data have no authorization role.
- Catalog extraction remains descriptor-safe and bounded. Accept only when the complete candidate-to-catalog comparison produces exactly one distinct matching validated record. Zero matches or more than one distinct matching record, malformed/accessor/proxy-backed data, bounds exhaustion, or traversal ambiguity fail closed; repeated/unmatched DOM leaves do not by themselves create ambiguity.
- Restricted increases read the ordered `supportedReasoningEfforts` from that same uniquely matched, fully validated record before dispatch. If the next effort is Ultra, they return `blocked-ultra` without running a command.
- Applied commands poll the visible reasoning trigger for a bounded confirmation and return the confirmed effort when observed.
- If an interior adjustment cannot be confirmed, the bridge fails honestly rather than fabricating the next value. A boundary no-op may return the unchanged authoritative value only when the current supported order proves the requested direction is already at its boundary.
- The existing renderer-global serialization and uncertainty reservation remain in force.

### Controller behavior

After a local result with `reasoningEffort`, the controller synchronously increments `localSnapshotGeneration` before immutably replacing the matching local snapshot's reasoning field, with no `await` between those operations. Any refresh that captured the older generation is then unable to commit its pre-command snapshot. The controller immediately rerenders registered dials from the patched snapshot.

For remote results, the relay server provides the stale-read barrier. For an opted-in reasoning command, it waits for any prior `snapshotInFlight`, forces and publishes a fresh post-command snapshot with `publishSnapshot(undefined, true)`, and only then sends the result on the same socket. The existing `currentSnapshotMessage(true)` path awaits the prior read before starting the fresh `control.refresh()`; the older publisher sends its snapshot before the forced publisher, and WebSocket FIFO preserves the older snapshot, fresh snapshot, result order. The relay client patches only the matching retained snapshot's reasoning field when the result belongs to the current ready connection generation and host; the controller then rerenders. No new per-command remote sequence counter is needed because a pre-command snapshot cannot arrive after the result under this server barrier; the existing connection/snapshot generation checks remain in force.

The 1.2-second poll continues normally and replaces the field with the next authoritative snapshot. A command failure, missing confirmation, stale relay generation, or malformed result does not change displayed feedback.

### Relay protocol

Protocol v1 gains an additive `reasoning-feedback` capability. A client sends `includeReasoningFeedback: true` on a reasoning command only when the current ready peer advertises that capability. The server returns bounded `reasoningEffort` only for a successful reasoning command that carried that opt-in; no opt-in means no extra result key even when the server internally confirmed an effort. This does not alter `reasoning-policy`: restricted commands still require that existing capability, and legacy unrestricted peers without it may still map an outcome-less response to `applied` without manufacturing an effort.

Rolling upgrades remain symmetric:

- Old client to new server: the client sends the legacy reasoning shape; the server omits `reasoningEffort` and returns the legacy-compatible result.
- New client to old server: because the peer does not advertise `reasoning-feedback`, the client sends the legacy shape and accepts the existing outcome, or the existing outcome-less unrestricted success when `reasoning-policy` is also absent.
- New client to new server: the client opts in, the server completes the post-command snapshot barrier before its result, and the result carries the exact confirmed effort.

Command and result parsing remains exact-data-only. It rejects false/unknown feedback flags, accessors, symbols, extra keys, malformed efforts, an effort without a successful opted-in reasoning request, and opted-in reasoning success without an outcome or confirmed effort. Pending requests record command kind, feedback opt-in, ready host, and connection generation so a late or mismatched result cannot patch state.

## Timing and UX Contract

- The dial redraw is causally attached to the successful command result; it must not depend on the scheduled 1.2-second poll.
- Tests will hold the scheduled refresh indefinitely and prove the dial still changes to the confirmed effort.
- A local refresh that began before the command cannot regress the confirmed patch after it is released. On relay, an older same-generation snapshot and the forced post-command snapshot both arrive before the opted-in result, so neither can regress the result patch afterward.
- Rapid detents remain serialized so every command is ordered, but each confirmed result can update feedback before the next queued detent completes.
- `ULTRA OFF` keeps its existing 1.2-second notice and lifecycle protections.

## Error Handling

- Metadata ambiguity or absence fails closed and reports the existing dial alert/error path.
- No confirmed effort means no immediate feedback mutation.
- The local generation advance rejects pre-command refresh commits. The relay post-command publication barrier and same-socket FIFO order older snapshot, fresh snapshot, then result; current ready-connection and host checks reject late results from stale generations.
- The command runner remains restricted to the two verified reasoning commands and cannot bypass protected keycap access controls.

## Testing

- Unit-test ordinary-DOM leaf discovery with the current live shape: hidden measurement `5.3 Codex Spark`; visible leaf candidates including effort `high` and model `5.6 Sol`; and exactly one matched validated catalog record whose `displayName` is `GPT-5.6-Sol` and model ID is `gpt-5.6-sol`.
- Prove unmatched visible effort/other leaf candidates are ignored and the matched record's ordered `supportedReasoningEfforts` is preserved without hardcoding an order not established by the live probe. Cover zero matches, more than one distinct matching catalog record, normalization collisions, React-only model data, hidden/measurement nodes, accessors, proxies, malformed data, and depth/node/query traversal bounds.
- Execute the serialized renderer expression and prove applied/blocked results carry only authoritative efforts.
- Controller tests must prove immediate feedback with the global poll disabled, no update on failure/unconfirmed results, ordered rapid detents, and local generation invalidation. Deterministically hold a refresh that captured the pre-command generation, apply and render a confirmed effort, release the old refresh, and prove it cannot regress the display.
- Relay tests must cover the additive `reasoning-feedback` capability, opt-in command/result exactness, both rolling-upgrade directions, preservation of `reasoning-policy`, malformed efforts, and current-ready-generation/host patching. A deterministic same-generation test must hold a pre-command server refresh, execute an opted-in reasoning command, release the old read, observe old snapshot then forced fresh snapshot then result, and prove the client display cannot regress after the result.
- Run TypeScript checks, the complete test suite, Stream Deck package validation, the three-root release audit, and a live read-only Codex metadata probe before installation.

## Acceptance Criteria

- A normal Reasoning detent updates the Stream Deck immediately after Codex confirms the new level and does not wait for the background poll.
- The current live Codex shape yields effort `high`, multiple visible leaf candidates including `high` and model label `5.6 Sol`, and model ID `gpt-5.6-sol`; unmatched effort text is ignored, exactly one validated `GPT-5.6-Sol` record matches, and its supported effort order is preserved rather than replaced by an unverified hardcoded order.
- Hidden measurement label `5.3 Codex Spark`, React sibling/`selectedValue` data, ambiguous normalization matches, and unsafe or truncated catalog data cannot authorize a model.
- Turning above the highest non-Ultra level with Ultra excluded still shows `ULTRA OFF` and runs no increase command.
- Action-selector behavior is unchanged.
- No unconfirmed, failed, stale-host, or malformed result changes the displayed reasoning level.
- A pre-command local refresh cannot overwrite a confirmed local patch, and a pre-command same-generation remote snapshot cannot arrive or commit after an opted-in result.
- Protocol v1 rolling upgrades preserve both old-client/new-server and new-client/old-server reasoning behavior; only mutually capable, explicitly opted-in peers exchange `reasoningEffort`.
