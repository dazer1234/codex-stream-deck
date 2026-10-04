# Fast Mode Feedback and Reasoning Dial Correction

**Date:** 2026-08-09
**Status:** Approved design; implementation pending

## Problem

Two behaviors in the installed Stream Deck + integration do not match the live Codex composer:

1. Pressing the Fast Mode key changes Codex state but leaves the Stream Deck key on its static background, so the hardware does not show whether Fast Mode is enabled.
2. Rotating the Reasoning dial sends raw Codex Micro encoder events. In the current Codex desktop app those events move composer focus between controls, producing the blue focus ring shown in the reported screenshot instead of changing reasoning effort.

## Confirmed Current Codex Contracts

Live inspection of Codex desktop `26.803.41515` confirmed:

- the visible composer reasoning trigger is marked with both `data-codex-intelligence-trigger="true"` and `data-composer-navigation-target="reasoning"`;
- the current reasoning effort is reported by `data-selected-reasoning-effort`;
- Fast Mode is represented by the inline Fast indicator inside that visible trigger and by the renderer state `selectedServiceTier: "priority"` / `selectedServiceTierIconKind: "fast"`;
- the official `FAST` keycap invokes `composer.toggleFastMode`;
- the official `MIND+` and `MIND-` keycaps invoke `composer.increaseReasoningEffort` and `composer.decreaseReasoningEffort` respectively.

The bridge already has a guarded official-keycap command path. The reasoning correction will use that path instead of raw encoder navigation.

## User-Visible Behavior

### Fast Mode

- Every rendered Stream Deck key whose effective Codex keycap is `FAST` uses a state background:
  - green when Fast Mode is confirmed enabled;
  - red when Fast Mode is confirmed disabled;
  - the existing neutral theme when the live state cannot be verified.
- This applies to the existing page's Fast key and any separately configured official Fast key.
- The keycap glyph remains recognizable above the colored background.
- After a successful local Fast command, the controller requests a fresh snapshot rather than waiting for the normal polling interval. Remote commands use the relay's existing post-command snapshot publication.
- Failed commands do not optimistically flip the displayed state.

### Reasoning Dial

- Each clockwise detent invokes the official increase-reasoning command once.
- Each counter-clockwise detent invokes the official decrease-reasoning command once.
- Rotation does not send `ENC_CW` or `ENC_CC`, move composer focus, open the reasoning menu, or synthesize keyboard navigation.
- The existing reasoning feedback continues to display the effort reported by the active visible composer.
- The legacy encoder-click action remains unchanged; only reasoning adjustment uses the dedicated commands.

## Architecture and Data Flow

### Snapshot state

`MicroSnapshot` gains an optional `fastModeEnabled` boolean.

The renderer bridge reads the active visible reasoning trigger. When that verified trigger exists, presence of its inline Fast indicator yields `true` and absence yields `false`. If no verified visible trigger exists, the field is omitted rather than treating unknown as disabled.

Relay normalization accepts only an optional literal boolean. Malformed values are rejected at the existing snapshot trust boundary.

### Rendering

The keycap renderer gains an optional toggle-state treatment. Existing callers remain neutral by default. The controller supplies the Fast state only when the effective keycap ID is `FAST`.

The green and red backgrounds reuse the project's existing ready/error signal palette so they stay consistent with other Stream Deck status surfaces. Light and dark foreground contrast remain readable.

### Command refresh

After a successful local Fast press or official Fast keycap command, the controller refreshes the local snapshot and redraws registered actions. It does not refresh on the corresponding release event. Remote execution remains authoritative through the relay server's existing command barrier and freshly published snapshot.

### Reasoning commands

`CodexMicroRendererBridge.adjustReasoning(direction)` maps:

- `increase` to official keycap `MIND+`;
- `decrease` to official keycap `MIND-`.

It then uses the existing allow-listed keycap command runner. Controller and relay command types remain unchanged, so local and remote dials share the same corrected behavior without a protocol migration.

## Error Handling

- Missing or ambiguous composer Fast state renders neutral, never red.
- A Fast command failure keeps the last authoritative state and preserves the existing Stream Deck alert/log behavior.
- A failed forced refresh preserves the last known snapshot and reports degraded health through the existing bridge path.
- If the official reasoning keycap command is unavailable, the action fails visibly; it does not fall back to raw encoder navigation.

## Testing

Implementation will proceed test-first with regressions for:

1. visible active-composer Fast state reads as true and false, while hidden or absent controls remain unknown;
2. optional Fast state survives snapshot and relay validation, and malformed non-booleans fail closed;
3. Fast key rendering is green when enabled, red when disabled, and neutral when unknown;
4. both Micro-slot Fast and official-keycap Fast rendering use the same state;
5. successful local Fast activation forces a fresh snapshot, while release and failed commands do not fabricate a state change;
6. reasoning increase/decrease invoke `MIND+` / `MIND-` exactly once per detent and never emit raw encoder rotation events;
7. the full type-check, test, build, Stream Deck validation, and release audit remain green.

## Installation and Acceptance

After review and verification, the corrected bundle will replace the installed development plug-in using the existing recoverable backup process. Stream Deck will be relaunched and checked for:

- green/red Fast feedback matching the visible Codex composer;
- persisted Reasoning, Agents, Actions, and Usage dial settings;
- live bridge health;
- no changes to the eight existing keypad assignments or the other three dial presets.

The final tactile acceptance check is one Fast press and one reasoning detent in each direction on the physical Stream Deck +.

## Out of Scope

- Redesigning other keycap backgrounds.
- Optimistic toggle state.
- DOM-clicking the reasoning dropdown.
- Changing the legacy encoder-click action.
- Publishing or opening an upstream pull request.
