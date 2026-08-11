# History backfill on cold start — design

**Date:** 2026-08-11
**Status:** approved (user approved Approach A conversationally; adapted after probe findings)

## Problem

The −24 h history window only exists if the server has been running to record it:
each sweep stores the current hour's radar intensity, and past hours are carried
forward from the previous cache. A fresh start (or a wiped cache on an ephemeral
host) shows the past day as blank, so the flood model starts from zero water and
underestimates flooding *right now* — the main practical question the app answers.

## Probe findings (2 calls, 2026-08-11)

- Caiyun v2.6 honors `begin=<unix ts>` on both the `weather` and `hourly`
  endpoints on the free plan. Past hourly values are real observations
  (nonzero rain hours matched yesterday's storm).
- `hourlysteps` is **capped at 48** on this plan: requesting 73 returns 48.
  One call therefore covers a 48-hour window: either −24 h → +24 h (with
  `begin`) or now → +48 h (without).
- The returned series starts ~1–2 h *after* the requested `begin` (11:34
  requested → first hour 13:00). Compensate by asking for `begin = now − 26 h`.
- `realtime.precipitation.local.intensity` is still present when `begin` is set
  (weather endpoint), so the current-hour radar overwrite keeps working.

## Design

Each sweep runs in one of two modes, chosen from the cache state before
fetching — no persistent mode flag, no extra calls, still 182 calls per sweep:

- **Backfill mode** (`begin = now − 26 h`): used when the cache is absent or
  its past-24 h window is mostly empty. Fetches −24 h → +24 h per point.
- **Forecast mode** (no `begin`, as today): fetches now → +47 h per point.

**Mode rule:** backfill when the fraction of null values in the past-hour slots
(hours strictly before `nowIndex`, evaluated against the *new* sweep's window)
exceeds 25 %. Cold start = 100 % → backfill. The ~11 chronically rate-limited
points (≈6 %) must NOT trap the fetcher in backfill mode — hence a threshold,
not "any null".

Consequences: a fresh start renders the full past day after one sweep, with
forecast to +24 h; the next sweep (3 h later) is forecast mode and extends the
tail to +48 h. A server that was off for hours heals its history the same way.

## Merge rule change (`mergeRainCache`)

Old rule used fetched hourly values only for `t > nowIndex`. New rule, uniform
across modes — for a point that succeeded:

1. `t === nowIndex`: radar realtime intensity (unchanged).
2. Any other `t` where the fetched hourly series has that hour: use the fetched
   value — **fresh data now overwrites old cache for past hours too**. This is
   an accuracy upgrade: carried-forward past hours are often stale *forecasts*;
   backfilled values are observations.
3. Hour not in the fetched series (e.g. −24 h hours in forecast mode): carry
   forward from the old cache (unchanged).
4. Failed point: carry all hours forward from old cache (unchanged).
5. Total-failure and cold-start-total-failure behavior unchanged (return `old`
   / `null`, no write).

The merge stays pure and mode-agnostic: it consumes whatever hours came back.

## Code changes

- `server/caiyun.ts` — `fetchPointWeather` gains an optional `begin?: number`
  (unix seconds); appends `&begin=` when set. `hourlysteps` stays 48. URL still
  never logged.
- `server/fetcher.ts` — read the cache *before* fetching; new pure helper
  `needsBackfill(old, axes, now): boolean` implementing the 25 % rule; sweep
  passes `begin` to every point fetch in backfill mode and logs which mode ran;
  `mergeRainCache` rule 2 above.
- `README.md` — replace the "self-accumulates over the first day" caveat with
  the backfill behavior; note the +24 h forecast tail on the first sweep.

## Testing

- `needsBackfill`: no cache → true; empty past window → true; 6 % holes →
  false; >25 % holes → true.
- `mergeRainCache`: fetched past-hour value overwrites old cache value; hours
  absent from the fetched series still carry forward; existing 6 merge-rule
  tests keep passing (rule 2 supersedes one of them — update its expectation).
- `fetchPointWeather`: `begin` appended when given, absent when not.
- Sweep integration (mock fetch): cold start end-to-end produces a grid with
  non-null past hours.

## Out of scope

Persisting a rainfall archive beyond the 73-hour window; paid-plan
`hourlysteps` above 48; any UI change (the coverage line and slider already
handle fuller grids).
