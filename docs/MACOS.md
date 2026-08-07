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

### Focus Codex when opening an agent

Each agent key's **Agent Display** inspector has a global **Focus Codex** option. It is off by default. When enabled, a local Mac agent press activates Codex before its native Micro event is sent, so approval and other keyboard shortcuts target Codex instead of the previously active app. Remote agents never activate the local app.

For a local installation or test environment, set `CODEX_DECK_FOCUS_CODEX_ON_AGENT_PRESS=true` before starting Stream Deck; it supplies the initial default until the inspector setting is saved.

If an archive tool removed executable permissions, restore only the two launcher files:

```zsh
chmod +x start-codex-deck.sh "Start Codex Deck.command"
```

## Keep the bridge available

```zsh
./start-codex-deck.sh install
```

`install` copies the watcher runtime into Application Support and installs a per-user LaunchAgent. It does not restart a normal Codex session already open during first installation and never launches Codex while the app is closed. After you open Codex normally, a later unbridged process must remain stable before it may receive one graceful recovery restart. A global cooldown blocks further automatic recovery across replacement process IDs, preventing restart loops after crashes, power loss, or incomplete app startup.

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

State writes are atomic, a PID-directory lock prevents duplicate watchers, and logs rotate at approximately 1 MB with three retained generations. Nothing inside the Codex app bundle is modified or re-signed.

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
