# Changelog

## Unreleased

- Added a per-knob Stream Deck + Model Presets dial that immediately and continuously wraps through configurable model/reasoning pairs using Codex's native paired selection path.
- Added live model and reasoning dropdowns with add, remove, drag, accessible reorder controls, preserved unavailable entries, and an opt-in Ultra policy.
- Added `SWITCHING…` as non-optimistic pre-confirmation feedback, plus active-position and `UNLISTED` feedback derived only from confirmed state, along with empty, unavailable, and health feedback without keyboard or focus navigation.
- Added capability-gated Model Presets support for authenticated Mac/Windows relays; older peers fail closed without partial switching.
- Fixed standalone command keycaps such as Terminal after current Codex builds moved their guarded runner behind the live Micro bridge import.

## 0.7.0.2 - 2026-07-22

- Normalize remote snapshot timestamps to local receipt time so ordinary Mac/Windows clock differences cannot hide working, selected, approval, or usage state.
- Reset a stale opposite-platform control target when the plugin starts without a configured second host, while preserving intentional remote targeting during temporary relay outages.
- Keep unique last-known tasks visible when one iPhone node is offline, clearly mark them offline in the app and widgets, and prevent offline agent keys from dispatching commands.
- Prefer the live connection when duplicate iPhone profiles authenticate as the same computer, including command delivery and displayed connection health.
- Added regression coverage for Mac-only, Windows-only, mixed online/offline, duplicate-profile, and cross-host clock-skew behavior.

## 0.7.0.1 - 2026-07-22

- Fixed one cross-host Codex task appearing twice when a new Windows or Mac thread transitioned from its temporary renderer ID to its stable rollout ID.
- Remember resolved temporary thread aliases across later task selections and relay reconnects so mirrored tasks remain de-duplicated.
- Preserve the available title and context usage from either host when the rollout owner temporarily publishes incomplete renderer metadata.
- Reserve `Not assigned` for genuinely empty agent slots; assigned titleless threads now use `New chat` while their native title is pending.
- Keep a neutral context ring visible until a new thread publishes its first token-count event.
- Added bidirectional Windows-to-Mac and Mac-to-Windows regression coverage for task identity, title fallback, selection changes, and reconnects.

## 0.7.0 - 2026-07-21

- Added a source-distributed native SwiftUI iPhone companion that merges authenticated Mac and Windows snapshots while leaving the Stream Deck plugin independent.
- Added pinned-TLS Nearby Wi-Fi pairing and private Tailscale HTTPS profiles without exposing Chrome DevTools or accepting wildcard/public relay listeners.
- Added native task details, command receipts, Attention Center, optional notifications, one-task Live Activity follow mode, five WidgetKit experiences, and app-local key layouts.
- Added circular 5-hour/weekly usage, a two-window overview, optional context rings, and a centered reset-credit action with a deliberate 1.2-second hold.
- Added portable local iOS signing configuration; personal team, bundle, App Group, relay tokens, and official OpenAI keycap artwork remain outside public artifacts.
- Fixed empty iPhone agent keys drawing two misaligned plus symbols.
- Fixed the iPhone dashboard in landscape with a bounded two-column layout instead of stretching the square Micro device across the full screen width.
- Fixed completed, selected, and mirrored tasks retaining stale working/unread colors across Mac and Windows while preserving fresh approval and active-work signals.
- Fixed long-running iPhone relays retaining stale Codex version metadata after an app update; host identity remains stable and no Codex restart is required.
- Updated renderer discovery and active-task detection for Codex macOS `26.715.70719` and Windows `26.715.8383.0` without hardcoding renderer hashes.
- Added physical-iPhone Swift tests, macOS launcher/watcher self-tests, release privacy audits, and expanded relay, renderer, usage, and project regression coverage.
- Added beginner installation, same-Wi-Fi verification, and release documentation plus explicit inspiration credit for the mobile companion concept.

## 0.6.3 - 2026-07-19

- Fix completed tasks remaining stuck in the green finished state after they are opened.
- Track each structural `task_complete` revision instead of comparing rollout modification times, so harmless file touches cannot resurrect an acknowledged completion.
- Detect the task currently open in each Codex renderer even when it is outside that host's six native Micro slots.
- Propagate the content-free active-task and completion-revision signals through the authenticated multi-host relay, allowing a mirrored task opened on either computer to clear correctly.
- Preserve the visible completion transition for a task that was already open while it ran; only a later activation or Stream Deck press acknowledges it.
- Prevent delayed completion metadata from overriding a newer native working/thinking state.

## 0.6.2 - 2026-07-19

- Added explicit per-host `READY`, `DEGRADED`, `CONNECT`, and `OFFLINE` state to the Windows/Mac target key.
- Native-signal failures now emit a typed relay health event instead of leaving an authenticated connection looking healthy.
- Detect stale remote snapshots from local receipt time, independent of clock differences between hosts.
- Preserve last-known task placement during host failures while marking every affected agent tile orange for uncertain native signals or red for an offline relay; commands still fail safely instead of falling through to another host.
- Restored relay smoke-test compatibility after health-only updates were separated from snapshot delivery.
- Route reasoning up/down through Codex's native encoder-rotation HID events, matching the current Micro implementation after a Codex desktop update removed the old command-runner asset.
- Resolve standalone keycap commands from the currently loaded official Micro bridge while retaining compatibility with older Codex builds.

## 0.6.1 - 2026-07-18

- Fixed a macOS restart loop after an unexpected shutdown when an authenticated Windows relay requested a snapshot before the Codex Micro signals were ready.
- The macOS watcher no longer launches Codex while the app is closed, waits for an unbridged process to stabilize, and uses a generation-independent recovery cooldown to prevent PID-to-PID restart loops.
- Added safe relay error handling, rate-limited offline diagnostics, and a dedicated macOS watcher stderr log.
- Fixed macOS Codex updates exposing avatar-overlay renderer targets before the real main window, which could stop relay snapshots and leave an agent key stuck in `working`.
- Fixed remote agent commands for nested `local:client-new-thread:` task identities being rejected by the relay validator.
- Read the live agent-source setting directly from Codex instead of falling back to Recently updated after app updates.
- Added mode-aware combined agent slots for pinned, recent, priority, and individual Codex Micro assignments while preserving native single-host behavior.
- Interleaved pinned Windows and Mac tasks fairly, de-duplicated mirrored task identities, and routed each key to its real owner.
- Defined individual-assignment conflicts: the Stream Deck computer wins a doubly assigned slot, while the other host fills empty slots; duplicate tasks appear only once.
- Normalized additional native `thinking`, `complete`, `completed`, and `done` status names for stable animations and colors.
- Added diagnostics when the two Codex apps use different agent-source modes.
- Fixed explicit release-audit paths and added regression coverage for private runtime-state rejection.
- Kept CDP evaluation promises alive in the renderer to prevent intermittent `Promise was collected` failures on remote agent presses.
- Added a content-free local session-presence catalog so cloud/SSH mirrors are attributed to the computer that owns the rollout even when Codex omits that task from the owner's six native Micro slots.
- Keeps freshly completed owner sessions visible at unread/error priority instead of dropping them behind idle tasks.
- Bounds and validates relay presence catalogs and clears a derived completion state after that task is opened from the deck.

## 0.6.0 - 2026-07-18

- Added the local macOS Codex Micro launcher and persistent LaunchAgent watcher.
- Added an opt-in authenticated SSH/Tailscale relay for mixed Windows/macOS agent slots and native command routing.
- Added a Windows/Mac target action while keeping agent keys bound to each task's originating host.
- Added host badges and stable `(hostId, threadKey)` routing for the six global agent keys.
- Replaced the one-shot Windows-login launcher with a persistent, single-instance bridge watcher.
- Automatically recovers the bridge after Codex updates, crashes, and normal restarts.
- Detects rapid Codex restarts by main-process generation even when no stopped interval is observed.
- Avoids touching a normal Codex session that was already open when the watcher is first installed.
- Removes stale bridge-port files and records bounded diagnostics in `%LOCALAPPDATA%\CodexDeck\watcher.log`.
- Added independent Windows-only and macOS-only operation from the same Stream Deck plugin package.
- Added host-generic task ownership and global recent-activity ordering for mixed Mac/Windows agent keys.
- Restricted relay listeners and clients to loopback or explicit Tailscale addresses and added hidden token entry on Windows.
- Installed the Windows watcher into a durable per-user location instead of depending on the extracted ZIP folder.
- Added separated release archives, checksums, and an automated audit for private state, personal setup markers, and protected keycap SVGs.

## 0.5.0 - 2026-07-17

- The launcher reuses a healthy existing loopback debug session instead of restarting Codex on every run.
- Added `-ForceRestart` for an explicit clean restart path.
- The source launcher can use the built release helper during local development.
- Added standalone native actions for every official single-size Codex Micro keycap; the microphone remains a true press/release action.
- Added live keycap-registry resolution so command mappings follow the installed Codex build instead of being duplicated in the plugin.
- Added readable themed fallbacks when a user-local SVG is unavailable.
- Prevented overlapping bridge polls, redundant Stream Deck image writes, and idle selected-agent animation traffic.
- Multiple copies of the same action now render correctly across pages and profiles.
- Added compatibility with the Codex `26.715.2305.0` renderer event bus and settings exports.
- Kept approval requests and user questions orange for the current `awaiting-approval` and `awaiting-response` Micro states.

## 0.4.1 - 2026-07-17

Initial public release.

- Native six-slot Codex Micro agent synchronization.
- Animated status tiles for idle, working, unread, approval, error, and empty states.
- Native Micro action, joystick, and encoder event dispatch.
- Direct reasoning-effort increase/decrease actions.
- Loopback-only Codex launcher with runtime module discovery.
- Optional local keycap SVG loading; third-party SVG contents are not distributed.
- Removed development database/log fallbacks and legacy hotkey behavior from the public runtime.
