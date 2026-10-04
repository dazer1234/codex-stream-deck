# Human-Readable Usage Reset Countdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show weekly and other long usage reset intervals as compact days, hours, and minutes, for example `5D 5H 48M`, without changing timestamps, rounding, or dial layout.

**Architecture:** Keep the existing pure `resetCountdown` boundary and minute-ceiling behavior. Decompose the already-ceiled total minutes into days, hours, and minutes, omit zero units, and let all usage modes continue consuming that one formatter.

**Tech Stack:** TypeScript, Node.js test runner through `tsx --test`, Elgato Stream Deck SDK dial feedback.

---

## File Map

- `src/dial-domain.ts` — decompose remaining minutes into compact day/hour/minute units.
- `test/dial-domain.test.ts` — cover boundary, rounding, unavailable, and exact-string behavior.
- `docs/STREAM_DECK_PLUS.md` — document the human-readable countdown.

## Task 1: Format Long Reset Intervals with Days

**Files:**
- Modify: `src/dial-domain.ts`
- Test: `test/dial-domain.test.ts`

- [ ] **Step 1: Write failing exact-string tests through public feedback**

Add a table-driven test beside existing usage feedback cases. Build a weekly `DialRuntimeView`, call `deriveDialFeedback`, and assert its `detail`:

```ts
const cases = [
  { minutes: 48, expected: "RESETS IN 48M" },
  { minutes: 5 * 60 + 48, expected: "RESETS IN 5H 48M" },
  { minutes: 24 * 60, expected: "RESETS IN 1D" },
  { minutes: 24 * 60 + 1, expected: "RESETS IN 1D 1M" },
  { minutes: 125 * 60 + 48, expected: "RESETS IN 5D 5H 48M" },
  { minutes: 7 * 24 * 60, expected: "RESETS IN 7D" },
  { minutes: 0, expected: "RESETS IN 0M" }
];
```

Keep an additional sub-minute case such as `60_001` milliseconds to prove `Math.ceil` still reports `2M`, plus non-finite/missing reset timestamps that remain `RESET UNAVAILABLE`.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx tsx --test --test-name-pattern='usage reset countdown.*days' test/dial-domain.test.ts
```

Expected: FAIL because 125 hours still renders as `125H 48M`.

- [ ] **Step 3: Implement minimal day decomposition**

Replace only the formatting tail of `resetCountdown` in `src/dial-domain.ts`:

```ts
const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
const days = Math.floor(minutes / (24 * 60));
const hours = Math.floor((minutes % (24 * 60)) / 60);
const remainder = minutes % 60;
const units = [
  days > 0 ? `${days}D` : "",
  hours > 0 ? `${hours}H` : "",
  remainder > 0 || (days === 0 && hours === 0) ? `${remainder}M` : ""
].filter(Boolean);
return `RESETS IN ${units.join(" ")}`;
```

Do not change `resetsAt`, `now`, `Math.ceil`, `RESET UNAVAILABLE`, usage mode selection, or feedback field bounds.

- [ ] **Step 4: Run focused checks and verify GREEN**

```bash
npx tsx --test test/dial-domain.test.ts
npm run check
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit the formatter slice**

```bash
git add src/dial-domain.ts test/dial-domain.test.ts
git commit -m "feat: show usage reset days"
```

## Task 2: Document and Verify the Countdown

**Files:**
- Modify: `docs/STREAM_DECK_PLUS.md`

- [ ] **Step 1: Update the guide**

State that reset detail uses compact day/hour/minute units and include the example `RESETS IN 5D 5H 48M`. Confirm the same formatter applies to Auto, 5-hour, and Weekly modes.

- [ ] **Step 2: Run fresh complete verification**

```bash
npm run check
npm test
npm run validate
npm run audit:release
git diff --check
git status --short
```

Expected: all non-platform-skipped tests pass, Stream Deck validation passes, release audit passes, and no unexpected generated file remains modified. If validation regenerates only the known tracked plugin PNGs, restore those two generated files and prove the remaining status is scoped.

- [ ] **Step 3: Commit the documentation slice**

```bash
git add docs/STREAM_DECK_PLUS.md
git commit -m "docs: explain usage reset countdowns"
```

- [ ] **Step 4: Include the countdown in final review and install**

Request independent review together with the Ultra feature, merge only after approval, and install the same validated build. On Stream Deck +, select Weekly and confirm a 125-hour-and-48-minute interval fits as `RESETS IN 5D 5H 48M` without truncation; also inspect a sub-day interval to confirm the original hour/minute style remains.
