# Troubleshooting

## Codex Micro is missing from Settings on Windows

- You can safely run the launcher again while a launcher-started Codex session is open; it now reuses the existing debug session instead of restarting Codex.
- Use `Start-CodexDeck.ps1 -ForceRestart` only when you explicitly want to restart Codex.
- To keep it available across Windows sign-in, Codex restarts, and Codex app updates, run `Start-CodexDeck.ps1 -InstallStartup` once. This installs a persistent single-instance watcher. Remove it with `-UninstallStartup`.
- Installing monitoring leaves an already-open normal Codex session untouched. Close and reopen Codex once, or run the launcher manually when you are ready for that one recovery restart.
- Watcher diagnostics are stored in `%LOCALAPPDATA%\CodexDeck\watcher.log` and rotate automatically.
- Close all Codex windows.
- Start Codex with `Start Codex Deck.cmd`.
- After `-InstallStartup`, the watcher uses its durable copy under `%LOCALAPPDATA%\CodexDeck\launcher`; the extracted ZIP is no longer required.
- Run this diagnostic from the launcher folder:

```powershell
.\Start-CodexDeck.ps1 -DryRun
```

If the launcher times out after a Codex update, open an issue with the exact Codex version and launcher output.

## Codex Micro is missing from Settings on macOS

Run these from the extracted matching launcher:

```zsh
./start-codex-deck.sh dry-run
./start-codex-deck.sh self-test
tail -n 100 "$HOME/Library/Application Support/CodexDeck/watcher.log"
```

Do not replace, re-sign, or edit the Codex app bundle. If `start` says an existing normal session needs a restart, it waits for your explicit `yes`.

The installed macOS watcher never launches or terminates Codex, including after a manual launch or app update. If the bridge is missing, it preserves the session and reports that condition once per process generation. Controls remain unavailable until a healthy bridge exists; a missing bridge no longer triggers a recovery restart. Explicit manual `start --restart` is the only restart path.

If an older watcher is repeatedly relaunching Codex after a crash or empty battery, stop only that watcher first:

```zsh
launchctl bootout "gui/$(id -u)/com.simeo.codex-deck.watcher"
```

Then install the launcher from the newest release. This command does not start, stop, or modify Codex itself.

## Agent keys say Bridge offline

- Confirm Codex was started through the launcher.
- Confirm the platform bridge state exists and contains a port number:
  - Windows: `%LOCALAPPDATA%\CodexDeck\codex-micro-bridge.json`
  - macOS: `~/Library/Application Support/CodexDeck/codex-micro-bridge.json`
- Restart Stream Deck.
- Do not run two launcher-started Codex instances at the same time.

## A key flashes an alert

The native handler was unavailable or the action is not valid in the current composer state. Check that the relevant function is assigned in **Codex Settings > Codex Micro** and that the intended Codex window/composer is active.

## Agent assignments are unexpected

Codex Deck does not choose the six native tasks. Open **Codex Settings > Codex Micro > Agent keys** and select pinned, recently updated, priority, or custom assignments. For combined Pinned or Individual assignments, select the same mode in both Codex apps. Pinned tasks are interleaved between hosts; in Individual mode the Stream Deck computer wins a conflicting slot and the remote host fills empty slots. Both lists are de-duplicated, and mirrored tasks route to the host owning the exact local rollout filename.

## Local command icon does not appear

- Verify the file is in `%LOCALAPPDATA%\CodexDeck\icons` on Windows or `~/Library/Application Support/CodexDeck/icons` on macOS.
- Verify the filename exactly matches the keycap ID reported by Codex, including `+` or `-`.
- Verify the SVG has a numeric `viewBox`.
- Restart Stream Deck after changing icon files.

## Plugin does not appear after installation

Restart Stream Deck. Elgato notes that plugins can fail to appear when the Stream Deck app is still running with elevated state after an install or update.

## Mac relay is offline

- First confirm both local bridges work independently.
- SSH mode: confirm the Windows watcher is installed and the SSH alias works outside Codex's remote-CLI connection.
- Inspect `%LOCALAPPDATA%\CodexDeck\watcher.log` for the dedicated relay tunnel state.
- On macOS, inspect both `watcher.log` and `watcher.stderr.log` under `~/Library/Application Support/CodexDeck/`.
- Confirm the Windows relay URL is `ws://127.0.0.1:<port>` for SSH, or an explicit Tailscale address.
- Restart only the Stream Deck plugin/app after configuration. Do not restart Codex.
- Run `Configure-CodexDeckRelay.ps1 -Disable` to return cleanly to Windows-only mode.

## Target key says DEGRADED

`DEGRADED` is different from `OFFLINE`: the relay may still be authenticated, but Codex Deck cannot currently prove that the host's native Micro state is fresh. This can happen while Codex is starting, after an app update changes undocumented renderer internals, or when native signals stop while the process remains connected.

- Orange warnings on agent tiles mean their task and status are last-known, not confirmed live.
- Wait briefly for startup recovery, then inspect the affected host's watcher logs if the state remains degraded.
- Do not trust a stale `working`, `done`, or approval color until the host returns to `READY`.
- A red warning and `OFFLINE` indicate transport loss instead; use the relay checks above.

## What to include in a bug report

- Codex app version and platform (`Get-AppxPackage OpenAI.Codex | Select-Object Version` on Windows; bundle version on macOS).
- Stream Deck version and device model.
- Windows version.
- Whether `Start-CodexDeck.ps1 -DryRun` succeeds.
- The relevant Stream Deck plugin log excerpt.
- The exact action that failed.

Do not attach Codex databases, rollout files, relay JSON, authentication data, personal paths, or official SVG asset files.
