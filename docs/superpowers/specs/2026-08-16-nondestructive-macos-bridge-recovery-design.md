# Non-Destructive macOS Bridge Recovery Design

## Problem

Codex 26.810.52044 no longer exposes the Statsig client expected by the installed Micro runtime override. The watcher interprets the missing bridge as recoverable, sends `SIGTERM` to the running Codex process, and relaunches it. Repeated activation failure therefore causes repeated data-disrupting application restarts while Stream Deck remains `DEGRADED`.

## Safety Contract

- The background watcher never signals, terminates, or launches Codex.
- A missing or incompatible bridge is reported as degraded and retried in place.
- Closing Codex intentionally leaves it closed.
- Only an explicit user-invoked launcher command may perform a controlled restart to add the loopback debugging flags.
- Existing Stream Deck profiles, plugin settings, Codex sessions, and relay configuration remain untouched.

## Runtime Compatibility

The runtime override must treat Statsig as optional. When a current build has no Statsig client, it continues discovery of Codex's already-loaded native Micro event bus, dispatches the native connected-device event through that bus, and verifies the actual HID and joystick handlers. Older builds continue to receive the gate override when Statsig is available.

Readiness is based on the runtime behavior the plugin needs: a native event bus, a dispatched or persisted device signal, and registered HID/joystick handlers. Missing Statsig alone is not failure. Missing event-bus authority or handlers remains fail-closed and leaves the LCD degraded.

## Watcher Behavior

The watcher policy returns only preserve, reuse, or wait decisions. Once Codex is running without a healthy bridge, it records a stable degraded state and continues polling. The watcher implementation contains no recovery branch capable of calling `terminateCodex` or `launchCodex`.

The explicit `start` command retains controlled restart behavior because the user invoked it for that purpose. Installation and diagnostics clearly distinguish this from background recovery.

## Verification

Automated tests must prove:

- prior healthy bridge loss never produces a restart action;
- app-generation replacement never produces a restart action;
- prolonged stable bridge loss never produces a restart action;
- the watcher source has no automatic terminate/relaunch path;
- no-Statsig runtime activation continues through the native event bus;
- older Statsig-backed activation remains supported;
- missing event-bus handlers remains unavailable.

Live verification uses a single explicit controlled restart, then checks the bridge state file, loopback listener, plugin logs, `local=ready`, LCD recovery, and process stability. The LaunchAgent is re-enabled only after the installed watcher is proven non-destructive.
