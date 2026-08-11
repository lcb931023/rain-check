# 内涝地图 · China Flood Map

Estimates street flooding by combining Caiyun (彩云天气) rainfall data with
terrain (Copernicus GLO-30). Flood levels are **model estimates, not
measurements** — nothing here is gauged water depth.

Three cities ship in the registry (`shared/cities.ts`), each a ~0.6° × 0.5°
box around the urban core:

| id | city | bbox |
|----|------|------|
| `shanghai` | 上海 Shanghai | 121.2–121.8 E, 30.95–31.45 N |
| `beijing` | 北京 Beijing | 116.1–116.7 E, 39.7–40.2 N |
| `zhengzhou` | 郑州 Zhengzhou | 113.35–113.95 E, 34.5–35.0 N |

Every city uses the same grid steps, so each costs an identical 14 × 13 = 182
Caiyun points and a 201 × 201 elevation grid (~280 m cells). The server sweeps
each enabled city every 3 hours into `cache/rain-grid-<id>.json`, covering
−24 h … +48 h in hourly steps. The browser interpolates that rain onto the
city's elevation grid, runs a running-bucket model (runoff 0.8, drainage
10 mm/h × the slider) and shades each cell on a transparent → blue ramp. The
basemap is AMap, so every coordinate is converted WGS-84 → GCJ-02 before it is
drawn.

The city is picked in the UI, remembered in `localStorage`, and overridable
per-link with `?city=beijing` (the URL wins, so shared links open where they
say). Switching cities reloads the page.

Adding a city is a registry entry plus one `npm run build-elevation -- <id>`
run; nothing else is city-specific.

## Run

    npm install
    echo "CAIYUN_API_TOKEN=..." > .env
    npm run dev        # dev: vite on :5173, api on :8787

Production: `npm run build && npm start` → everything on :8787.

Other env vars: `PORT` (default 8787), `RAIN_REFRESH_MINUTES` (default 180),
`CITIES` (default: all three; e.g. `CITIES=zhengzhou,shanghai` to sweep only
those). An unknown id in `CITIES` aborts startup rather than quietly sweeping
less. Cities left out are hidden from the UI and 404 from the API.
Node 20+ (developed on 24). Tests: `npm test` and `npx tsc --noEmit`.

**Quota budget — this is now 3× what it was.** The free Caiyun plan is a fixed
pool of total calls (not a daily allowance) at QPS 1. One sweep costs 182 calls
*per enabled city*, so all three cities cost 546 calls per sweep and, at the
default 3-hour refresh, **~4,368 calls/day** (one city alone: ~1,456). Check
剩余调用量 on your Caiyun console and do the math before leaving it running for
days. Use `CITIES` to sweep only what you are actually watching, lower
`RAIN_REFRESH_MINUTES` (e.g. 60) during an active storm when fresher data is
worth the spend, and stop the server when you don't need the map.

Cities are swept one after another, never concurrently — they share one
account's QPS-1 budget. Each city's cache fills on its first sweep: 182 points
at a 1.1 s stagger is ~3.3 min of stagger plus request latency, about **four
minutes** of wall time per city, so a cold start with all three enabled takes
~12 minutes before the last city has data. Until a city's cache lands,
`/api/rain?city=<id>` answers 503 and its page says 暂无降雨数据，请稍后刷新.
A city whose sweep fails entirely does not stop the others.

Each city's sweep runs in one of two modes, chosen independently from that
city's own cache (same 182 calls either way). When more than a quarter of the
past day's values are missing — a cold start, or the server was off for a
while — the sweep asks Caiyun for **history** (`begin=-26h`, which the free
plan's 48-hour cap turns into a −24 h…+24 h window), so a fresh deploy shows
the full past day after its very first sweep. Otherwise it fetches **forecast**
(now…+48 h) as usual. After a backfill sweep the +24 h…+48 h forecast tail is
blank until the next sweep (up to 3 h at the default interval) extends it.
Backfilled past hours are Caiyun's observed values and overwrite whatever the
cache had recorded for those hours.

Caiyun rate-limits per account; the 1.1 s stagger stays under this plan's
QPS 1, but a busy account can still draw HTTP 429 on some points. On a
**warm** cache those cells keep their previous value and are refilled next
sweep, so a partly-throttled sweep degrades instead of failing. On the
**first** sweep after a cold start there is no previous value, so a throttled
point stays null and renders as *no rain* — indistinguishable from genuinely
dry ground, not as a gap. Those cells fill in over the next few refresh cycles
(hours, at the default interval — the 数据覆盖 coverage line shows how complete
the grid is), so treat a fresh deploy's first sweeps as incomplete rather than
authoritative. If a whole sweep fails, the stale cache keeps being served.

Between sweeps, hours that have already passed keep the value fetched for
them at the time (a forecast, or the radar reading if a sweep landed in that
hour); they are only corrected to observations if a later backfill sweep
runs. Points that stay rate-limited through a backfill sweep keep null
history until those hours age out of the 73-hour window.

API: `/api/health`, `/api/cities`, and `/api/rain` (503 before that city's
first sweep), `/api/elevation`, `/api/reports` — each taking `?city=<id>` and
defaulting to the first enabled city. An id outside the enabled set is a 404;
ids are resolved against the registry rather than interpolated into a path.

## Deploy

Any Node 20+ host (Render/Fly free tiers work): build command
`npm install && npm run build`, start command `npm start`, env vars
`CAIYUN_API_TOKEN` and optionally `CITIES`. Note: the host stores
`cache/rain-grid-<id>.json` on local disk; ephemeral filesystems lose history
on restart (acceptable — it re-accumulates). Keep one instance: each one runs
its own fetcher against the same rate-limited token, and they do not share the
cache.

## Curated reports

Hand-edit `data/reports-<city>.json` — one file per city, and a report only
shows on its own city's map. Each is a JSON array — `[]` when there is nothing
to show. A complete entry, valid as written:

```json
[
  {
    "id": "2026-08-10-renmin-square",
    "lon": 121.4694,
    "lat": 31.2325,
    "severity": 2,
    "title": "人民广场地铁站出口积水",
    "source": "上海发布",
    "url": "https://weibo.com/...",
    "time": "2026-08-10T03:00:00Z"
  }
]
```

`url` is the only optional field; everything else is required. `severity` is
`1`, `2` or `3` (1 = minor, 3 = severe) and picks the marker colour;
`time` is an ISO 8601 timestamp. Malformed JSON makes `/api/reports` unusable
and the layer disappears **silently** — no error is shown in the UI — so
validate the file (`node -e "JSON.parse(require('fs').readFileSync('data/reports-shanghai.json'))"`)
after editing. Coordinates outside the city's bbox are not rejected; they just
draw off to the side of the flood layer.

**Coordinates must be true WGS-84.** The app converts them to GCJ-02 itself
for display, so a coordinate that is already GCJ-02 gets shifted twice and the
marker lands roughly **500 m** off — far enough to name the wrong street, and
it looks plausible rather than broken. Nearly every coordinate you can copy
for a Chinese place — AMap, Baidu, Chinese wiki pages, most search results —
is GCJ-02 or BD-09, *not* WGS-84. Convert it first, then sanity-check the
marker against the basemap before committing.

Report fields are put into the popup as text nodes and `url` is accepted only
when it parses as `http(s)`, so a stray quote cannot break out into markup.
Still curate this file by hand rather than wiring it to a feed.

## Regenerating the elevation grid

    npm run build-elevation -- beijing     # one city
    npm run build-elevation -- all         # every city in the registry

Downloads the Copernicus DEM tiles the city's bbox touches (~100 MB each; the
tiles needed are derived from the bbox, so a new city needs no code change).
The outputs are committed, so this is rarely needed.
