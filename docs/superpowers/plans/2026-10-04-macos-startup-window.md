# macOS Startup Window Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with independent final QA. Standing authorization supplies execution and integration approval.

**Goal:** Stop avoidable startup recovery misses without disrupting established Codex sessions.

**Architecture:** Lazy fallback discovery; restart-safe observer initialization; transition-only diagnostics.

**Tech Stack:** TypeScript, Node.js, node:test, macOS LaunchAgent.

**Spec:** `docs/superpowers/specs/2026-10-04-macos-startup-window.md`

## Global Constraints

- Ten-second stability, 30-second trigger, 60-second completion; do not widen.
- Preserve current Codex process and unrelated icon modifications.
- Existing PR #13 remains open for the upstream maintainer.

## Review Focus

- Several running apps: reject non-Codex bundles and select validated Codex.
- Renamed app: use bundle identity, not display name.
- Watcher restarted over an existing young session: preserve it.
- Real recovery pending/cooldown persisted: retain protections.
- Newly opened normal session: get stable observations before the trigger expires.

### Task 1: Repair and deploy startup observation

**Files:** Modify `launcher/macos/codex-deck-macos.ts`, `launcher/macos/watcher-policy.ts`, `test/macos-launcher.test.ts`, `test/macos-watcher.test.ts`, `docs/MACOS.md`.

**Interfaces:** `selectCodexInstallation(runningAppPaths, readInstallation, fallbackAppPaths): Promise<CodexInstallation>` uses OS-boundary dependencies; `observeRunningCodex(rows, readInstallation)` returns a validated installation/main pair or two nulls, with no fallback enumeration. `resumeWatcherPolicyState` retains its public signature.

- [x] Write failing selection tests: running renamed Codex bypasses fallback; multiple running versions choose newest; invalid running candidates use lazy fallback; absent candidates reject.
- [x] Write failing resumed-state tests: observed closed then launch at 2s recovers at 12s; young pre-existing generation remains untouched; real pending deadline and cooldown remain effective.
- [x] Cover watcher closed observation without any stopped-app lookup, renamed actual generation, unrelated running app, and young rapid replacement with real start timestamps.
- [x] Run `npx tsx --test test/macos-{launcher,watcher}.test.ts`; expected missing selection export / incorrect pending or preserved-session behavior.
- [x] Implement running-installation fast path and resume first-observation safety. Add transition-only decision diagnostics; update macOS behavior documentation.
- [x] Run focused tests, `npm test`, `npm run check`, `npm run validate`, `npm run audit:release`, built launcher `self-test`; expected zero failures.
- [x] Independent review of full task diff, repair any important findings with red/green regression tests.
- [x] Commit exact task files, push existing PR branch, back up and install watcher runtime; verify unchanged Codex PID and fast observations.
- [x] Update existing PR with verified checks and current-session restart limitation. Hand off the exact explicit restart command.

Implementation and watcher installation complete in `9b7a079`. Current-session
renderer restoration and the next real reboot remain pending, not claimed
verified. After active work finishes, the explicit restart command is:

```sh
node "$HOME/Library/Application Support/CodexDeck/codex-deck-macos.mjs" start --restart
```
