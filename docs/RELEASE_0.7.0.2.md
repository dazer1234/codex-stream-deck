# Codex Deck v0.7.0.2

This focused stability hotfix improves single-computer and mixed Mac/Windows
operation. It does not include the in-development task timer or StandBy
dashboard work.

## Fixes

- Normalizes remote timestamps when a snapshot arrives, preventing normal clock
  differences between Mac and Windows from hiding working, selected, approval,
  context, or usage state.
- Returns controls to the local computer when a previously configured second
  host has been removed. A configured but temporarily offline relay still keeps
  the user's explicit remote selection.
- Keeps unique last-known tasks visible on iPhone when one computer disconnects,
  marks them offline in the app and widgets, and blocks taps that cannot be
  delivered.
- Routes iPhone commands through the healthy connection when duplicate profiles
  authenticate as the same computer.

## Downloads

- Stream Deck: `com.simeo.codex-deck.streamDeckPlugin`
- Windows launcher: `codex-deck-launcher-windows-v0.7.0.2.zip`
- macOS launcher: `codex-deck-launcher-macos-v0.7.0.2.zip`
- iPhone source: use the Source code archive or clone tag `v0.7.0.2`.
- Checksums: `SHA256SUMS.txt`

Existing v0.7.0 and v0.7.0.1 launcher/watcher installations remain compatible.
Stream Deck users only need to install the updated plugin. Codex itself does not
need to restart.

Codex Deck is an independent community project and is not made, supported, or
endorsed by OpenAI or Elgato.
