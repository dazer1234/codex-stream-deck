# Usage Reset Countdown Design

**Date:** 2026-08-10
**Status:** Approved concept; awaiting written-spec review

## Problem

The Usage dial currently expresses every reset interval as total hours plus minutes. A weekly reset such as 125 hours and 48 minutes appears as `RESETS IN 125H 48M`, forcing the user to convert the hours into days mentally.

## Considered approaches

- **Compact days, hours, and minutes — selected.** `5D 5H 48M` is immediately readable and fits the existing detail line.
- **Keep total hours — rejected.** This preserves the status quo but leaves the mental conversion problem unresolved.
- **Use full words — rejected.** `5 days, 5 hours, 48 minutes` is clearer in prose but too long for the 184-pixel dial detail region.

## Design

Use days, hours, and minutes whenever the remaining interval is at least 24 hours. Preserve the existing compact uppercase style and minute ceiling so the countdown never reports an earlier reset than the source timestamp.

Examples:

| Remaining interval | Display |
|---|---|
| 48 minutes | `RESETS IN 48M` |
| 5 hours, 48 minutes | `RESETS IN 5H 48M` |
| 24 hours | `RESETS IN 1D` |
| 24 hours, 1 minute | `RESETS IN 1D 1M` |
| 125 hours, 48 minutes | `RESETS IN 5D 5H 48M` |
| 7 days | `RESETS IN 7D` |

Zero-value units are omitted except that an elapsed countdown remains `RESETS IN 0M`. Missing or non-finite timestamps continue to show `RESET UNAVAILABLE`.

The same formatter applies to Auto, 5-hour, and Weekly usage modes; it is not a separate profile setting. The longest expected weekly string fits within the existing 32-character bounded detail field and 184-pixel dial detail region, so no layout or font change is required.

## Scope

- Update the pure reset-countdown formatter in `src/dial-domain.ts`.
- Add boundary tests for minutes, hours, exact days, mixed days/hours/minutes, elapsed resets, and unavailable values.
- Update the Stream Deck + guide with the compact day/hour/minute format.
- Do not change reset timestamps, usage-source selection, rounding, refresh behavior, rate-limit reset credits, or keypad usage artwork.

## Verification

- `125H 48M` becomes `5D 5H 48M`.
- Intervals below 24 hours retain the current compact hour/minute form.
- Exact zero units are omitted without leaving extra spaces.
- Existing unavailable and elapsed behavior remains unchanged.
- Full type-check, test, Stream Deck validation, release audit, and branch diff checks pass.
- Physical Stream Deck + QA confirms the weekly string fits without truncation.
