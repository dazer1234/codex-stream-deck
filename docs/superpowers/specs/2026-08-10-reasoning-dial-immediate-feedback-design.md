# Reasoning Dial Immediate Feedback Design

## Problem

Reasoning detents send a Codex command but do not update the Stream Deck feedback afterward. The displayed level changes only when the controller's global 1.2-second snapshot poll runs, so a successful detent takes roughly 0–1.2 seconds plus rendering time to appear. Rapid detents queue behind that work and can feel slower. Action-selector rotation is local state and renders immediately, which explains the contrast.

The installed runtime log also shows repeated `Codex reasoning metadata is unavailable` failures. A read-only live probe found the current Codex trigger reports `high` and contains one model, `gpt-5.3-codex-spark`, but the model now lives in a visible sibling branch rather than beneath the older `selectedValue` branch. The query cache still authoritatively reports the model's supported order as `low`, `medium`, `high`, `xhigh`. The current extractor therefore fails before dispatch even though all required data exists.

## Goals

- Make a successful Reasoning detent update the Stream Deck as soon as Codex confirms the resulting level, without waiting for the 1.2-second background poll.
- Keep feedback authoritative. Never invent or optimistically advance a level Codex has not reported.
- Preserve the per-knob `Include Ultra` policy and the exact temporary `ULTRA OFF` notice.
- Support both the older selected-value model shape and the current unique visible-trigger sibling shape without weakening fail-closed ambiguity checks.
- Preserve local and current-generation relay behavior; legacy unrestricted peers may continue without immediate confirmed-level feedback.

## Non-goals

- Do not lower the global poll interval.
- Do not change the Action selector, keypad Reasoning controls, Fast Mode, or native Codex confirmation dialogs.
- Do not add optimistic animation or synthetic intermediate levels.
- Do not accept multiple, hidden, accessor-backed, proxy-backed, malformed, or traversal-truncated model candidates.

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

- Model discovery traverses only own data descriptors under the one visible reasoning trigger.
- It accepts exactly one safe model across either the older selected-value subtree or the current visible sibling subtree.
- Hidden/measurement branches remain excluded. Multiple or malformed candidates, proxy/accessor observations, depth/node exhaustion, and conflicting old/current candidates fail closed.
- Restricted increases still read the live model's ordered supported efforts before dispatch. If the next effort is Ultra, they return `blocked-ultra` without running a command.
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

- Unit-test both old and current live trigger model shapes, plus conflicting, hidden, accessor, proxy, depth, and traversal limits.
- Execute the serialized renderer expression and prove applied/blocked results carry only authoritative efforts.
- Controller tests must prove immediate feedback with the global poll disabled, no update on failure/unconfirmed results, and ordered rapid detents.
- Relay tests must cover exact result parsing, current-generation snapshot patching, malformed efforts, legacy unrestricted compatibility, and restricted-peer fail-closed behavior.
- Run TypeScript checks, the complete test suite, Stream Deck package validation, the three-root release audit, and a live read-only Codex metadata probe before installation.

## Acceptance Criteria

- A normal Reasoning detent updates the Stream Deck immediately after Codex confirms the new level and does not wait for the background poll.
- The current live Codex model shape yields `high`, `gpt-5.3-codex-spark`, and `low → medium → high → xhigh` without relaxing ambiguity or executable-data protections.
- Turning above the highest non-Ultra level with Ultra excluded still shows `ULTRA OFF` and runs no increase command.
- Action-selector behavior is unchanged.
- No unconfirmed, failed, stale-host, or malformed result changes the displayed reasoning level.
