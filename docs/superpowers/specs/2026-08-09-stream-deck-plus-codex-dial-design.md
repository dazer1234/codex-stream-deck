# Stream Deck + Codex Dial Design

**Date:** 2026-08-09

**Status:** Draft for user review

**Repository:** `dazer1234/codex-stream-deck`

**Target branch:** `feature/stream-deck-plus-dials`

## Summary

Add a single Encoder-only Stream Deck action named **Codex Dial**. Each action instance is configured independently for one Stream Deck + knob and its associated touch-strip region. A preset initializes sensible behavior, while rotation, dial press, touch tap, and feedback display remain separately configurable.

The recommended four-knob profile is the approved **Status-focused** preset:

| Knob | Rotation | Dial press | Touch tap | Default feedback |
|---|---|---|---|---|
| Reasoning | Decrease/increase reasoning one level per detent | No action | Fast mode | Current reasoning effort |
| Agents | Highlight previous/next occupied agent | Focus highlighted task | Tasks view | Agent title, state, and context use |
| Actions | Highlight previous/next configured action | Run highlighted action | Codex Micro setup | Selected action and activation hint |
| Usage | Cycle Automatic/5-hour/Weekly | Toggle single-window/overview | Refresh usage | Remaining capacity and reset time |

The feature is implemented through the existing typed controller, local Codex renderer bridge, and optional authenticated multi-host relay. It adds no shell-command surface, hotkey fallback, USB driver, arbitrary CDP endpoint, or second protocol.

## Goals

- Make Stream Deck + knobs and touch regions first-class Codex controls.
- Allow each knob to be configured independently.
- Support both immediate paired rotation controls and rotate-to-highlight selectors.
- Keep dial press and touch tap independently assignable.
- Provide useful live feedback on the touch strip.
- Preserve existing keypad actions, saved profiles, host routing, and usage-source semantics.
- Produce a focused, documented, tested change suitable for an upstream pull request.

## Non-goals

- Replacing or removing existing keypad actions.
- Exposing arbitrary commands, URLs, scripts, renderer evaluation, filesystem access, or shell execution through dial settings.
- Emulating a USB HID device or installing a driver.
- Changing launcher or watcher lifecycle policy.
- Bundling personal Stream Deck profiles or machine-specific configuration in the repository.
- Changing plugin version or creating an upstream release unless requested by the maintainer.
- Claiming Windows physical-device coverage that was not performed.

## User model

The manifest exposes one Encoder-only action with a stable UUID:

```text
com.simeo.codex-deck.codex-dial
```

Users drag **Codex Dial** to any Stream Deck + dial. Each instance stores a versioned settings object. The property inspector offers these presets:

- Reasoning
- Agents
- Actions
- Navigation
- Usage
- Custom

Choosing a preset writes a complete set of defaults. Editing any field preserves the preset as provenance but labels the instance as customized; it never changes another dial.

### Settings model

The persisted settings are JSON-only and validated against allow-listed identifiers. A representative shape is:

```ts
type CodexDialSettingsV1 = {
  version: 1;
  preset: "reasoning" | "agents" | "actions" | "navigation" | "usage" | "custom";
  customized: boolean;
  rotation: PairedRotation | SelectorRotation;
  press: DialBinding | null;
  touchTap: DialBinding | null;
  feedback: DialFeedbackMode;
};
```

`PairedRotation` holds independent counter-clockwise and clockwise typed bindings. `SelectorRotation` holds an allow-listed selector source, wrapping preference, and—in the configured-actions case—an ordered list of allowed action identifiers. Unknown versions or malformed fields normalize to safe preset defaults; they never become executable strings.

## Interaction semantics

### Paired rotation

- Positive ticks invoke the clockwise binding; negative ticks invoke the counter-clockwise binding.
- Every physical detent produces one ordered command.
- Rapid turns are serialized so commands do not overlap or reorder.
- No confirmation is shown for reasoning or other obvious adjustments.
- Reaching a supported range boundary is a harmless no-op.
- An unavailable command produces the standard Stream Deck alert and an honest unavailable feedback state.

### Selector rotation

- Rotation changes only the highlighted item; it does not execute the item.
- Dial press activates the highlighted item.
- Lists wrap by default; wrapping can be disabled.
- Agent selection skips empty slots and preserves the highlighted task by stable identity when snapshots reorder.
- Configured action selection uses the user-defined order and allow-listed action IDs.
- Usage selection cycles `auto`, `five-hour`, and `weekly`.

### Dial press and release

Dial actions receive both down and up events. The dispatcher preserves the existing lifecycle of the selected command:

- Momentary Micro/agent bindings send their existing down/up pair.
- One-shot keycap and navigation bindings run once.
- A null binding performs no action.
- Built-in safeguards stay with their command. In particular, a rate-limit reset cannot bypass the existing deliberate hold and applicability checks.

### Touch tap

Touch tap is a separate one-shot binding. It may be unassigned. Touch coordinates are not used to create hidden sub-actions within a dial segment in version 1.

### Rotation while pressed

Version 1 treats rotation the same whether or not the dial is held down. The SDK's `pressed` flag is retained as a future extension point but does not introduce a second hidden binding layer.

## Binding and selector catalog

The dial layer uses typed identifiers that map to existing controller operations:

- Reasoning increase/decrease
- Agent focus
- Codex Micro actions (`ACT06` through `ACT12`)
- Joystick navigation (plan, forward, sidebar, back)
- New task
- Host toggle
- Existing official keycap commands
- Usage refresh and display-mode changes
- Usage overview toggle
- Rate-limit reset only as a dial-press binding through its existing safeguarded hold lifecycle
- No action

The property inspector groups these choices and hides context-incompatible entries, but the runtime parser remains authoritative. In particular, rate-limit reset is not valid for rotation or touch tap because those gestures cannot preserve its deliberate hold lifecycle.

Selector sources in version 1 are:

- Occupied agents from the current merged host snapshot
- A user-ordered list of allowed Codex actions
- Usage windows (`auto`, `five-hour`, `weekly`)

Navigation is a paired-control preset rather than a selector source.

## Status-focused defaults

### Reasoning

- Rotation mode: paired
- Counter-clockwise: reasoning decrease
- Clockwise: reasoning increase
- Press: none
- Touch tap: Fast mode
- Feedback: current reasoning effort

Reasoning changes apply immediately per detent. Press is not a confirmation step.

### Agents

- Rotation mode: selector over occupied agents
- Wrap: enabled
- Press: focus highlighted agent
- Touch tap: Tasks view
- Feedback: agent title, status, host badge when relevant, and context percentage when available

### Actions

- Rotation mode: configured-action selector
- Default order: Fast, Approve, Reject, Fork, Dictation, Send
- Wrap: enabled
- Press: run highlighted action
- Touch tap: Codex Micro setup/settings action
- Feedback: selected action plus `PRESS TO RUN`

### Usage

- Rotation mode: usage selector
- Default order: Automatic, 5-hour, Weekly
- Wrap: enabled
- Press: toggle selected single-window view and two-window overview
- Touch tap: request an immediate usage refresh
- Feedback: selected mode, remaining percentage, reset countdown, health, and single/overview state

## Feedback design

The manifest references a custom 200 x 100 Encoder layout. The layout contains stable keyed fields rather than receiving arbitrary SVG markup for every refresh:

- title
- primary value
- secondary value
- optional progress indicator
- status/accent indicator
- optional activation hint

The action calls `setFeedback` only when the normalized feedback payload changes. It uses the existing controller refresh loop and image-write caching principles to avoid unnecessary USB traffic.

Feedback modes include:

- Auto/follow rotation
- Current reasoning effort
- Selected agent
- Selected action
- Navigation pair
- Usage window/overview
- Static label

Unknown, stale, degraded, disconnected, and unavailable values are labeled explicitly. Last-known information may remain visible as display-only state, consistent with existing host health behavior, but command dispatch still requires a healthy applicable route.

## Current reasoning feedback

The existing snapshot does not expose the current composer reasoning effort. The renderer bridge will make a best-effort, read-only discovery of the current effort from Codex's live renderer-owned state and add it as an optional normalized snapshot field.

```ts
type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | (string & {});

type MicroSnapshot = {
  // existing fields...
  reasoningEffort?: ReasoningEffort;
};
```

The implementation must not guess the value from the last dial movement because the effort can also change in Codex or on another paired control. If the current Codex build does not expose a confidently resolved value, the field is absent and feedback reads `REASONING · UNAVAILABLE`.

The field is optional in local and relay schemas, preserving compatibility with older paired plugin versions. Relay validation accepts its absence and rejects non-string or unreasonably large values.

## Component changes

### Manifest and static assets

- Add one `Controllers: ["Encoder"]` action.
- Add Encoder icon/background assets as needed.
- Add a custom layout JSON and trigger descriptions for rotate, push, and touch.
- Add one property-inspector HTML file for presets and advanced binding controls.
- Keep SDK version 2 and Stream Deck minimum 6.6 unless validation proves a higher minimum is technically required.

### Dial domain module

A pure module owns:

- Settings types and versioning
- Preset expansion
- Settings normalization
- Binding and selector allow lists
- Tick-to-command expansion
- Selector wrapping/clamping
- Stable selection reconciliation
- Feedback-model derivation

These functions do not depend on Stream Deck events and are unit tested directly.

### Stream Deck action

`CodexDialAction` owns:

- `onWillAppear`/`onWillDisappear` registration
- `onDidReceiveSettings` normalization and refresh
- `onDialRotate`
- `onDialDown`/`onDialUp`
- `onTouchTap`
- Per-instance selector state
- A serialized per-instance command queue
- Feedback updates and standard alert handling

It must assert `ev.action.isDial()` before dial-only feedback calls.

### Controller

The controller gains a dial registration map and narrow methods that:

- Resolve typed bindings into existing controller calls
- Select the correct host using current rules
- Register/unregister visible dial instances
- Re-render registered dials during normal refreshes
- Request a usage refresh without exposing a raw API surface

Existing keypad registrations and methods remain intact.

### Renderer bridge and relay

- Extend the local snapshot with optional reasoning effort.
- Extend relay normalization/validation for the optional field.
- Preserve current routing:
  - Agent focus routes to the agent's owning host.
  - Function, navigation, reasoning, and keycap controls route to the selected host.
  - Usage remains account-scoped and prefers a healthy local snapshot.
- Do not broaden the relay command union beyond typed operations needed by existing controls and the new usage-refresh behavior.

## Property inspector behavior

- Preset is the first field.
- Rotation mode selects paired controls or selector.
- Paired mode shows counter-clockwise and clockwise binding fields.
- Selector mode shows source, wrap toggle, and—when applicable—an ordered action list.
- Press, touch tap, and feedback remain visible as independent fields.
- Changing the preset replaces all fields after a clear user selection.
- Changing an individual field sets `customized: true`.
- Settings are persisted with the standard Stream Deck property-inspector API.
- Trigger descriptions should reflect the current instance where supported; static manifest descriptions remain accurate fallbacks.

## Error handling

- Malformed settings normalize to a known preset; they do not crash the plugin.
- Unknown action IDs are removed from selectors and never dispatched.
- Empty selectors render `NO ITEMS` and pressing shows a standard alert.
- Lost agent identity reconciles to the nearest occupied item or no selection.
- Command failures stop the current gesture lifecycle, log a concise error, and show the standard alert.
- A queued rotation command is not retried automatically after a bridge failure.
- Feedback failures are logged and deduplicated; they do not stop controller refreshes.
- Snapshot fields that cannot be discovered are absent rather than fabricated.

## Compatibility and migration

- Existing action UUIDs and keypad profiles are unchanged.
- New per-dial settings start at version 1.
- Missing settings load the Reasoning preset as the safe single-action default when a user first drops Codex Dial.
- Optional relay fields allow mixed versions to continue operating.
- The same plugin code and manifest continue to support Windows 10+ and macOS 13+.
- No launcher, watcher, pairing, or trust-boundary change is required.
- Internal Codex renderer compatibility remains explicitly best effort and documented.

## Testing strategy

### Unit tests

- Every preset expands to the expected settings.
- Malformed and unknown settings normalize safely.
- Positive, negative, zero, and multi-tick rotation expand correctly.
- Per-detent commands are serialized in order.
- Selectors wrap, clamp, and handle empty lists.
- Agent selection skips empty slots and reconciles by stable identity.
- Configured action order is preserved and unknown IDs are removed.
- Press/down/up and touch one-shot lifecycles dispatch correctly.
- Usage mode and overview state transition correctly.
- Feedback models cover ready, unavailable, degraded, stale, and offline states.
- Optional reasoning effort survives local and relay normalization.
- Older snapshots without reasoning effort remain valid.

### Repository validation

Run the repository's required checks:

```text
npm ci
npm run check
npm test
npm run validate
npm run audit:release
```

### Physical macOS verification

On the user's Stream Deck +:

- Back up the installed plugin and affected profile before replacement.
- Install the locally built plugin.
- Place four Codex Dial instances on the Status-focused page.
- Verify each knob's counter-clockwise/clockwise rotation.
- Verify dial down/up behavior and unassigned press behavior.
- Verify each touch region independently.
- Verify selector preview does not execute until press.
- Verify fast turns preserve tick count and order.
- Verify touch feedback updates after Codex-side state changes.
- Verify unavailable/disconnected rendering and reconnection.
- Verify the existing eight keypad actions still work.
- Verify settings persist across Stream Deck and Codex restarts.

The pull request will state the exact Codex, Stream Deck, macOS, and hardware versions used. Windows CI/build validation will be reported separately from physical-device coverage.

## Delivery and Git strategy

Work proceeds on `feature/stream-deck-plus-dials` from current upstream `main`. Commits are made between reviewable slices:

1. Dial domain core and tests
2. Encoder integration, property inspector, layout, and tests
3. Live reasoning feedback and relay compatibility tests
4. Documentation and verification notes

Subagents may implement isolated slices after the implementation plan assigns non-overlapping ownership. Separate subagents review functional correctness and run QA against the acceptance criteria. Review fixes receive their own focused commit or amend only the unshared current slice.

After automated and physical verification:

- Perform a final diff and repository-state review.
- Merge the feature branch into local `main` using a normal non-destructive merge.
- Re-run the relevant verification from `main`.
- Fork the upstream repository under the user's GitHub account if needed.
- Push the feature branch and prepare an upstream pull request with exact evidence.

Personal profile manifests, local paths, logs, bridge metadata, credentials, generated release bundles, and brainstorming artifacts are never committed.

## Acceptance criteria

- A user can place one Codex Dial action independently on each Stream Deck + knob.
- Each instance can choose a preset and independently configure rotation, press, touch tap, and feedback.
- Paired rotation executes exactly once per detent without confirmation.
- Selector rotation previews without execution; press activates the highlighted item.
- Status-focused defaults match the approved four-knob table.
- Touch feedback shows live, honest state and never invents a reasoning value.
- Existing keypad actions and profiles continue to work.
- Windows/macOS and optional relay routing rules remain intact.
- All required repository checks pass.
- Physical Stream Deck + behavior is verified on macOS and documented accurately.
- Repository history is clean, reviewable, and ready for an upstream pull request.
