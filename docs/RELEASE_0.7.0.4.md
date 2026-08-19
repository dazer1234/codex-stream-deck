# Codex Deck v0.7.0.4

This focused macOS hotfix adds an optional, persistent way to bring Codex to
the foreground before dispatching a local agent press.

## Changes

- Adds a global **Focus Codex** option to the Agent Display property inspector.
- Persists the option with Stream Deck so it survives app and computer
  restarts and applies consistently to all six agent keys.
- Activates Codex through its macOS bundle identifier before sending a local
  agent press, allowing subsequent keyboard shortcuts to target Codex.
- Leaves remote-agent routing and Windows behavior unchanged.
- Prevents the property inspector from overwriting unrelated global settings
  while its initial settings are loading.

## Downloads

- Stream Deck: `com.simeo.codex-deck.streamDeckPlugin`
- Windows launcher: `codex-deck-launcher-windows-v0.7.0.4.zip`
- macOS launcher: `codex-deck-launcher-macos-v0.7.0.4.zip`
- iPhone source: use the Source code archive or clone tag `v0.7.0.4`.
- Checksums: `SHA256SUMS.txt`

Existing v0.7.0 launcher and watcher installations remain compatible. Stream
Deck users only need to install the updated plugin. Codex itself does not need
to restart.

Codex Deck is an independent community project and is not made, supported, or
endorsed by OpenAI or Elgato.
