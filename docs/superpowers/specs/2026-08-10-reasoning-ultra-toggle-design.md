# Reasoning Dial Ultra Toggle Design

**Date:** 2026-08-10
**Status:** Approved concept; awaiting written-spec review

## Problem

Codex shows a safety dialog titled `Use Ultra with Full access?` when reasoning crosses into Ultra while Full access is active. The Reasoning dial currently invokes Codex's dedicated increase command for every clockwise detent, so reaching the top of the range can open that dialog even when the user does not want Ultra available from the hardware control.

This dialog is owned by Codex and protects a meaningful permission boundary. Codex Deck must neither accept nor dismiss it automatically.

## Goals

- Add a per-dial `Include Ultra` checkbox.
- Default the checkbox to off for new Reasoning presets and settings that predate the field.
- When off, prevent that dial from crossing into Ultra while preserving all lower reasoning levels.
- When on, preserve current behavior, including Codex's own confirmation dialog.
- Leave manual reasoning selection inside Codex unchanged.
- Apply the same policy to local and authenticated relay-controlled Codex hosts.
- Keep standalone Reasoning Up keypad actions unchanged; this is a dial setting.

## Non-goals

- Do not change Codex's hidden global `enabled-reasoning-efforts` or `model_picker_persists_ultra_effort` settings.
- Do not automate, dismiss, or bypass the Full-access safety dialog.
- Do not change Full access or any other Codex permission mode.
- Do not infer that Ultra is active merely because the last dial command requested an increase.

## Considered approaches

### 1. Per-dial runtime guard — selected

Persist an `includeUltraReasoning` boolean with each Codex Dial. Before an increase command runs, the target renderer determines the live current effort and the ordered efforts supported by the active model. If the next effort is Ultra and the setting is false, the bridge returns a blocked result without issuing the command.

This is isolated to the hardware control, works with independent knob settings, and preserves Codex's own safety behavior when Ultra is explicitly enabled.

### 2. Change Codex's hidden global effort settings — rejected

The current Codex bundle contains hidden settings that can remove Ultra from model controls. Using them would alter the Codex UI globally, rely on undocumented account-setting APIs, and couple the plugin to a private migration path. It would also prevent intentional manual Ultra selection.

### 3. Enter Ultra and dismiss or confirm the dialog — rejected

This would trigger the unwanted UI before reacting and could bypass a permission warning. It is unsafe and does not meet the goal.

## Settings and property inspector

`CodexDialSettings` gains a required boolean field:

```ts
includeUltraReasoning: boolean
```

Normalization rules:

- A literal boolean is preserved.
- A missing, malformed, or legacy value normalizes to `false`.
- Every preset emits the field so property-inspector and runtime normalization remain identical.
- The Reasoning preset defaults it to `false`.
- Selecting a preset replaces the field with that preset's default, consistent with existing preset behavior.

The property inspector shows `Include Ultra` in the reasoning controls. It is enabled when the dial has a reasoning-increase binding and remains persisted when other fields change. Its help text states: `When off, clockwise reasoning stops below Ultra. Manual Codex selection is unchanged.`

## Command flow

Reasoning dispatch carries an explicit policy:

```ts
{ direction: "increase" | "decrease", includeUltra: boolean }
```

For a dial gesture, the controller passes the dial's normalized setting. For existing non-dial callers, the bridge keeps the current unrestricted behavior unless the caller explicitly supplies the restriction.

The target renderer performs the guard and command in one evaluation:

1. Read the live selected model and reasoning effort from the verified composer/model state.
2. Read the active model's ordered supported reasoning efforts from the current model metadata.
3. Determine the next enabled effort.
4. If increasing would enter `ultra` while `includeUltra` is false, return `blocked-ultra` without invoking `composer.increaseReasoningEffort`.
5. Otherwise invoke exactly one allow-listed dedicated reasoning command.

Decrease is never blocked, including when the current value is already Ultra.

If the renderer cannot confidently identify the current effort or ordered supported list, a restricted increase fails closed rather than risk opening the dialog. Existing honest unavailable/degraded feedback remains in effect. No hidden Codex setting is mutated.

For remote control, the authenticated relay protocol carries `includeUltra`. The remote bridge, rather than the controller-side cached snapshot, enforces the boundary against its live renderer state. Older or malformed relay messages fail closed under the existing typed command parser.

## Dial feedback

When an increase is blocked, Codex remains unchanged and no alert or modal is opened. The Reasoning dial briefly reports `ULTRA OFF`, then returns to authoritative live reasoning feedback. The value is never advanced optimistically.

## Compatibility and migration

- Existing saved dial settings without the new field normalize to `false`.
- The installed Reasoning knob will be updated to store `includeUltraReasoning: false` explicitly after the verified plugin is installed.
- Other knob gestures, keypad Reasoning Up/Down actions, Fast feedback, and encoder clicks are unchanged.
- The direct reasoning runner remains allow-listed to only the increase and decrease commands and must not be generalized to protected keycaps.

## Verification

Automated coverage must prove:

- Runtime and property-inspector normalization agree for true, false, missing, and malformed values.
- The Reasoning preset and legacy settings default to false.
- A restricted increase below the ceiling issues exactly one increase command.
- A restricted increase whose next value is Ultra issues no command and returns `blocked-ultra`.
- An unrestricted increase can enter Ultra and still leaves Codex responsible for its confirmation.
- Decrease works from Ultra regardless of the checkbox.
- Missing live effort/model metadata fails closed only for restricted increases.
- Local and relay command paths carry and enforce the same policy.
- Non-dial reasoning actions retain current behavior.
- No implementation calls Codex's Ultra account-setting API or interacts with the confirmation dialog.
- Full type-check, test, Stream Deck validation, release audit, and branch diff checks pass.

Physical QA on Stream Deck + must confirm that an unchecked Reasoning knob stops below Ultra without opening a Codex dialog, while checking the option restores Ultra and Codex's native confirmation.
