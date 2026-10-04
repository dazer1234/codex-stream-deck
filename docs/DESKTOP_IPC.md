# Normal macOS launches

When Codex opens without remote-debugging flags, Codex Deck can attach to the
existing, user-owned `CODEX_HOME/ipc/ipc.sock` instead. It never starts a router,
changes Codex configuration, rewrites the app, or restarts Codex.

This connection supports the six most recent local tasks and their live activity,
pending-input and unread status. Task buttons open the exact task through Codex's
`codex://threads/<UUID>` URL handler. Task catalog reads use macOS's bundled
SQLite executable in read-only mode and exclude archived tasks and subagents.
After one validated read, a temporary SQLite-open failure retains that in-memory
catalog while live IPC status continues; the next valid read replaces it. Invalid
catalog data still fails closed instead of being hidden by the cache.

Account usage is read separately through the bundled Codex CLI's short-lived
`app-server --stdio` helper. It sends only initialization and
`account/rateLimits/read`, uses the account's `codex` bucket (never substitutes
Spark), and caches/throttles automatic reads for 30 seconds. Background reads do
not delay task updates. Manual Usage refresh requests a fresh read. Missing
windows remain unavailable; the plugin does not manufacture a five-hour window
when the account reports only weekly usage. Reset-credit counts can be displayed,
but spending credits remains unavailable without the native applicability check.

The helper has bounded output and a ten-second timeout; only its own child process
is terminated after the read. Account errors clear usage without degrading a
connected task bridge. No desktop restart, alternate launcher, credential entry,
or Codex settings change is required. Current macOS builds place the bundled
executable at `/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
Codex Deck retains `/Applications/Codex.app/Contents/Resources/codex` as a
compatibility fallback for older builds.

The IPC fallback does **not** expose active composer authority. Model presets,
reasoning, native action keys and joystick/encoder commands still
require the renderer bridge. They are not emulated by guessing from the last
model used by a task. The fallback supplies an unavailable native action layout
and omits active-model and active-task fields. The existing renderer path
is preferred whenever it reconnects.

If a task has no live owner/snapshot, its status is unknown (warning indicator),
not falsely idle. Connection loss clears live state; reconnect subscribes again.
Snapshots and revision-checked patches are projected to status metadata; task
messages, turns and request contents are not retained or logged. Unsupported
versions, missed revisions and nested status changes require a fresh snapshot.
The fallback reads recent ordering rather than pinned/custom Micro assignments.

This uses Codex's internal IPC stream version 11 and following version 1, not a
stable public API. Incoming frames are parsed incrementally with socket
backpressure: complete task history is never buffered or assembled into objects.
Only bounded status metadata is retained, including when a snapshot is larger
than the previous 32/64 MiB limits. The wire protocol's 32-bit frame length does
not determine an allocation. Each frame has a 30-second processing deadline;
router responses allow ten seconds for large snapshots ahead of them. Outgoing
frames remain bounded to 32 MiB. Invalid JSON, metadata-limit violations, or frame
timeouts close the connection with a 30-second retry cooldown. A future protocol change can
require another compatibility update. Complete normal-launch parity for composer
and action controls still requires an additional supported desktop interface.

The tokenizer is pinned to `stream-json` 1.9.1 for the plugin's Node 20 runtime;
the current 3.x dependency chain requires Node 22. Only `Parser.js` and its UTF-8
decoder are bundled. The npm advisory about quadratic-depth processing in the
package's filters applies to modules this integration does not import or ship;
no filters or assemblers are used. Projection also caps nesting at 128 levels,
recognized keys at 128 characters, retained scalars at 4,096 characters, and
cumulative retained metadata at 256 KiB. Oversized unknown keys and task history
are discarded incrementally. Unsupported patch values invalidate the affected
task status and request a fresh snapshot.

On Codex 26.903.61454, the inspected IPC routes expose task owner/follower updates,
not a general desktop command registry/dispatcher or the focused composer's
model and reasoning selection. Updating a task's next-turn settings is not an
equivalent replacement for changing the current composer. Full normal-launch
support needs an authenticated desktop interface for focused task/composer state,
validated model/effort changes, and native action dispatch. This implementation
does not impersonate privileged clients or bypass desktop-access restrictions.

Verification covers fragmented framing, activity projection, live subscription,
revision gaps, reconnect cleanup, and connection-only renderer fallback. A live
read-only probe was also run against the existing Codex IPC socket without CDP.
