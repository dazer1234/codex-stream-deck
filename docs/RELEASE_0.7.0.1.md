# Codex Deck v0.7.0.1

This hotfix hardens mirrored task identity between Windows and macOS Codex
instances. It does not change the launcher, watcher, iPhone pairing, or native
Codex Micro command surface introduced in v0.7.0.

## Fixes

- De-duplicates a new task while Codex transitions from its temporary renderer
  ID to the stable rollout ID visible on the other host.
- Remembers that mapping across later task selections and relay reconnects in
  both Windows-to-Mac and Mac-to-Windows directions.
- Uses the title and context usage available from either mirror when one host
  temporarily publishes incomplete metadata.
- Shows `New chat` for an assigned titleless thread and reserves `Not assigned`
  for a genuinely empty agent slot.
- Keeps a neutral context ring visible until the first token-count event arrives.

## Downloads

- Stream Deck: `com.simeo.codex-deck.streamDeckPlugin`
- Windows launcher: `codex-deck-launcher-windows-v0.7.0.1.zip`
- macOS launcher: `codex-deck-launcher-macos-v0.7.0.1.zip`
- iPhone source: use the Source code archive or clone tag `v0.7.0.1`.
- Checksums: `SHA256SUMS.txt`

Existing v0.7.0 launcher and watcher installations remain compatible. Stream
Deck users only need to install the updated plugin. Reload the Codex Deck
Stream Deck plugin after updating; Codex itself does not need to restart.

Codex Deck is an independent community project and is not made, supported, or
endorsed by OpenAI or Elgato.
