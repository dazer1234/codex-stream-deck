# Windows + Mac multi-host relay

This optional mode keeps the physical Stream Deck and Stream Deck software on Windows while controlling both desktop Codex apps. Each computer still has a fully independent local bridge; disabling the relay returns them to normal single-host behavior.

```text
Stream Deck -> Windows plugin -> local Windows Codex
                           \-> authenticated relay -> local Mac Codex
```

The relay never exposes Chrome DevTools. It forwards only typed Codex Deck commands, six native agent snapshots, and a bounded content-free local task-presence catalog.

## Before pairing

1. Complete [Windows setup](WINDOWS.md), including `-InstallStartup`.
2. Complete [macOS setup](MACOS.md), including `install`.
3. Confirm both local bridges work independently.
4. Use either:
   - **SSH tunnel (recommended when SSH already works):** Mac listens on loopback and the Windows watcher maintains a dedicated `ssh -N` tunnel.
   - **Tailscale:** Mac listens on its explicit tailnet address.

Never use `0.0.0.0`, a public IP, or router port forwarding. Codex Deck rejects wildcard and arbitrary public-IP relay addresses.

## Pair with SSH

On the Mac:

```zsh
./start-codex-deck.sh relay-config 127.0.0.1
```

This creates a random 256-bit token in `~/Library/Application Support/CodexDeck/relay-server.json` with user-only permissions. Treat the printed token as a password.

On Windows, run the matching configurator and omit `-Token` so the secret is entered through a hidden prompt rather than appearing on the command line:

```powershell
.\Configure-CodexDeckRelay.ps1 `
  -MacAddress 127.0.0.1 `
  -SshHost '<Mac SSH hostname or config alias>'
```

The persistent Windows watcher maintains this dedicated tunnel after sign-in and reconnects it after network interruptions. It does not adopt or depend on Codex desktop's remote-CLI SSH process.

The Mac relay can remain authenticated while the Mac Codex app is closed or still loading. Snapshot failures are contained and rate-limited; they do not crash the watcher. Once the native Micro bridge is ready, snapshots resume over the existing connection.

Restart only the Stream Deck plugin or Stream Deck app after pairing. Do not restart Codex.

## Pair with Tailscale

On the Mac, substitute its specific Tailscale IP or `*.ts.net` name:

```zsh
./start-codex-deck.sh relay-config 100.x.y.z
```

On Windows:

```powershell
.\Configure-CodexDeckRelay.ps1 -MacAddress 100.x.y.z
```

Enter the token in the hidden prompt. The relay accepts loopback, Tailscale IPv4 (`100.64.0.0/10`), Tailscale IPv6, and `*.ts.net` targets only.

## Stream Deck behavior

- The six agent keys form one mode-aware Windows+Mac list controlled by the normal Codex Micro agent-source setting.
- Each visible tile receives a small `W` or `M` badge and routes to its owning desktop.
- Add **Windows / Mac Target + Health** to page 2. It switches action slots, joystick, encoder, reasoning, standalone keycaps, and New Task between computers while showing the selected host as `READY`, `DEGRADED`, `CONNECT`, or `OFFLINE`.
- Agent keys ignore the selected target because each task already knows its owner.
- The selected target survives plugin and relay restarts. If Mac is selected while offline, the key visibly fails instead of silently executing on Windows.

### Host-health behavior

- `READY` means fresh native Codex Micro snapshots are arriving.
- `DEGRADED` means the transport can still be connected, but native renderer signals are unavailable, the first snapshot has not arrived, or the last snapshot is stale. This is the important undocumented-internals failure: connectivity alone is not treated as proof that task state is live.
- `OFFLINE` means the relay transport is disconnected. `CONNECT` is the short reconnecting state.
- Last-known agent tasks stay in their existing slots during degraded or offline periods so a temporary host failure cannot silently reorder the deck. A warning is drawn on every affected tile: orange for uncertain native signals and red for an offline host.
- Commands never fall through to the other computer. A command aimed at an offline host fails visibly and safely.

Host health deliberately shares the target key instead of consuming one of the six task keys. The target key is the host-wide status surface; agent-tile warnings identify which last-known tasks are affected.

### Agent-source modes

Single-host Windows and macOS setups preserve Codex's six native slots exactly. In multi-host mode, the Codex app on the computer running the Stream Deck plugin is the controller for the combined list:

- **Pinned:** interleaves the pinned order from Windows and Mac slot by slot, removes duplicates, and routes each task to its owning desktop. With six unique tasks available this gives both hosts up to three keys instead of allowing one full list to hide the other.
- **Recently updated:** globally orders actual Windows and Mac activity.
- **Priority:** ranks approval/questions first, then unread/errors, active work, and idle tasks.
- **Individual assignments:** preserves the controller's slot positions. If both apps assign different tasks to one physical button, the controller assignment wins. When the controller slot is empty and the remote Codex app is also set to Individual assignments, its assignment from the same slot is used. The same task assigned through both apps is shown only once and routed to its rollout owner.

For a true combined Pinned or Individual list, select that mode in both Codex apps. If the modes differ, the controller mode still determines the list, but only a remote host using the matching mode can contribute its own pinned order or individual assignments. Codex Deck writes a warning to the plugin log when this happens.

This makes manual mixed layouts possible without another settings application. Assign a synced task directly in the controller Codex app when it is available there. For a Mac-only task that is not selectable on Windows, leave that Windows slot empty and assign the task to the same slot in the Mac Codex Micro settings. Changes are picked up automatically by the next native snapshot.

### Ownership and SSH mirrors

Codex's built-in remote-SSH feature can mirror a task into the other renderer. Codex Deck does not confuse that CLI connection with the owning desktop. In multi-host mode it compares exact local rollout **filenames** on both hosts and checks only bounded JSONL tails for structural `task_started`, legacy `agent_reasoning`/`function_call`, and `task_complete` lifecycle events plus the numeric fields in the latest `token_count` record. For an owned local session, it reads the initial metadata record's `cwd` only to derive the final folder name as a compact folder label; full paths are never displayed or relayed. A renderer `turn_context` alone never marks a completed task as working. Prompt text and responses are neither parsed nor sent through the relay.

The relay catalog contains only recent task UUIDs, modification times, derived `working`, `complete`, or `idle` state, an optional context-window percentage, and (when enabled) a compact folder name. For the same cloud task visible on both hosts, live status, context usage, and selection are merged while commands route to the rollout owner—even when Codex temporarily omits the task from that owner's six native Micro slots. Ownership is host-generic and contains no hard-coded task IDs or folder names.

### Ordering boundary

Native activity timestamps are used when available. Otherwise Codex Deck retains the last observed assignment, title, selection, or status change. Connecting a second host does not make old idle tasks appear recent. Immediately after first pairing, historical ordering between already-idle mirrored tasks remains best effort when Codex exposes no timestamp; activity observed after pairing is ordered exactly.

## Disable or rotate

Mac:

```zsh
./start-codex-deck.sh relay-disable
```

Windows:

```powershell
.\Configure-CodexDeckRelay.ps1 -Disable
```

Disabling Windows also removes the persisted Mac control target so single-host mode resumes locally. Run `relay-config` again to rotate the token, then reconfigure Windows. Never commit either relay JSON file or paste its token into an issue, log, shell command, or screenshot.
