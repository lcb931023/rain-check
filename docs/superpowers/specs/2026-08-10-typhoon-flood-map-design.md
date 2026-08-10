# Shanghai Flood Map (上海内涝地图) — Design Spec

**Date:** 2026-08-10
**Context:** Built in response to Typhoon Dolphin's flooding of Shanghai. Public-facing web
app, soft-launched with a few friends first. Goals: (a) reveal meta-level patterns of which
parts of the city flood and why, (b) answer practical questions like "is the place I'm
going flooded?" or "should I order delivery from a shop in that area?"

## Summary

A single Node/TypeScript web app that visualizes estimated street flooding across central
Shanghai. The server periodically fetches a grid of rainfall data from the Caiyun API and
caches it; the browser combines that rain grid with a precomputed elevation grid and runs a
simple client-side flood model, rendered as a translucent blue overlay on a MapLibre map.
Two interactive sliders — time (−24h to +48h) and drainage efficiency — recompute the model
instantly in the browser.

Flood levels are **model estimates, not measurements**, and the UI says so.

## Scope decisions (agreed)

- **Audience:** public tool eventually, friends first. Prefer China-accessible resources
  (domestic tile providers, no GFW-blocked CDNs) but hosting will initially be local dev or
  a free non-China Node host, so nothing may *depend* on a China VPS.
- **Core of v1:** rainfall display + flood estimation with a drainage-efficiency slider.
- **Ground truth reports:** weak feature in v1. Official announcements (e.g. 上海发布,
  water authority) plus a lightly hand-curated feed. **No user submissions. No scraping.**
- **Flood model inputs:** rain + elevation. (Historical waterlogging points / housing-age
  vulnerability layers are out of scope for v1.)
- **Time window:** past ~24h accumulation through next 48h forecast, on a time slider.
- **Coverage:** central Shanghai (roughly within the outer ring, ~121.2–121.8°E,
  30.95–31.45°N) at ~2km rain-grid spacing ≈ 200 points. Outside that: no data.
- **Stack:** Node/TypeScript full-stack (Express + static frontend), MapLibre GL.
- **Language:** Simplified Chinese default, English toggle.
- **Computation split (Approach 1):** server caches data; browser computes the flood model
  so both sliders respond without round trips.

## Architecture

```
Caiyun API ──(every ~20 min, ~200 grid pts)──> Fetcher ──> cache/rain-grid.json
Copernicus GLO-30 DEM ──(one-time script)──> data/elevation-grid.json (~250m cells)
data/reports.json  (hand-edited curated/official reports)
                         │
                 Express server ── /api/rain  /api/elevation  /api/reports ──> Browser
                                                                                │
                                                              MapLibre GL + flood model in JS
```

### Server (Express, single process)

- **Fetcher loop** (`setInterval`, ~20 min): for each rain-grid point, fetch Caiyun
  `realtime`, `hourly?hourlysteps=48`, and past-24h hourly history. Requests are staggered
  to be gentle on rate limits. Results merge into one consolidated `rain-grid.json` with a
  `fetchedAt` timestamp.
- **History fallback:** if the hourly-history endpoint is unavailable on the current Caiyun
  plan, the server builds its own history by retaining past realtime/hourly polls in the
  cache (the −24h window fills in over the first day after launch instead of immediately).
- **Caching / failure policy:** stale-cache-on-failure. Per-point retry with backoff.
  Quota-exceeded detection: serve the cache, log loudly. The cache file survives restarts.
- **Endpoints:** `/api/rain` (consolidated grid time series), `/api/elevation` (static
  file), `/api/reports` (static file), plus the static frontend. Caiyun token is read from
  `.env` and never reaches the client.
- **Dev = prod:** `npm run dev` runs the same app locally against the same `.env`.
  Deployable unchanged to any free Node host (Render/Fly) or later a China VPS.

### Data preprocessing (one-time script)

- Download Copernicus GLO-30 DEM tiles covering the bounding box; sample to a ~250m grid;
  for each cell compute elevation and a **depression factor**: cell elevation minus mean
  elevation of its ~1km neighborhood (topographic position index). Output
  `data/elevation-grid.json` (~100–200KB gzipped), committed to the repo so deploys never
  re-download the DEM.

## Flood model (client-side)

Per ~250m elevation cell, per hourly step:

```
water[t]     = max(0, water[t-1] + rain[t] × runoff − drain_rate × slider)
flood_index  = water[t] × depression_factor
```

- `rain[t]` is bilinearly interpolated from the four nearest rain-grid points.
- `drain_rate` is a nominal Shanghai drainage capacity constant; the **drainage slider**
  scales it 0.2×–2× (default 1×).
- `depression_factor` ≥ 0, higher for cells lower than their surroundings; ridges shed
  water, hollows accumulate it. This is what surfaces city-planning patterns without full
  hydrological routing.
- The whole simulation runs over typed arrays for all cells × all time steps — a few
  hundred thousand operations, instant on slider changes.
- Flood index is bucketed into legend bands: 无明显积水 / 可能积水 / 严重积水.

## Rendering & coordinates

- **Base tiles:** AMap raster tiles (accessible inside and outside China). Config fallback
  to OSM raster tiles if AMap blocks the referer.
- **Coordinates:** all overlay geometry converted WGS-84 → GCJ-02 (standard transform) to
  align with AMap/Tianditu tiles. The transform is applied in exactly one place.
- **Flood overlay color scheme (thematic):** no water = fully **transparent**; increasing
  flood index deepens through translucent light blue to saturated deep blue. No
  yellow/red ramp. Exact ramp stops chosen at implementation time for legibility against
  the base map in both light and dark tile styles.
- Past-vs-future time steps are visually distinguished in the legend (estimated vs
  predicted).

## UI

Single-page map, Chinese-first with an EN toggle (one small strings file):

- **Time slider** (bottom): −24h ← 现在 → +48h; past = estimated current flooding, future
  = predicted.
- **Drainage slider** (control panel): 「排水效率」 with plain-language hint
  (拖动模拟排水系统好坏).
- **Legend** with the three flood bands and an honesty note: model estimate, not
  measurement.
- **Reports layer:** pins from `reports.json` (source, link, severity, timestamp).
  Toggleable; off by default when empty. Maintained by hand-editing the JSON — no admin UI.
- **Click anywhere** → popup with the local rain-accumulation curve and flood index over
  time (answers the delivery question).
- **Freshness:** 「数据更新于 HH:MM」 always visible, sourced from the cache's `fetchedAt`.

## Error handling

- Caiyun outage/quota: serve stale cache; UI keeps working with the visible freshness
  timestamp making staleness honest.
- Missing elevation cell / rain point: cell renders transparent (no fabricated data).
- Tile provider failure: switch to fallback tile URL via config.

## Testing (vitest)

- Flood model math: accumulation, drainage scaling, depression weighting — pure functions.
- WGS-84 → GCJ-02 transform against known reference points.
- Bilinear rain interpolation.
- Fetcher cache/merge logic with mocked Caiyun responses (success, partial failure, quota
  exceeded, stale serve).
- UI verified manually.

## Out of scope for v1

User-submitted reports, social-media scraping, historical waterlogging-point (积水点) and
housing-age vulnerability layers, mobile app, accounts, admin UI. All layerable later
without rearchitecting.
