# Stream Deck + Codex Dial

`Codex Dial` is an Encoder-only action for Stream Deck +. Each knob stores its own preset, rotation, press, touch, and feedback settings, so changing one dial does not change the others. Existing Codex Deck keypad actions continue to work alongside it.

## Requirements and setup

- Codex Deck installed and connected to a bridge by following the [macOS](MACOS.md), [Windows](WINDOWS.md), or [multi-host](MULTI_HOST.md) guide.
- Stream Deck 6.6 or newer.
- A Stream Deck + for the four Encoder positions and touch strip.

In the Stream Deck app, open the Codex Deck category and drag **Codex Dial** onto a knob. Select the new dial to open its property inspector, then choose a preset. Repeat for each knob you want to configure. Presets are starting points; each action instance can then be customized independently.

## Status-focused four-knob defaults

The recommended layout uses four separate `Codex Dial` instances:

| Knob | Rotate | Press | Touch | Feedback |
|---|---|---|---|---|
| Reasoning | Reasoning decrease counter-clockwise; reasoning increase clockwise | None | Fast mode | Current reasoning effort |
| Agents | Select the previous or next occupied agent | Focus the highlighted agent | Tasks view | Agent title, status, and context use when available |
| Actions | Select Fast, Approve, Reject, Fork, Dictation, or Send in that order | Run the highlighted action | Codex Micro Settings | Selected action and activation hint |
| Usage | Select Automatic, 5-hour, or Weekly | Toggle the selected single-window view and two-window overview | Refresh usage now | Remaining capacity, reset time, health, and view mode |

Reasoning changes apply once per detent. They do not require a press or confirmation.

## Gesture behavior

### Paired controls

In **Paired controls** mode, counter-clockwise and clockwise rotation have separate bindings. Every detent runs its binding in order. This mode is useful for reasoning decrease/increase and navigation back/forward. Reaching a supported boundary is a harmless no-op.

### Rotate to select

In **Rotate to select** mode, rotation only highlights an item; it does not run it. Press **Activate Selection** to run the highlighted agent or configured action. The selector can wrap at either end, and an Actions selector preserves the order chosen in the property inspector. The Usage selector cycles Automatic, 5-hour, and Weekly.

An empty selector cannot be activated. It may be shown as `NO ITEMS`, or as `UNAVAILABLE` with a more specific detail such as no active agents or no configured actions, depending on the feedback mode.

### Press and touch

**Press** and **Touch tap** are independent. Press preserves the selected command's lifecycle: Micro and joystick controls send their down/up pair, while reasoning, keycap, new-task, host, and usage commands run once. A touch tap dispatches one complete action lifecycle and can also be set to **None**.

Holding the dial while rotating does not reveal a second binding layer. A held touch event is ignored.

## Property inspector reference

| Field | Purpose |
|---|---|
| Preset | Choose Reasoning, Agents, Actions, Navigation, Usage, or Custom defaults. Choosing a preset replaces all fields for that dial. |
| Rotation mode | Choose Paired controls or Rotate to select. |
| Counter-clockwise / Clockwise | Choose the two bindings used by paired rotation. |
| Selector source | Choose occupied agents, configured actions, or usage windows. |
| Wrap at ends | Allow the selector to continue from the last item to the first and vice versa. |
| Configured actions | Enable and reorder the allow-listed actions available to an Actions selector. |
| Press | Choose an independent dial-down/dial-up action or Activate Selection. |
| Touch tap | Choose an independent tap action. |
| Feedback | Choose Automatic, Current reasoning, Selected agent, Selected action, Navigation pair, Usage window / overview, or Static label. |
| Static label | Set the text used by Static label feedback. |

Changing an individual field marks only that dial as customized. Settings contain allow-listed action identifiers rather than arbitrary commands, URLs, or scripts.

### Rate-limit reset protection

**Reset rate-limit credit (hold)** is available only for Press. It is intentionally absent from rotation, touch, and selector item choices. A reset requires a deliberate 1.2-second hold and Codex must report that a credit is both available and applicable. A short press does nothing. Successful use shows the standard success indicator.

## Feedback and routing

Current reasoning is read from Codex's live composer state, not inferred from the last turn of the knob. If that value is not confidently available in the current Codex build, the dial honestly shows `REASONING · UNAVAILABLE`.

In single-host mode, controls and feedback use the local Codex instance. In multi-host mode:

- Agent selection and focus stay bound to the highlighted task's owning host and stable task identity.
- Reasoning, navigation, Micro, keycap, new-task, and host controls use the selected function-control host.
- Usage is account-scoped. It prefers a healthy local usage snapshot and falls back to the paired host only when local usage is unavailable.
- A command is not sent through stale display-only data; its captured host must still be live and applicable.

Feedback may retain last-known information while a host is degraded or offline, but this does not make stale controls executable.

## macOS physical verification checklist

After installing a development build on macOS, back up the installed plugin and the affected Stream Deck + profile before replacing anything. Then verify:

- all four Status-focused presets can be added without changing existing keypad actions;
- each counter-clockwise and clockwise detent is preserved, including a fast turn;
- selector rotation previews without running anything until press;
- press down/up and each touch region act independently;
- reasoning and usage feedback follows changes made inside Codex;
- disconnected, reconnecting, and degraded feedback is honest;
- settings persist after restarting Stream Deck and Codex.

Record the exact macOS, Codex, Stream Deck, and hardware versions when this checklist is completed. This checklist describes the required physical QA; its presence is not a claim that a particular development build has already completed it.

## Windows compatibility boundary

The plugin source, manifest, property inspector, and packaged Encoder assets use the same cross-platform Stream Deck SDK path on Windows and macOS. Windows build and CI coverage is not physical-device verification. Do not report Stream Deck + hardware coverage on Windows until the same behavior checklist has been performed on a real device and the exact environment has been recorded.

## Troubleshooting

### `NO ITEMS` or `UNAVAILABLE`

For Agents, open Codex and make sure the selected Codex Micro source has at least one occupied task. For Actions, select at least one configured action in the property inspector. For Usage or Reasoning, confirm that the current Codex build exposes the corresponding live state.

### `CONNECTING`

The plugin is waiting for a fresh bridge or relay snapshot. Confirm that Codex is open through the platform launcher and let the guarded watcher reconnect. Avoid repeatedly restarting Codex.

### `DEGRADED`

The last snapshot is retained for display, but live state is uncertain or stale. Check the platform launcher diagnostics and, in multi-host mode, the authenticated relay connection. Commands remain blocked when the captured route is not healthy.

### `OFFLINE`

No live route is available for the selected host. Start or repair the local bridge, or restore the paired relay connection. The debug endpoint must remain loopback-only; do not expose or forward it.

### Stale feedback

Make a small Codex-side state change and wait for the normal refresh. Usage can be refreshed immediately with the configured touch action. If feedback remains stale, reload only the Codex Deck plugin or Stream Deck app, then run the platform's read-only diagnostics. Recheck the dial's Feedback field if it intentionally uses a fixed mode or Static label.
