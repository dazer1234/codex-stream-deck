# macOS-only setup

This mode runs Stream Deck and Codex on the same Mac. It needs no Windows PC, relay, SSH, Tailscale, or host-target key. The same plugin package used on Windows launches new tasks and agent links locally through macOS.

## Optional iPhone Nearby pairing

With the LaunchAgent installed, enable the local iPhone node without restarting
Codex:

```zsh
./start-codex-deck.sh mobile-local-config
```

Scan the opened QR code with the iPhone Camera. The listener uses pinned TLS on
one private LAN address; Bonjour never contains the token and Chrome DevTools
remains on `127.0.0.1`. Rotate credentials only when needed with
`mobile-local-config --rotate`, and disable discovery with:

```zsh
./start-codex-deck.sh mobile-local-disable
```

Tailscale remote access remains a separate optional profile; see
[`IOS.md`](IOS.md).

## Install

1. Install `com.simeo.codex-deck.streamDeckPlugin` in Stream Deck for macOS.
2. Extract `codex-deck-launcher-macos-vX.Y.Z.zip`. The official release ZIP is created on macOS so its executable bits are preserved.
3. Install Node.js 20 or newer if `node --version` is unavailable.
4. From Terminal in the extracted launcher directory, run:

   ```zsh
   ./start-codex-deck.sh dry-run
   ./start-codex-deck.sh self-test
   ./start-codex-deck.sh start
   ```

   **Start Codex Deck.command** is the double-clickable equivalent of `start`.
5. Open **Codex Settings > Codex Micro**, configure the native slots, and add the actions from the [recommended layout](../README.md#recommended-15-key-layout). Leave the Windows/Mac target position empty or replace it with another action.

If an archive tool removed executable permissions, restore only the two launcher files:

```zsh
chmod +x start-codex-deck.sh "Start Codex Deck.command"
```

## Keep the bridge available

```zsh
./start-codex-deck.sh install
```

`install` copies the watcher runtime into Application Support and installs a per-user LaunchAgent. The watcher never launches or terminates Codex. It preserves normal sessions, app-update replacements, and sessions whose debugging bridge disappears, then reconnects when a healthy bridge becomes available. Previously stored recovery timers cannot authorize an automatic restart.

An ordinary Codex launch without a debugging bridge remains disconnected from the renderer controls. Preserving that session prevents the restart bug; it does not enable the bridge. The full renderer-based controls still require a bridge-enabled launch. A normal-launch transport is separate work. Only the explicit manual `start --restart` path may terminate an existing session.

Renderer discovery now includes `app-shared-*` chunks, using the shared event-bus fix from [PR #16](https://github.com/dazer1234/codex-stream-deck/pull/16). This improves discovery once a debugging bridge is available; it does not enable that bridge on an ordinary launch. Discovery-expression checks are automated, but live renderer and physical Stream Deck compatibility still require validation on the target Codex build.

Update by extracting the new launcher and running `install` again. The stable host identity, optional relay configuration, and user-owned icons are preserved.

## Commands

```zsh
./start-codex-deck.sh dry-run
./start-codex-deck.sh self-test
./start-codex-deck.sh start
./start-codex-deck.sh install
./start-codex-deck.sh uninstall
```

`start` asks for an explicit `yes` before restarting an already-running normal Codex session. Codex launches through LaunchServices so Input Monitoring/TCC permissions remain attached to the signed app bundle.

## Files

```text
~/Library/Application Support/CodexDeck/
  codex-deck-macos.mjs
  watcher-launch.sh
  codex-micro-bridge.json
  host.json
  watcher-state.json
  watcher.log, watcher.log.1 ...
  watcher.stderr.log             # LaunchAgent/runtime failures
  icons/                         # optional user-owned SVG copies

~/Library/LaunchAgents/com.simeo.codex-deck.watcher.plist
```

State writes are atomic, the watcher lock verifies PID, process start time, and command, and logs rotate at approximately 1 MB with three retained generations. The lock records a unique ownership token so an old cleanup cannot remove a successor’s lock. A fresh incomplete lock is left alone; stale ownership is retained in a `watcher.lock.stale.*` directory when reclaimed. Nothing inside the Codex app bundle is modified or re-signed.

## Diagnostics

```zsh
./start-codex-deck.sh dry-run
tail -n 100 "$HOME/Library/Application Support/CodexDeck/watcher.log"
tail -n 100 "$HOME/Library/Application Support/CodexDeck/watcher.stderr.log"
launchctl print "gui/$(id -u)/com.simeo.codex-deck.watcher"
plutil -lint "$HOME/Library/LaunchAgents/com.simeo.codex-deck.watcher.plist"
```

## Optional multi-host mode

Only configure `relay-config` when one Windows-connected Stream Deck should also control this Mac. The relay is disabled in Mac-only mode. See [Windows + Mac multi-host relay](MULTI_HOST.md).

## Uninstall

```zsh
./start-codex-deck.sh uninstall
```

This unloads the LaunchAgent and removes its runtime, bridge state, policy state, lock, and logs. It deliberately preserves `host.json`, optional relay configuration, and `icons/`. No Codex application data is removed and Codex is not restarted.
