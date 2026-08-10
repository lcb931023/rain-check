# 上海内涝地图 · Shanghai Flood Map

Estimates street flooding in central Shanghai by combining Caiyun (彩云天气)
rainfall data with terrain (Copernicus GLO-30). Flood levels are **model
estimates, not measurements** — nothing here is gauged water depth.

The server sweeps a 14 × 13 grid of Caiyun points over the bbox
121.2–121.8 E, 30.95–31.45 N every 30 minutes and keeps the result in
`cache/rain-grid.json`, covering −24 h … +48 h in hourly steps. The browser
interpolates that rain onto a 201 × 201 elevation grid (~280 m cells), runs a
running-bucket model (runoff 0.8, drainage 10 mm/h × the slider) and shades
each cell on a transparent → blue ramp. The basemap is AMap, so every
coordinate is converted WGS-84 → GCJ-02 before it is drawn.

## Run

    npm install
    echo "CAIYUN_API_TOKEN=..." > .env
    npm run dev        # dev: vite on :5173, api on :8787

Production: `npm run build && npm start` → everything on :8787.

Other env vars: `PORT` (default 8787), `RAIN_REFRESH_MINUTES` (default 30).
Node 20+ (developed on 24). Tests: `npm test` and `npx tsc --noEmit`.

The rain cache fills on the first sweep: 182 points at a 450 ms stagger, which
is ~82 s of stagger plus request latency — about **two minutes** of wall time
measured. Until it lands, `/api/rain` answers 503 and the page says
暂无降雨数据，请稍后刷新.

Caiyun rate-limits per account, and 450 ms is what stopped the limiter from
carving a permanent hole in the grid — but a busy account still draws HTTP 429
on some points (57 of 182 on one observed sweep). On a **warm** cache those
cells keep their previous value and are refilled next sweep, so a
partly-throttled sweep degrades instead of failing. On the **first** sweep
after a cold start there is no previous value, so a throttled point stays null
and renders as *no rain* — indistinguishable from genuinely dry ground, not as
a gap. Those cells fill in over the next few refresh cycles, so treat the first
half-hour or so of a fresh deploy as incomplete rather than authoritative.
If a whole sweep fails, the stale cache keeps being served.

The −24 h history window self-accumulates over the first day of uptime: Caiyun
returns now + 48 h and nothing else, so past hours exist only because this
server was running to record them. A fresh deploy shows past hours as blank
until it has been up that long.

API: `/api/health`, `/api/rain` (503 before the first sweep),
`/api/elevation`, `/api/reports`.

## Deploy

Any Node 20+ host (Render/Fly free tiers work): build command
`npm install && npm run build`, start command `npm start`, env var
`CAIYUN_API_TOKEN`. Note: the host stores `cache/rain-grid.json` on local
disk; ephemeral filesystems lose history on restart (acceptable — it
re-accumulates). Keep one instance: each one runs its own fetcher against the
same rate-limited token, and they do not share the cache.

## Curated reports

Hand-edit `data/reports.json`. It is a JSON array — `[]` when there is nothing
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
validate the file (`node -e "JSON.parse(require('fs').readFileSync('data/reports.json'))"`)
after editing.

**Coordinates must be true WGS-84.** The app converts them to GCJ-02 itself
for display, so a coordinate that is already GCJ-02 gets shifted twice and the
marker lands roughly **500 m** off — far enough to name the wrong street, and
it looks plausible rather than broken. Nearly every coordinate you can copy
for a Chinese place — AMap, Baidu, Chinese wiki pages, most search results —
is GCJ-02 or BD-09, *not* WGS-84. Convert it first, then sanity-check the
marker against the basemap before committing.

`title`, `source` and `url` are interpolated into the popup as raw HTML, so
this file is trusted input: curate it by hand, never wire it to a feed.

## Regenerating the elevation grid

`npm run build-elevation` (downloads two Copernicus DEM tiles, ~100 MB;
output is committed so this is rarely needed).
