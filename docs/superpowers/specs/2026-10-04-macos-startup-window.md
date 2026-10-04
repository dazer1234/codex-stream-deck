# macOS bridge startup-window repair

Model Presets and Actions require the renderer bridge. At this boot, Codex
launched normally without its loopback debugging flags and no bridge state
exists. Task status and usage can still use desktop IPC.

The watcher initializes before its expensive full-application discovery.
This boot's first observation was about 25 seconds after initialization.
Every subsequent poll repeats that scan. Resuming persisted watcher state also
fabricates a 30-second pending interval, competing with the 30-second trigger
window. Neither behavior is necessary for safety.

Requirements:

- Prefer validated running Codex installations before lazy full discovery.
  Continue checking bundle identity and executable existence, and choose the
  newest version if several valid running installations exist.
- The watcher must observe only running process-table candidates, never scan
  stopped installations before observing a closed app. Full fallback discovery
  remains available to explicit launch/install diagnostics. Relay version is
  omitted while no Codex main is running.
- On watcher resume, preserve real pending deadlines, cooldown, and attempts,
  but never manufacture a new pending deadline. Treat its first observation as
  a new observer: preserve any existing normal Codex session, including young
  sessions, and recover only sessions opened after observing Codex stopped.
- Keep ten-second stability, 30-second trigger eligibility, 60-second absolute
  completion, exact-generation authorization, cooldown and one-attempt guards.
- Log decision transitions with process age and observation interval, without
  thread content, tokens, or per-second log spam.
- Install the verified watcher without restarting the established Codex
  process. Do not claim the current controls are restored until a bridge is
  actually available. No Codex app-bundle, permission, or model configuration
  changes.
