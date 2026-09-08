# Normal macOS launches

When Codex opens without remote-debugging flags, Codex Deck can attach to the
existing, user-owned `CODEX_HOME/ipc/ipc.sock` instead. It never starts a router,
changes Codex configuration, rewrites the app, or restarts Codex.

This connection supports the six most recent local tasks and their live activity,
pending-input and unread status. Task buttons open the exact task through Codex's
`codex://threads/<UUID>` URL handler. Task catalog reads use macOS's bundled
SQLite executable in read-only mode and exclude archived tasks and subagents.

The IPC fallback does **not** expose active composer authority. Model presets,
reasoning, native action keys, joystick/encoder commands and account usage still
require the renderer bridge. They are not emulated by guessing from the last
model used by a task. The fallback supplies an unavailable native action layout
and omits active-model, active-task and usage fields. The existing renderer path
is preferred whenever it reconnects.

If a task has no live owner/snapshot, its status is unknown (warning indicator),
not falsely idle. Connection loss clears live state; reconnect subscribes again.
Snapshots and revision-checked patches are projected to status metadata; task
messages, turns and request contents are not retained or logged. Unsupported
versions, missed revisions and nested status changes require a fresh snapshot.
The fallback reads recent ordering rather than pinned/custom Micro assignments.

This uses Codex's internal IPC stream version 11 and following version 1, not a
stable public API. Frames are bounded to 32 MiB; oversized/malformed input closes
the connection with a 30-second retry cooldown. A future protocol change can
require another compatibility update. Complete normal-launch parity for composer
and action controls still requires an additional supported desktop interface.

Verification covers fragmented framing, activity projection, live subscription,
revision gaps, reconnect cleanup, and connection-only renderer fallback. A live
read-only probe was also run against the existing Codex IPC socket without CDP.
