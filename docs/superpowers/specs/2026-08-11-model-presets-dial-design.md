# Model Presets Dial Design

**Date:** 2026-08-11  
**Status:** Approved interaction design; implementation pending  
**Scope:** Add a first-class Stream Deck + dial that switches Codex model and reasoning pairs in one confirmed operation.

## Goal

People who usually change model and reasoning together should be able to rotate one Stream Deck + knob and immediately apply an ordered preset such as:

1. `5.6 Sol · High`
2. `5.6 Sol · Medium`
3. `5.6 Terra · Medium`

The dial must remain truthful: it may show progress immediately, but it may show a preset as active only after Codex confirms both the model and reasoning level.

## Non-goals

- Replace or remove the existing Reasoning dial.
- Type keyboard shortcuts, simulate Tab navigation, or depend on composer focus.
- Dismiss or approve Codex's native Ultra confirmation.
- Persist a copy of Codex's model catalog in Stream Deck settings.
- Add model-preset controls to the iOS client in this slice.
- Fall back to partially compatible relay behavior on older peers.

## User experience

### New preset

Add **Model Presets** beside Reasoning, Agents, Actions, Navigation, Usage, and Custom in the Codex Dial property inspector. Selecting it replaces all fields for that knob with these defaults:

- paired rotation dedicated to the ordered model-preset list;
- wrap enabled;
- press set to None;
- touch tap set to Fast Mode;
- feedback set to the active model/reasoning pair;
- Include Ultra off;
- the three preferred pairs above when they are present in the current catalog.

When an authoritative catalog is available, omit only preferred pairs that it proves absent. If none of the preferred pairs are available, seed the list with the currently active pair when it is valid. Otherwise start with an empty list and show `NO PRESETS`. If the catalog is unavailable, do not infer defaults until authoritative data arrives.

### Per-knob list editor

Each Model Presets knob owns an ordered list of zero to twelve entries. Every row contains:

- a live model dropdown populated from the currently selected host;
- a reasoning dropdown limited to that model's advertised supported levels;
- a drag handle plus keyboard-accessible move up and move down controls;
- a remove control.

An **Add preset** control appends the first available pair not already present. Duplicate pairs are not allowed. The inspector never offers Ultra while Include Ultra is off. Turning Include Ultra off preserves existing Ultra rows but marks them unavailable; turning it on restores them when the current catalog still supports them. The runtime skips persisted Ultra entries while the policy is off.

The catalog is transient inspector data. Persisted entries contain the stable model ID and reasoning identifier only. Display names are always resolved from the current catalog.

When the host is offline, the inspector keeps saved rows visible, labels their current availability as unknown, and disables additions or dropdown changes that require catalog data. It never deletes saved rows because a host is temporarily unavailable.

### Rotation behavior

Each detent applies the next currently valid preset immediately. Clockwise moves forward and counter-clockwise moves backward. The valid list wraps continuously.

The active pair determines the starting index when it exactly matches a configured entry. When the active pair is unlisted:

- clockwise applies the first valid configured entry;
- counter-clockwise applies the last valid configured entry.

Entries whose model or reasoning level is no longer in the live catalog remain saved and are marked **Unavailable** in the inspector. Rotation skips them without deleting them. Position feedback counts only currently valid entries.

### Dial feedback

The LCD normally shows the resolved model display name, reasoning label, and position such as `2 / 3`. When the active pair is not listed, it shows the actual pair with `UNLISTED`. Other states are:

- `SWITCHING…` while a composite change is in flight;
- `NO PRESETS` when the list is empty or an authoritative catalog proves it contains no currently valid entries;
- the existing `DEGRADED`, `OFFLINE`, and `UNAVAILABLE` health states when authoritative data is unavailable.

`SWITCHING…` is progress feedback, not an optimistic state change. The LCD must not show the target pair as active before confirmation.

## Settings and migration

Introduce dial settings version 2. The new discriminants and fields are:

```ts
type ModelPresetEntry = {
  modelId: string;
  reasoningEffort: string;
};

type ExistingDialSettingsV2 = Omit<CodexDialSettingsV1, "version"> & {
  version: 2;
};

type ModelPresetsDialSettings = Omit<CodexDialSettingsV1, "version" | "preset" | "rotation" | "feedback"> & {
  version: 2;
  preset: "model-presets";
  rotation: { kind: "model-presets" };
  feedback: "model-presets";
  modelPresets: ModelPresetEntry[];
};

type CodexDialSettingsV2 = ExistingDialSettingsV2 | ModelPresetsDialSettings;
```

Version 2 also adds `"model-presets"` to the preset and feedback enums and `{kind: "model-presets"}` to the rotation union. Non-Model-Presets settings keep their existing fields and behavior with `version: 2`; they never persist a `modelPresets` field.

The production schema must use exact own data properties, bounded arrays, safe identifier validation, no symbols or accessors, and a maximum of twelve unique entries. Model IDs and reasoning identifiers use the same safe identifier grammar already enforced at the renderer and relay boundaries.

Version 1 settings migrate without changing any existing knob's behavior. Model Presets is opt-in; migration does not convert a Reasoning knob automatically. A malformed version 2 payload fails closed to the complete defaults for its declared preset and never partially merges untrusted nested data.

## Authoritative catalog and snapshot

Extend the Codex Micro snapshot with optional, bounded fields for:

- the active model ID and current display name;
- the validated model catalog, where each entry has a stable ID, display name, and ordered supported reasoning identifiers.

Catalog extraction reuses the descriptor-safe, clone-safe query-client path already used to authorize Reasoning adjustments. It must keep the same fail-closed limits for traversal, query-key shape, own properties, safe identifiers, duplicate records, and conflicting records. A catalog is authoritative only when all consumed fields validate.

The active model remains derived from the unique visible, non-hidden composer trigger and matched to exactly one validated catalog record. Hidden measurement labels and effort labels do not authorize a model.

The property inspector requests the current target host's catalog through the plugin connection. The controller returns only normalized plain data associated with the current host identity and generation. Reconnects, target changes, and stale property-inspector sockets cannot overwrite newer catalog data.

## Composite model-preset operation

Add one bridge operation that accepts an exact `{modelId, reasoningEffort, includeUltra}` request and returns the confirmed resulting pair.

The operation runs under the same renderer-global serialization boundary as Reasoning changes so model presets, ordinary Reasoning detents, and rapid preset detents cannot race. For each request it:

1. Reads authoritative active metadata and the current catalog.
2. Verifies the requested pair exists in the same validated catalog record and passes the Ultra policy.
3. Resolves the unique active model-picker component's native `onSelectModel(modelId, reasoningEffort)` callback from the current installed bundle.
4. Verifies that the callback is the bounded, descriptor-safe, direct two-argument application wrapper associated with the same unique visible composer and validated catalog.
5. Invokes that callback exactly once with the requested pair. Codex then submits model and reasoning together through its native thread/default settings operation and retains its own permission and Ultra safeguards.
6. Re-resolves the active component seam while polling and confirms that its exact model ID and reasoning effort both match the request.
7. Returns only the confirmed pair.

The current Codex 26.803.41515 bundle exposes the required native callback as the unique visible model-picker React ancestor's own `onSelectModel(modelId, effort)` data property. Its application path performs one native model-and-reasoning settings request for the active thread or host default. Implementation must still resolve and validate this seam at runtime rather than assuming a minified function name. It must require exactly one qualifying ancestor, bounded own-data descriptor traversal, the paired one-argument reasoning callback, an exact validated component catalog, strict callback arity/direct-forwarder shape, and final state confirmation. Generic DOM clicks, menu-coordinate clicks, keyboard events, direct Electron IPC, and unconfirmed state mutation are prohibited.

Rapid detents queue in arrival order. Each queued operation resolves its target from the state confirmed by its predecessor. The controller retains the bounded command queue and backpressure behavior already used by dials.

The controller enqueues only the detent direction and the current registration identity. It does not calculate or capture a target pair before the queued closure starts. When that closure reaches the head of the queue, it rechecks that the registration is still current, reads the latest authoritative host snapshot and catalog, and then resolves the next or previous valid pair. This prevents several rapid detents from collapsing onto the same preset. A remote command is created only after that queued target resolution.

## Snapshot update and feedback ordering

After a local success, the controller invalidates older local snapshot generations, immutably patches the confirmed model and reasoning pair, and redraws the same current dial registration immediately. Any pre-command poll that finishes later cannot overwrite the confirmed pair.

After a remote success, the relay server publishes a forced fresh post-command snapshot before acknowledging the result. The client accepts feedback only for the current connection generation and exact host ID/platform identity, then immutably patches the matching snapshot. The controller redraws only the still-current registration.

The normal 1.2-second poll remains a reconciliation path for changes made directly in Codex.

## Relay compatibility

Add an explicit `model-presets` capability to relay protocol version 1. A preset command includes the requested model ID, reasoning effort, Ultra policy, and confirmed-feedback opt-in. The result includes the exact confirmed model ID and reasoning effort.

- New client to new server: allowed when the peer advertises `model-presets`.
- New client to old server: refused before `socket.send`; no partial fallback.
- Old client to new server: unchanged because it never sends the new command.
- Reconnect or host-generation change: rejects pending preset commands and prevents stale patches.

The parser requires exact own data fields and the shared safe identifier grammar. Unknown, missing, accessor-backed, symbolic, oversized, or extra fields fail closed.

## Error behavior

If validation fails before model selection, send no command and keep the last authoritative feedback.

An absent, stale, or generation-mismatched catalog is not evidence that saved entries are invalid. In that state the dial shows `UNAVAILABLE`, sends no command, and makes no deletion or skip decision until an authoritative catalog returns. `NO PRESETS` is reserved for an empty saved list or a current authoritative catalog proving that every saved entry is invalid.

After the paired callback has been invoked, failure to confirm the exact requested pair is an uncertain result. This includes a partial model-only or effort-only state, a timeout, or an unreadable post-state. Do not attempt an automatic rollback because a rollback could itself target a stale composer or unsupported pair. Instead:

1. reserve uncertainty in the shared renderer guard;
2. force a fresh snapshot;
3. show the actual resulting pair as `UNLISTED` when available;
4. show a brief error notice;
5. require later authoritative metadata before another protected composite change proceeds.

Transport timeouts rotate the renderer guard namespace on disconnect so an abandoned evaluation cannot poison later reconnects. Property-inspector and dial failures must not create unhandled promise rejections or leave stale timers that can overwrite a newer registration.

## Testing and QA

Use test-driven slices with a failing regression before each production change.

### Domain and settings

- version 1 migration preserves every existing preset;
- exact version 2 normalization and malformed nested payload rejection;
- zero, one, and twelve entries; thirteen rejected;
- duplicate, unsafe, accessor, symbol, and oversized entries rejected;
- wrap, reverse wrap, unlisted entry, and invalid-entry skipping;
- Ultra visibility and runtime refusal when disabled.

### Property inspector

- live dropdowns use only the current host/generation catalog;
- supported efforts update with model selection;
- add, remove, drag reorder, keyboard reorder, cap, duplicate prevention, and accessibility;
- offline saved-row preservation;
- stale WebSocket and pre-registration edit safety;
- complete settings persistence and restart restoration.

### Renderer bridge

- live catalog extraction and active-model matching;
- exact application-level model selection with no keyboard/focus navigation;
- exactly one native model-and-reasoning callback invocation per preset change;
- re-resolved component state confirmation of the final pair;
- serialized rapid requests that resolve direction only at queue execution time, plus mixed Reasoning/preset requests;
- partial failure, uncertainty, timeout, reconnect, and late response behavior;
- hostile getters, proxies, symbols, conflicting catalogs, and traversal bounds.

### Controller and relay

- immediate local confirmed patch with stale-poll fencing;
- same-registration redraw and replacement/disposal safety;
- `SWITCHING…`, success, unlisted, partial-error, and health feedback;
- capability negotiation and old/new compatibility matrix;
- server forced-snapshot/result ordering;
- host ID, platform, and connection-generation fencing;
- strict command/result/snapshot grammar.

### Release and physical QA

- full typecheck, unit suite, Stream Deck validation, release audit, and diff check;
- read-only live Codex probe that confirms catalog extraction and resolver availability without invoking model selection;
- timestamped backup of the plugin, watcher runtime, and Stream Deck + profile;
- install on the real Mac without restarting a healthy Codex session;
- physically verify the three preferred presets, both wrap directions, rapid detents, Fast touch, restart persistence, and unavailable-entry behavior.

## Delivery

Implement in independently reviewable commits, with subagents performing code review and QA between slices. After all checks and physical verification pass, fast-forward the feature branch into local `main`, retain the branch for a later pull request, install the approved build, and do not push remotely unless explicitly requested.
