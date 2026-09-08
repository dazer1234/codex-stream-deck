# Architecture and security

## Components

### Launcher

`Start-CodexDeck.ps1` finds the installed Microsoft Store Codex package. If a healthy debug-enabled Codex process already exists, it reuses its loopback port. Starting an already-running normal session requires an explicit launcher/recovery path; a read-only `-DryRun` never changes it. The launcher chooses an unused loopback port, writes it to `%LOCALAPPDATA%\CodexDeck\codex-micro-bridge.json`, and starts `ChatGPT.exe` with:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=<random-port>
```

The bundled runtime helper connects to that renderer and enables the Micro feature state for the current session. It discovers the versioned `persisted-signal-*` asset dynamically; no asset hash is hardcoded.

The launcher does not edit the Codex installation, Codex LevelDB, task database, rollout files, or logs.

When startup monitoring is installed, a durable copy under `%LOCALAPPDATA%\CodexDeck\launcher` runs `Watch-CodexDeck.ps1` as
a single hidden PowerShell process. It dynamically resolves the newest Codex
Microsoft Store package on every check, so an app update can change the install
path without invalidating the watcher. A named mutex prevents duplicates.

The watcher follows three safety rules:

1. A healthy debug-enabled Codex session is reused and never restarted.
2. A normal session that was already open when monitoring was installed is left untouched until its next normal restart.
3. A later Codex launch, update restart, or crash recovery without the required loopback port receives at most one recovery restart for that process generation.

Stale port metadata is removed automatically. The bounded watcher log lives at
`%LOCALAPPDATA%\CodexDeck\watcher.log`.

On macOS, the launcher discovers the running or installed app by its signed
bundle metadata, reads `CFBundleExecutable`, and launches the app bundle through
LaunchServices with the same loopback-only debugging arguments. The per-user
LaunchAgent watcher stores a main-process generation (PID, start time, and
executable path), reuses healthy bridges, and performs at most one graceful
recovery restart for a later stable unbridged generation. It never launches a
closed Codex app. A generation-independent cooldown prevents a failed recovery
from becoming a PID-to-PID restart loop, even if LaunchServices immediately
creates another process. The generation and recovery policy is persisted
atomically and guarded by a PID-directory lock. LaunchAgent stderr is retained
separately from the bounded watcher log for post-crash diagnosis.

Both platforms persist a stable `hostId`, `hostName`, and platform identifier.
The relay uses that identity; the CDP port is never a relay endpoint.

### Stream Deck plugin

The same plugin runs on Windows and macOS. It discovers the local loopback port from the platform state file or from a running Codex process. It then uses Chrome DevTools Protocol `Runtime.evaluate` calls to:

1. discover the current version-hashed Codex renderer modules;
2. announce a connected Micro device state;
3. read the native six-slot state, layout, agent source, and lighting preference;
4. dispatch Micro HID and joystick events;
5. emulate native encoder-rotation HID events for reasoning-effort changes;
6. resolve standalone keycap actions from Codex's live Micro keycap registry and current official command runner;
7. read Codex's renderer-owned `rate-limit-status` query and normalize its current 5-hour, weekly, and reset-credit state;
8. best-effort read the active visible composer's optional reasoning effort for honest Encoder feedback.

The bridge does not emulate a USB HID device and installs no driver.

Usage data remains part of the same typed host snapshot, but usage and reset credits are account-scoped and therefore do not follow the Mac/Windows function-key target. The controller prefers a healthy local account snapshot and falls back to the paired host only when local usage is unavailable. Window identity is derived from the duration returned by Codex rather than from primary/secondary ordering. A missing 5-hour window is represented as unavailable, and Automatic mode falls back to weekly. The bridge refreshes a stale renderer-owned usage query at most once every 15 seconds, so background-window values do not depend on Codex receiving focus.

Reset consumption is the only mutating usage operation. It is a narrow typed relay command and calls Codex's current native reset-credit client only after the Stream Deck key has been held for 1.2 seconds. The bridge verifies both availability and applicability, selects an available plan-supported credit, uses a unique redemption request ID, and then refreshes the renderer query. No credential, raw endpoint access, or arbitrary request surface is exposed to the relay.

`Codex Dial` is one Encoder-only Stream Deck action with versioned, per-instance settings. Its pure dial domain normalizes preset and custom settings against allow-listed bindings, expands each paired-rotation detent into an ordered command, reconciles selector identity, and derives the five stable feedback fields. The action adapter forwards Encoder rotate, down, up, and touch events to the controller; it does not add a second command surface. Rotation can dispatch paired controls immediately or update a selector preview, while press and touch remain independent.

An explicit usage refresh is a typed operation. Locally, one renderer evaluation requests a fresh `rate-limit-status` query and rejects rather than replacing last-known usage when the forced refresh cannot return valid data. Remotely, the relay advertises `usage-refresh`, binds capability and snapshot state to the current authenticated connection generation, publishes a fresh post-command snapshot, and only then acknowledges success. Older peers may omit the optional capability and reasoning field.

### Optional multi-host relay

The Mac watcher can host an authenticated WebSocket relay on loopback behind an
SSH tunnel or on one explicitly configured Tailscale address. Wildcard listeners are rejected. The Windows
Stream Deck plugin connects as a client, merges typed Mac and Windows snapshots,
and routes agent presses by stable `(hostId, threadKey)` identity. Other controls
target the host selected by the Windows/Mac toggle.

Host ownership is resolved from exact local rollout filenames, not from a
renderer's mirrored recent list. This distinguishes a task's owning desktop
from a stale cloud or remote-SSH mirror. A bounded rollout tail is searched only
for structural activity/completion event tags and the latest numeric
`token_count` record. The latter provides optional context-window percentage
metadata for the small agent-key ring. Prompts, responses, project names, and
other content are neither parsed nor relayed. The relay never reads or proxies
the remote CLI app-server stream.

The relay protocol has no arbitrary-evaluation, filesystem, shell, or raw-CDP
operation. Payloads are capped at 64 KiB, authentication is required before a
snapshot or command is accepted, and command results use request IDs with
bounded timeouts.

### Optional iPhone transports

The iPhone consumes the same authenticated protocol through two independent
transport profiles. Remote mode keeps the relay on loopback and uses private
Tailscale Serve TLS. Nearby mode binds only the typed relay to one discovered
RFC 1918 address; Chrome DevTools remains on `127.0.0.1`. Nearby creates a
per-host P-256 certificate and random token, pins the certificate fingerprint
in the iPhone profile, and stores the token in Keychain.

Bonjour `_codexdeck._tcp` announces protocol version, stable `hostId`, display
name, platform, private address, relay port, and certificate fingerprint. It
never announces the token. The QR deep link carries the initial private
endpoint, token, and fingerprint. Later Bonjour address changes are accepted
only for the already-paired `hostId` with the same pinned fingerprint. Config
and QR files are written atomically with user-only permissions and are excluded
by the release-state audit.

The nearby and Tailscale listeners are separate, so enabling local discovery
does not replace or weaken remote access. No public relay is bundled: a
reliable internet alternative would require operated identity, TURN/push, rate
limiting, and abuse controls rather than exposing a desktop listener.

An authenticated client may remain connected while the Mac app or its native
Micro signals are unavailable. Snapshot failures are caught and rate-limited;
they do not terminate the relay server or watcher. Normal snapshots resume
automatically when the local bridge becomes ready.

The relay emits an authenticated, typed `degraded` health event when its native
snapshot source fails. The client also treats a snapshot as stale from its own
receipt time, so clock differences between computers cannot hide a failure.
Transport loss is a separate `offline` state. The controller preserves the
last-known host snapshot to keep the six-key layout stable, overlays the health
state on affected agent tiles, and uses the Windows/Mac target key as the
host-wide health surface. Preserved data is display-only: command dispatch still
requires a live authenticated connection.

### Rendering

Agent keys are original deterministic SVGs generated in memory from task title and state. The status palette is:

| Native state | Display |
|---|---|
| `off` | dark / unassigned |
| `idle` | white |
| `working` | saturated blue animation |
| `unread` | green completion |
| `approval` | orange pause/input |
| `error` | red error |

When Codex exposes token usage for a task, an optional top-left ring shows the
latest context-window percentage. Orange begins at 80% and red at 92%. Select
any Agent key in Stream Deck's property inspector to show or hide this ring
globally for all six agent keys on that computer. The setting is independent on
Windows and macOS and does not stop context metadata from syncing.

The renderer derives the active Codex appearance from explicit theme tokens when available and falls back to the computed renderer surface luminance. Dark mode uses layered charcoal surfaces rather than pure black, with off-white text and slightly lifted status colors for the Stream Deck display.

Official Codex Micro keycap SVG contents are not part of the source or release. Optional user-local files are loaded from `%LOCALAPPDATA%\CodexDeck\icons` on Windows or `~/Library/Application Support/CodexDeck/icons` on macOS and wrapped in the project's neutral key surface at runtime.

The controller uses non-overlapping self-scheduled refreshes and caches the last
image sent to each action instance. Unchanged keys therefore produce no repeated
USB image writes. Animated frames are limited to working and approval states.

Encoder feedback uses a custom 200 x 100 layout with keyed title, value, detail,
indicator, and accent fields. The controller keeps selector and overview state,
an async command queue, and the last normalized feedback signature per visible
dial action. `setFeedback` is skipped when that signature is unchanged. Dial
registration, settings replacement, disappearance, and in-flight render work
are generation-aware so an obsolete action instance cannot overwrite its
replacement. See the [Stream Deck + guide](STREAM_DECK_PLUS.md) for the user-facing behavior.

## Trust boundary

CDP provides privileged access to the Codex renderer. Binding to `127.0.0.1` prevents direct access from another machine, but not from another process running as the same local user. Treat the launcher-started session like any other local debugging session:

- do not run untrusted software at the same time;
- do not change the debug address to `0.0.0.0`;
- do not forward the port;
- close Codex when the bridge is no longer needed.

## Data flow

In single-host mode Codex Deck has no server, API key, analytics endpoint, or
update service. Runtime data stays between Stream Deck, the local plugin
process, and the local Codex renderer. Optional multi-host mode adds one
user-configured Mac listener reachable through SSH or inside the encrypted
tailnet; titles, task IDs, states, a bounded catalog of recent local task UUIDs
and modification times, ownership metadata, and typed commands pass between the
paired machines and nowhere else.

## Compatibility boundary

This is not a public Codex extension API. Export names, internal commands, or event shapes can change. The code avoids fixed bundle hashes where possible, but semantic changes still require a release update.
