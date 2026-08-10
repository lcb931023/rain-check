# Shanghai Flood Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/TypeScript web app that estimates and visualizes street flooding in central Shanghai from Caiyun rainfall data + elevation, with interactive time and drainage sliders.

**Architecture:** One Express server fetches a ~180-point Caiyun rain grid every 30 min into a JSON cache and serves it plus a precomputed elevation grid and a curated reports file. The browser (Vite + vanilla TS + MapLibre GL) runs a per-cell bucket flood model client-side and renders it as a canvas overlay (transparent → blue) on AMap raster tiles (GCJ-02).

**Tech Stack:** Node 20+, TypeScript, Express, Vite (vanilla-ts), MapLibre GL, vitest + supertest, `geotiff` (preprocessing script only), `tsx`, `concurrently`, `dotenv`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-typhoon-flood-map-design.md`. It wins on any conflict.
- `CAIYUN_API_TOKEN` is read from `.env` server-side only; it must never appear in frontend code, bundles, or URLs sent to the client.
- Flood overlay color scheme: no water = fully transparent; deeper water = deeper blue. No yellow/red ramp anywhere.
- All map overlay geometry is WGS-84 internally; conversion to GCJ-02 happens ONLY in `web/src/gcj02.ts` consumers at render time.
- UI is Simplified Chinese by default with an English toggle; every user-visible string goes through `t()` from `web/src/strings.ts` — no hardcoded UI strings.
- Coverage bbox: lon 121.2–121.8, lat 30.95–31.45. Rain grid step: 0.045° lon × 0.04° lat (≈ 200 points). Elevation grid step: 0.003° lon × 0.0025° lat (≈ 200×200 cells).
- Server failure policy: stale-cache-on-failure; `/api/rain` serves the last good cache with its original `fetchedAt`.
- No GFW-blocked resources at runtime: no Google/Mapbox/CDN-hosted assets; all JS/CSS is bundled locally; base tiles come from AMap (fallback OSM via config).
- Flood values are estimates: the legend must carry the disclaimer string (`legendDisclaimer` in strings).
- Node ESM throughout (`"type": "module"`).
- Commit after every task (steps include the commands).

## File Structure

```
package.json, tsconfig.json, vite.config.ts, .gitignore (exists), .env (exists, never committed)
shared/types.ts            — RainGrid / ElevationGrid / Report interfaces (server + web)
server/config.ts           — bbox, grid steps, refresh interval, ports, paths
server/caiyun.ts           — fetchPointWeather(): one Caiyun /weather call → typed result
server/fetcher.ts          — grid point list, staggered sweep, mergeRainCache(), cache file I/O
server/routes.ts           — Express router: /api/health /api/rain /api/elevation /api/reports
server/index.ts            — app entry: dotenv, static serving, fetcher loop
scripts/probe-caiyun.ts    — one real API call, prints the fields we rely on
scripts/build-elevation-grid.ts — DEM download + sampling → data/elevation-grid.json
scripts/tpi.ts             — pure depression-factor math (testable, used by build script)
data/elevation-grid.json   — generated once, committed
data/reports.json          — hand-curated reports, committed (starts as [])
web/index.html             — page shell, control panel, legend, sliders
web/src/main.ts            — bootstrap: load data, run model, wire UI
web/src/api.ts             — typed fetches of /api/*
web/src/gcj02.ts           — wgs84ToGcj02()
web/src/interp.ts          — bilinear rain interpolation + per-cell weight precompute
web/src/model.ts           — flood bucket model (pure)
web/src/render.ts          — floodColor() ramp + drawFloodCanvas()
web/src/mapview.ts         — MapLibre init, canvas source, reports markers, click popup
web/src/strings.ts         — zh/en dictionaries, t(), setLang()
tests/gcj02.test.ts, tests/interp.test.ts, tests/model.test.ts, tests/render.test.ts,
tests/tpi.test.ts, tests/fetcher.test.ts, tests/routes.test.ts, tests/caiyun.test.ts
```

---

### Task 1: Project scaffold + Express health endpoint

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `server/config.ts`, `server/routes.ts`, `server/index.ts`, `web/index.html`, `web/src/main.ts`
- Test: `tests/routes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createRouter(opts: {cacheDir: string, dataDir: string}): express.Router` from `server/routes.ts`; `CONFIG` object from `server/config.ts` (shape below); npm scripts `dev`, `build`, `start`, `test`.

- [ ] **Step 1: Write package.json, tsconfig.json, vite.config.ts**

`package.json`:

```json
{
  "name": "typhoon-map",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k \"tsx watch server/index.ts\" \"vite\"",
    "build": "vite build",
    "start": "tsx server/index.ts",
    "test": "vitest run",
    "probe": "tsx scripts/probe-caiyun.ts",
    "build-elevation": "tsx scripts/build-elevation-grid.ts"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "maplibre-gl": "^4.7.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/supertest": "^6.0.2",
    "concurrently": "^9.0.0",
    "geotiff": "^2.1.3",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vitest": "^2.0.5"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client", "node"]
  },
  "include": ["server", "web/src", "shared", "scripts", "tests"]
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
```

Run: `npm install`

- [ ] **Step 2: Write the failing route test**

`tests/routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter } from '../server/routes.js';

export function makeApp(cacheDir: string, dataDir: string) {
  const app = express();
  app.use('/api', createRouter({ cacheDir, dataDir }));
  return app;
}

describe('routes', () => {
  it('GET /api/health returns ok', async () => {
    const res = await request(makeApp('/tmp/none', '/tmp/none')).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/routes.test.ts`
Expected: FAIL — cannot resolve `../server/routes.js`.

- [ ] **Step 4: Implement config, routes, server entry, page shell**

`server/config.ts`:

```ts
export const CONFIG = {
  port: Number(process.env.PORT ?? 8787),
  bbox: { lonMin: 121.2, lonMax: 121.8, latMin: 30.95, latMax: 31.45 },
  rainStep: { lon: 0.045, lat: 0.04 },
  refreshMinutes: Number(process.env.RAIN_REFRESH_MINUTES ?? 30),
  cacheDir: new URL('../cache/', import.meta.url).pathname,
  dataDir: new URL('../data/', import.meta.url).pathname,
  distDir: new URL('../dist/', import.meta.url).pathname,
};
```

`server/routes.ts`:

```ts
import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createRouter(opts: { cacheDir: string; dataDir: string }) {
  const r = Router();
  r.get('/health', (_req, res) => res.json({ ok: true }));

  const serveJson = (path: string, missingStatus: number) => async (_req: any, res: any) => {
    try {
      res.type('json').send(await readFile(path, 'utf8'));
    } catch {
      res.status(missingStatus).json({ error: 'not available yet' });
    }
  };
  r.get('/rain', (req, res) => serveJson(join(opts.cacheDir, 'rain-grid.json'), 503)(req, res));
  r.get('/elevation', (req, res) => serveJson(join(opts.dataDir, 'elevation-grid.json'), 500)(req, res));
  r.get('/reports', (req, res) => serveJson(join(opts.dataDir, 'reports.json'), 500)(req, res));
  return r;
}
```

`server/index.ts`:

```ts
import 'dotenv/config';
import express from 'express';
import { CONFIG } from './config.js';
import { createRouter } from './routes.js';

const app = express();
app.use('/api', createRouter({ cacheDir: CONFIG.cacheDir, dataDir: CONFIG.dataDir }));
app.use(express.static(CONFIG.distDir));

app.listen(CONFIG.port, () => console.log(`server on :${CONFIG.port}`));
```

`web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>上海内涝地图</title>
</head>
<body>
  <div id="map"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

`web/src/main.ts`:

```ts
console.log('typhoon-map frontend loaded');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Smoke-check dev servers**

Run: `npm run dev` briefly; confirm `http://localhost:8787/api/health` returns `{"ok":true}` and `http://localhost:5173` serves the page. Stop it.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts server web tests
git commit -m "feat: scaffold express + vite app with health/data routes"
```

---

### Task 2: Shared types + GCJ-02 transform

**Files:**
- Create: `shared/types.ts`, `web/src/gcj02.ts`
- Test: `tests/gcj02.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `wgs84ToGcj02(lon: number, lat: number): [number, number]`; shared interfaces `RainGrid`, `ElevationGrid`, `Report` (exact shapes below — all later tasks rely on these verbatim).

- [ ] **Step 1: Write shared/types.ts**

```ts
export interface RainGrid {
  fetchedAt: string;          // ISO timestamp of last successful fetch
  lons: number[];             // ascending rain-grid point lons
  lats: number[];             // ascending rain-grid point lats
  hours: string[];            // ISO hour starts, ascending, ~-24h .. +48h
  nowIndex: number;           // index into hours for the current hour
  /** mm/h; indexed [hourIdx][latIdx][lonIdx]; null = missing */
  precip: (number | null)[][][];
}

export interface ElevationGrid {
  lons: number[];             // cell-center lons, ascending
  lats: number[];             // cell-center lats, ascending
  elevation: number[];        // meters, row-major [latIdx * lons.length + lonIdx]
  depression: number[];       // unitless factor >= 0, same indexing
}

export interface Report {
  id: string;
  lon: number;                // WGS-84
  lat: number;
  severity: 1 | 2 | 3;        // 1 = minor, 3 = severe
  title: string;
  source: string;             // e.g. "上海发布"
  url?: string;
  time: string;               // ISO
}
```

- [ ] **Step 2: Write the failing gcj02 test**

`tests/gcj02.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { wgs84ToGcj02 } from '../web/src/gcj02.js';

describe('wgs84ToGcj02', () => {
  it('shifts Shanghai coordinates by a small offset', () => {
    const [glon, glat] = wgs84ToGcj02(121.4737, 31.2304);
    expect(Math.abs(glon - 121.4737)).toBeGreaterThan(0.001);
    expect(Math.abs(glon - 121.4737)).toBeLessThan(0.01);
    expect(Math.abs(glat - 31.2304)).toBeGreaterThan(0.0005);
    expect(Math.abs(glat - 31.2304)).toBeLessThan(0.01);
  });
  it('passes through coordinates outside China unchanged', () => {
    expect(wgs84ToGcj02(-74.006, 40.7128)).toEqual([-74.006, 40.7128]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/gcj02.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the standard transform**

`web/src/gcj02.ts`:

```ts
const a = 6378245.0;
const ee = 0.00669342162296594323;

function outOfChina(lon: number, lat: number) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLon(x: number, y: number) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

export function wgs84ToGcj02(lon: number, lat: number): [number, number] {
  if (outOfChina(lon, lat)) return [lon, lat];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lon + dLon, lat + dLat];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/gcj02.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/types.ts web/src/gcj02.ts tests/gcj02.test.ts
git commit -m "feat: shared data types and WGS-84 to GCJ-02 transform"
```

---

### Task 3: Bilinear rain interpolation

**Files:**
- Create: `web/src/interp.ts`
- Test: `tests/interp.test.ts`

**Interfaces:**
- Consumes: `RainGrid`, `ElevationGrid` from `shared/types.ts`.
- Produces:
  - `precomputeCellWeights(rain: {lons: number[]; lats: number[]}, cells: {lons: number[]; lats: number[]}): CellWeights` where `CellWeights = { idx: Uint32Array; w: Float32Array }` with 4 rain-point flat indices (`latIdx * lons.length + lonIdx`) and 4 weights per cell, cell-major.
  - `rainAtCells(precipHour: (number|null)[][], weights: CellWeights, nRainLons: number): Float32Array` — mm/h per elevation cell; missing rain points are treated as 0.

- [ ] **Step 1: Write the failing test**

`tests/interp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { precomputeCellWeights, rainAtCells } from '../web/src/interp.js';

const rain = { lons: [121.0, 121.1], lats: [31.0, 31.1] };

describe('bilinear interpolation', () => {
  it('returns exact values at rain-grid points', () => {
    const cells = { lons: [121.0], lats: [31.0] };
    const w = precomputeCellWeights(rain, cells);
    // precip[latIdx][lonIdx]: value 5 at (31.0, 121.0)
    const out = rainAtCells([[5, 1], [2, 3]], w, 2);
    expect(out[0]).toBeCloseTo(5);
  });
  it('interpolates midpoints', () => {
    const cells = { lons: [121.05], lats: [31.05] };
    const w = precomputeCellWeights(rain, cells);
    const out = rainAtCells([[0, 0], [4, 4]], w, 2);
    expect(out[0]).toBeCloseTo(2); // halfway between lat rows
  });
  it('clamps cells outside the rain bbox to the edge value', () => {
    const cells = { lons: [120.9], lats: [30.9] };
    const w = precomputeCellWeights(rain, cells);
    const out = rainAtCells([[7, 1], [2, 3]], w, 2);
    expect(out[0]).toBeCloseTo(7);
  });
  it('treats null rain values as 0', () => {
    const cells = { lons: [121.0], lats: [31.0] };
    const w = precomputeCellWeights(rain, cells);
    const out = rainAtCells([[null, 1], [2, 3]], w, 2);
    expect(out[0]).toBeCloseTo(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/interp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`web/src/interp.ts`:

```ts
export interface CellWeights { idx: Uint32Array; w: Float32Array } // 4 entries per cell

function bracket(arr: number[], v: number): [number, number, number] {
  // returns [i0, i1, t] such that arr[i0] <= v <= arr[i1], t in [0,1]; clamped at edges
  if (v <= arr[0]) return [0, 0, 0];
  const last = arr.length - 1;
  if (v >= arr[last]) return [last, last, 0];
  let i = 0;
  while (arr[i + 1] < v) i++;
  return [i, i + 1, (v - arr[i]) / (arr[i + 1] - arr[i])];
}

export function precomputeCellWeights(
  rain: { lons: number[]; lats: number[] },
  cells: { lons: number[]; lats: number[] },
): CellWeights {
  const n = cells.lons.length * cells.lats.length;
  const idx = new Uint32Array(n * 4);
  const w = new Float32Array(n * 4);
  const W = rain.lons.length;
  let c = 0;
  for (const lat of cells.lats) {
    const [y0, y1, ty] = bracket(rain.lats, lat);
    for (const lon of cells.lons) {
      const [x0, x1, tx] = bracket(rain.lons, lon);
      idx[c * 4 + 0] = y0 * W + x0;
      idx[c * 4 + 1] = y0 * W + x1;
      idx[c * 4 + 2] = y1 * W + x0;
      idx[c * 4 + 3] = y1 * W + x1;
      w[c * 4 + 0] = (1 - ty) * (1 - tx);
      w[c * 4 + 1] = (1 - ty) * tx;
      w[c * 4 + 2] = ty * (1 - tx);
      w[c * 4 + 3] = ty * tx;
      c++;
    }
  }
  return { idx, w };
}

export function rainAtCells(
  precipHour: (number | null)[][],
  weights: CellWeights,
  nRainLons: number,
): Float32Array {
  const flat = new Float32Array(precipHour.length * nRainLons);
  for (let y = 0; y < precipHour.length; y++)
    for (let x = 0; x < nRainLons; x++)
      flat[y * nRainLons + x] = precipHour[y][x] ?? 0;
  const n = weights.idx.length / 4;
  const out = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    out[c] =
      flat[weights.idx[c * 4]] * weights.w[c * 4] +
      flat[weights.idx[c * 4 + 1]] * weights.w[c * 4 + 1] +
      flat[weights.idx[c * 4 + 2]] * weights.w[c * 4 + 2] +
      flat[weights.idx[c * 4 + 3]] * weights.w[c * 4 + 3];
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/interp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/interp.ts tests/interp.test.ts
git commit -m "feat: bilinear interpolation of rain grid onto elevation cells"
```

---

### Task 4: Flood bucket model

**Files:**
- Create: `web/src/model.ts`
- Test: `tests/model.test.ts`

**Interfaces:**
- Consumes: `CellWeights`, `rainAtCells` from `web/src/interp.ts`; `RainGrid` from `shared/types.ts`.
- Produces:
  - `RUNOFF = 0.8`, `NOMINAL_DRAIN_MM_PER_HOUR = 10` (exported constants).
  - `computeFloodSeries(rain: RainGrid, weights: CellWeights, depression: number[] | Float32Array, drainageFactor: number): Float32Array[]` — one `Float32Array` of flood index per elevation cell, per hour in `rain.hours`. `floodIndex = water × depression`, with `water[t] = max(0, water[t-1] + rainMm[t] × RUNOFF − NOMINAL_DRAIN_MM_PER_HOUR × drainageFactor)` starting from `water = 0` at the first hour.

- [ ] **Step 1: Write the failing test**

`tests/model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeFloodSeries, NOMINAL_DRAIN_MM_PER_HOUR, RUNOFF } from '../web/src/model.js';
import { precomputeCellWeights } from '../web/src/interp.js';
import type { RainGrid } from '../shared/types.js';

// One rain point, one cell exactly on it: interpolation is identity.
const weights = precomputeCellWeights({ lons: [121], lats: [31] }, { lons: [121], lats: [31] });

function grid(precipPerHour: number[]): RainGrid {
  return {
    fetchedAt: '2026-08-10T00:00:00Z',
    lons: [121], lats: [31],
    hours: precipPerHour.map((_, i) => `2026-08-10T0${i}:00:00Z`),
    nowIndex: 0,
    precip: precipPerHour.map((v) => [[v]]),
  };
}

describe('computeFloodSeries', () => {
  it('accumulates rain minus drainage, never below zero', () => {
    const out = computeFloodSeries(grid([20, 20, 0]), weights, [1], 1);
    const inflow = 20 * RUNOFF; // 16
    expect(out[0][0]).toBeCloseTo(inflow - NOMINAL_DRAIN_MM_PER_HOUR); // 6
    expect(out[1][0]).toBeCloseTo(6 + inflow - NOMINAL_DRAIN_MM_PER_HOUR); // 12
    expect(out[2][0]).toBeCloseTo(2); // 12 - 10, drains toward 0
  });
  it('clamps at zero when drainage exceeds rain', () => {
    const out = computeFloodSeries(grid([5, 0]), weights, [1], 1);
    expect(out[0][0]).toBe(0);
    expect(out[1][0]).toBe(0);
  });
  it('scales water by the depression factor', () => {
    const out = computeFloodSeries(grid([20]), weights, [2], 1);
    expect(out[0][0]).toBeCloseTo((20 * RUNOFF - 10) * 2);
  });
  it('drainageFactor scales drain rate', () => {
    const out = computeFloodSeries(grid([20]), weights, [1], 0.5);
    expect(out[0][0]).toBeCloseTo(20 * RUNOFF - 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`web/src/model.ts`:

```ts
import type { RainGrid } from '../../shared/types.js';
import { rainAtCells, type CellWeights } from './interp.js';

export const RUNOFF = 0.8;
export const NOMINAL_DRAIN_MM_PER_HOUR = 10;

export function computeFloodSeries(
  rain: RainGrid,
  weights: CellWeights,
  depression: number[] | Float32Array,
  drainageFactor: number,
): Float32Array[] {
  const nCells = weights.idx.length / 4;
  const drain = NOMINAL_DRAIN_MM_PER_HOUR * drainageFactor;
  const water = new Float32Array(nCells);
  const out: Float32Array[] = [];
  for (let t = 0; t < rain.hours.length; t++) {
    const rainMm = rainAtCells(rain.precip[t], weights, rain.lons.length);
    const flood = new Float32Array(nCells);
    for (let c = 0; c < nCells; c++) {
      water[c] = Math.max(0, water[c] + rainMm[c] * RUNOFF - drain);
      flood[c] = water[c] * depression[c];
    }
    out.push(flood);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/model.ts tests/model.test.ts
git commit -m "feat: client-side flood bucket model"
```

---

### Task 5: Flood color ramp + canvas drawing

**Files:**
- Create: `web/src/render.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `floodColor(v: number): [number, number, number, number]` — RGBA (alpha 0–255) for a flood-index value.
  - `FLOOD_BANDS = { possible: 5, severe: 30 }` — thresholds used by the legend (Task 9) and popup (Task 10).
  - `drawFloodCanvas(ctx: CanvasRenderingContext2D, flood: Float32Array, w: number, h: number): void` — writes one pixel per cell; **row 0 of the canvas is the northernmost (last) lat row**, i.e. y-flipped relative to the ascending lats array.

**Note for implementer:** invoke the `dataviz` skill before finalizing ramp stop values; the transparent→blue semantics below are a user requirement and must not change, but exact stops may be tuned for legibility.

- [ ] **Step 1: Write the failing test**

`tests/render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { floodColor, FLOOD_BANDS } from '../web/src/render.js';

describe('floodColor', () => {
  it('is fully transparent at zero water', () => {
    expect(floodColor(0)[3]).toBe(0);
  });
  it('gets more opaque and more blue as flooding deepens', () => {
    const low = floodColor(FLOOD_BANDS.possible);
    const high = floodColor(FLOOD_BANDS.severe * 3);
    expect(high[3]).toBeGreaterThan(low[3]);
    expect(low[3]).toBeGreaterThan(0);
    // blue channel dominates red at every level
    expect(low[2]).toBeGreaterThan(low[0]);
    expect(high[2]).toBeGreaterThan(high[0]);
  });
  it('saturates instead of overflowing at extreme values', () => {
    expect(floodColor(10000)[3]).toBeLessThanOrEqual(255);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`web/src/render.ts`:

```ts
export const FLOOD_BANDS = { possible: 5, severe: 30 };

// Piecewise-linear ramp: value (flood index, mm-equivalent) -> [r,g,b,alpha0-255]
const STOPS: [number, [number, number, number, number]][] = [
  [0, [126, 184, 255, 0]],
  [FLOOD_BANDS.possible, [126, 184, 255, 64]],
  [FLOOD_BANDS.severe, [46, 107, 230, 140]],
  [80, [11, 46, 138, 217]],
];

export function floodColor(v: number): [number, number, number, number] {
  if (v <= 0) return [126, 184, 255, 0];
  const last = STOPS[STOPS.length - 1];
  if (v >= last[0]) return [...last[1]];
  let i = 0;
  while (STOPS[i + 1][0] < v) i++;
  const [v0, c0] = STOPS[i];
  const [v1, c1] = STOPS[i + 1];
  const t = (v - v0) / (v1 - v0);
  return [0, 1, 2, 3].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as [number, number, number, number];
}

export function drawFloodCanvas(
  ctx: CanvasRenderingContext2D,
  flood: Float32Array,
  w: number,
  h: number,
): void {
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y; // lats ascend south->north; canvas rows go top->bottom
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = floodColor(flood[srcRow * w + x]);
      const o = (y * w + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/render.ts tests/render.test.ts
git commit -m "feat: transparent-to-blue flood color ramp and canvas renderer"
```

---

### Task 6: Caiyun API client + live probe

**Files:**
- Create: `server/caiyun.ts`, `scripts/probe-caiyun.ts`
- Test: `tests/caiyun.test.ts`

**Interfaces:**
- Consumes: `CAIYUN_API_TOKEN` env var (server-side only).
- Produces: `fetchPointWeather(lon: number, lat: number, token: string, fetchFn?: typeof fetch): Promise<PointWeather>` where

```ts
export interface PointWeather {
  realtimeIntensity: number;                 // mm/h now (radar-based)
  hourly: { datetime: string; value: number }[]; // 48 forecast hours, mm/h
}
```

- [ ] **Step 1: Write the failing test with a mocked fetch**

`tests/caiyun.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchPointWeather } from '../server/caiyun.js';

const fakeResponse = {
  status: 'ok',
  result: {
    realtime: { precipitation: { local: { intensity: 2.5 } } },
    hourly: { precipitation: [{ datetime: '2026-08-10T08:00+08:00', value: 1.2 }] },
  },
};

describe('fetchPointWeather', () => {
  it('extracts realtime intensity and hourly precipitation', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeResponse });
    const out = await fetchPointWeather(121.47, 31.23, 'TOKEN', fetchFn as any);
    expect(out.realtimeIntensity).toBe(2.5);
    expect(out.hourly[0]).toEqual({ datetime: '2026-08-10T08:00+08:00', value: 1.2 });
    const url = (fetchFn.mock.calls[0][0] as string);
    expect(url).toContain('/TOKEN/121.47,31.23/weather');
    expect(url).toContain('hourlysteps=48');
  });
  it('throws on non-ok API status', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'failed', error: 'quota' }) });
    await expect(fetchPointWeather(121, 31, 'T', fetchFn as any)).rejects.toThrow(/quota/);
  });
  it('throws on HTTP error', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(fetchPointWeather(121, 31, 'T', fetchFn as any)).rejects.toThrow(/429/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/caiyun.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement client + probe script**

`server/caiyun.ts`:

```ts
export interface PointWeather {
  realtimeIntensity: number;
  hourly: { datetime: string; value: number }[];
}

export async function fetchPointWeather(
  lon: number,
  lat: number,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<PointWeather> {
  const url = `https://api.caiyunapp.com/v2.6/${token}/${lon},${lat}/weather?hourlysteps=48&unit=metric:v2`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`caiyun HTTP ${res.status}`);
  const body: any = await res.json();
  if (body.status !== 'ok') throw new Error(`caiyun API error: ${body.error ?? body.status}`);
  return {
    realtimeIntensity: body.result.realtime.precipitation.local.intensity,
    hourly: body.result.hourly.precipitation.map((p: any) => ({ datetime: p.datetime, value: p.value })),
  };
}
```

`scripts/probe-caiyun.ts`:

```ts
import 'dotenv/config';
import { fetchPointWeather } from '../server/caiyun.js';

const token = process.env.CAIYUN_API_TOKEN;
if (!token) throw new Error('CAIYUN_API_TOKEN missing from .env');
const out = await fetchPointWeather(121.4737, 31.2304, token);
console.log('realtime mm/h:', out.realtimeIntensity);
console.log('first 3 hourly:', out.hourly.slice(0, 3));
console.log('hourly count:', out.hourly.length);
```

- [ ] **Step 4: Run tests, then the live probe**

Run: `npx vitest run tests/caiyun.test.ts` → Expected: PASS.
Run: `npm run probe` → Expected: prints a real intensity number and 48 hourly entries. **If the response shape differs from the mocked one (e.g. `precipitation.local.intensity` path is different in v2.6), fix `server/caiyun.ts` AND the test fixture to match reality, and note the correction in the commit message.**

- [ ] **Step 5: Commit**

```bash
git add server/caiyun.ts scripts/probe-caiyun.ts tests/caiyun.test.ts
git commit -m "feat: caiyun weather client, verified against live API"
```

---

### Task 7: Grid fetcher with cache merge + wire into server

**Files:**
- Create: `server/fetcher.ts`
- Modify: `server/index.ts`
- Test: `tests/fetcher.test.ts`

**Interfaces:**
- Consumes: `fetchPointWeather`, `PointWeather` from `server/caiyun.ts`; `CONFIG` from `server/config.ts`; `RainGrid` from `shared/types.ts`.
- Produces:
  - `gridAxes(cfg: {bbox: {lonMin:number;lonMax:number;latMin:number;latMax:number}, rainStep: {lon:number;lat:number}}): { lons: number[]; lats: number[] }` — inclusive of both ends.
  - `mergeRainCache(old: RainGrid | null, results: (PointWeather | null)[][], axes: {lons:number[];lats:number[]}, now: Date): RainGrid` — pure. `results` is `[latIdx][lonIdx]`, `null` = that point's fetch failed this sweep.
  - `startFetcherLoop(): void` — used by `server/index.ts`; runs a sweep immediately, then every `CONFIG.refreshMinutes`.

Merge rules (implement exactly):
1. Hours window = every whole hour from `now − 24h` to `now + 48h` (UTC hour starts). `nowIndex` points at the hour containing `now`.
2. New forecast hours (from `hourly`) fill their hour slots for that point.
3. The current hour slot for a point is overwritten with `realtimeIntensity` (radar now-cast beats forecast).
4. Hours in the window not covered by this sweep (i.e. past hours) take their value from `old` at the same ISO hour, if present — this is how self-accumulated history builds up.
5. A point whose fetch failed keeps `old`'s values for all hours where available, else `null`.
6. `fetchedAt = now.toISOString()` only if at least one point succeeded; otherwise return `old` unchanged (caller then skips the cache write).

- [ ] **Step 1: Write the failing tests**

`tests/fetcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { gridAxes, mergeRainCache } from '../server/fetcher.js';
import type { PointWeather } from '../server/caiyun.js';
import type { RainGrid } from '../shared/types.js';

const axes = { lons: [121.0], lats: [31.0] };
const now = new Date('2026-08-10T06:30:00Z');
const hourIso = (d: string) => new Date(d).toISOString();

function pw(realtime: number, hourlyValue: number): PointWeather {
  return {
    realtimeIntensity: realtime,
    hourly: Array.from({ length: 48 }, (_, i) => ({
      datetime: new Date(Date.UTC(2026, 7, 10, 6 + i)).toISOString(),
      value: hourlyValue,
    })),
  };
}

describe('gridAxes', () => {
  it('builds inclusive axes from bbox and step', () => {
    const a = gridAxes({ bbox: { lonMin: 121.2, lonMax: 121.8, latMin: 30.95, latMax: 31.45 }, rainStep: { lon: 0.045, lat: 0.04 } });
    expect(a.lons[0]).toBeCloseTo(121.2);
    expect(a.lons[a.lons.length - 1]).toBeGreaterThanOrEqual(121.755);
    expect(a.lats.length).toBeGreaterThan(10);
    expect(a.lons.length * a.lats.length).toBeGreaterThan(150);
    expect(a.lons.length * a.lats.length).toBeLessThan(300);
  });
});

describe('mergeRainCache', () => {
  it('spans -24h..+48h with nowIndex at the current hour', () => {
    const g = mergeRainCache(null, [[pw(3, 1)]], axes, now);
    expect(g.hours.length).toBe(73);
    expect(g.hours[g.nowIndex]).toBe(hourIso('2026-08-10T06:00:00Z'));
    expect(g.hours[0]).toBe(hourIso('2026-08-09T06:00:00Z'));
  });
  it('uses realtime intensity for the current hour and forecast after', () => {
    const g = mergeRainCache(null, [[pw(3, 1)]], axes, now);
    expect(g.precip[g.nowIndex][0][0]).toBe(3);
    expect(g.precip[g.nowIndex + 1][0][0]).toBe(1);
  });
  it('retains past hours from the old cache', () => {
    const old = mergeRainCache(null, [[pw(9, 1)]], axes, new Date('2026-08-10T04:30:00Z'));
    const g = mergeRainCache(old, [[pw(3, 1)]], axes, now);
    const oldHourIdx = g.hours.indexOf(hourIso('2026-08-10T04:00:00Z'));
    expect(g.precip[oldHourIdx][0][0]).toBe(9); // the realtime value stored 2h ago survives
  });
  it('keeps old values for a point whose fetch failed, and returns old unchanged when all fail', () => {
    const old = mergeRainCache(null, [[pw(9, 1)]], axes, new Date('2026-08-10T04:30:00Z'));
    const g = mergeRainCache(old, [[null]], axes, now);
    expect(g).toBe(old);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fetcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement fetcher**

`server/fetcher.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from './config.js';
import { fetchPointWeather, type PointWeather } from './caiyun.js';
import type { RainGrid } from '../shared/types.js';

export function gridAxes(cfg: {
  bbox: { lonMin: number; lonMax: number; latMin: number; latMax: number };
  rainStep: { lon: number; lat: number };
}) {
  const axis = (min: number, max: number, step: number) => {
    const out: number[] = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(4)));
    return out;
  };
  return {
    lons: axis(cfg.bbox.lonMin, cfg.bbox.lonMax, cfg.rainStep.lon),
    lats: axis(cfg.bbox.latMin, cfg.bbox.latMax, cfg.rainStep.lat),
  };
}

const hourStart = (d: Date) => {
  const h = new Date(d);
  h.setUTCMinutes(0, 0, 0);
  return h;
};

export function mergeRainCache(
  old: RainGrid | null,
  results: (PointWeather | null)[][],
  axes: { lons: number[]; lats: number[] },
  now: Date,
): RainGrid {
  if (!results.flat().some((r) => r !== null)) return old ?? emptyGrid(axes, now);
  const start = hourStart(new Date(now.getTime() - 24 * 3600_000));
  const hours: string[] = [];
  for (let i = 0; i <= 72; i++) hours.push(new Date(start.getTime() + i * 3600_000).toISOString());
  const nowIso = hourStart(now).toISOString();
  const nowIndex = hours.indexOf(nowIso);

  const oldHourIdx = new Map<string, number>();
  old?.hours.forEach((h, i) => oldHourIdx.set(h, i));

  const precip: (number | null)[][][] = hours.map((h, t) =>
    axes.lats.map((_, y) =>
      axes.lons.map((_, x) => {
        const point = results[y][x];
        if (point) {
          if (t === nowIndex) return point.realtimeIntensity;
          const fc = point.hourly.find((p) => hourStart(new Date(p.datetime)).toISOString() === h);
          if (fc && t > nowIndex) return fc.value;
        }
        const oi = oldHourIdx.get(h);
        if (old && oi !== undefined) return old.precip[oi][y][x];
        return point && t > nowIndex ? 0 : null;
      }),
    ),
  );
  return { fetchedAt: now.toISOString(), lons: axes.lons, lats: axes.lats, hours, nowIndex, precip };
}

function emptyGrid(axes: { lons: number[]; lats: number[] }, now: Date): RainGrid {
  return { fetchedAt: now.toISOString(), lons: axes.lons, lats: axes.lats, hours: [], nowIndex: 0, precip: [] };
}

const CACHE_FILE = () => join(CONFIG.cacheDir, 'rain-grid.json');

async function readCache(): Promise<RainGrid | null> {
  try { return JSON.parse(await readFile(CACHE_FILE(), 'utf8')); } catch { return null; }
}

async function sweep(): Promise<void> {
  const token = process.env.CAIYUN_API_TOKEN;
  if (!token) { console.warn('CAIYUN_API_TOKEN missing; fetcher idle'); return; }
  const axes = gridAxes(CONFIG);
  const results: (PointWeather | null)[][] = [];
  for (const lat of axes.lats) {
    const row: (PointWeather | null)[] = [];
    for (const lon of axes.lons) {
      try {
        row.push(await fetchPointWeather(lon, lat, token));
      } catch (e) {
        console.error(`fetch failed @${lon},${lat}:`, (e as Error).message);
        row.push(null);
      }
      await new Promise((r) => setTimeout(r, 120)); // stagger to be gentle on rate limits
    }
    results.push(row);
  }
  const old = await readCache();
  const merged = mergeRainCache(old, results, axes, new Date());
  if (merged !== old) {
    await mkdir(CONFIG.cacheDir, { recursive: true });
    await writeFile(CACHE_FILE(), JSON.stringify(merged));
    console.log(`rain cache updated ${merged.fetchedAt} (${axes.lons.length * axes.lats.length} pts)`);
  } else {
    console.error('sweep failed entirely; serving stale cache');
  }
}

export function startFetcherLoop(): void {
  sweep().catch((e) => console.error('sweep error:', e));
  setInterval(() => sweep().catch((e) => console.error('sweep error:', e)), CONFIG.refreshMinutes * 60_000);
}
```

Modify `server/index.ts` — add after the imports and before `app.listen`:

```ts
import { startFetcherLoop } from './fetcher.js';
// ...
startFetcherLoop();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/fetcher.test.ts` → Expected: PASS.
Run: `npx vitest run` → Expected: all suites PASS.

- [ ] **Step 5: One live sweep sanity check**

Run: `npm run start` for ~2 minutes (a full sweep of ~180 points at 120 ms stagger takes ~40 s plus API latency), then `curl -s localhost:8787/api/rain | head -c 400`. Expected: JSON starting with `{"fetchedAt":"2026-...` and `hours` of length 73. Stop the server. If Caiyun returns quota errors, confirm the stale-cache path logs correctly and note the observed quota in the commit message.

- [ ] **Step 6: Commit**

```bash
git add server/fetcher.ts server/index.ts tests/fetcher.test.ts
git commit -m "feat: staggered caiyun grid fetcher with history-retaining cache merge"
```

---

### Task 8: Elevation grid preprocessing (DEM → JSON)

**Files:**
- Create: `scripts/tpi.ts`, `scripts/build-elevation-grid.ts`, `data/reports.json`
- Test: `tests/tpi.test.ts`
- Generates: `data/elevation-grid.json` (committed)

**Interfaces:**
- Consumes: `ElevationGrid` from `shared/types.ts`; Copernicus GLO-30 DEM public COGs on AWS S3.
- Produces:
  - `computeDepression(elev: Float32Array, w: number, h: number, radius: number): Float32Array` from `scripts/tpi.ts` — `depression[i] = clamp(1 + 0.6 × (meanNeighborhood − elev[i]), 0.2, 3)`, neighborhood = square box of `±radius` cells (clipped at edges).
  - `data/elevation-grid.json` matching `ElevationGrid` with 0.003°×0.0025° cell centers spanning the bbox.
  - `data/reports.json` containing `[]`.

- [ ] **Step 1: Write the failing TPI test**

`tests/tpi.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeDepression } from '../scripts/tpi.js';

describe('computeDepression', () => {
  it('is 1.0 on perfectly flat ground', () => {
    const flat = new Float32Array(9).fill(4);
    const d = computeDepression(flat, 3, 3, 1);
    expect(d[4]).toBeCloseTo(1.0);
  });
  it('exceeds 1 in a hollow and is below 1 on a mound', () => {
    // center cell 2m below its ring vs 2m above
    const hollow = new Float32Array([4, 4, 4, 4, 2, 4, 4, 4, 4]);
    const mound = new Float32Array([4, 4, 4, 4, 6, 4, 4, 4, 4]);
    expect(computeDepression(hollow, 3, 3, 1)[4]).toBeGreaterThan(1);
    expect(computeDepression(mound, 3, 3, 1)[4]).toBeLessThan(1);
  });
  it('clamps to [0.2, 3]', () => {
    const extreme = new Float32Array([50, 50, 50, 50, 0, 50, 50, 50, 50]);
    expect(computeDepression(extreme, 3, 3, 1)[4]).toBe(3);
    const ridge = new Float32Array([0, 0, 0, 0, 50, 0, 0, 0, 0]);
    expect(computeDepression(ridge, 3, 3, 1)[4]).toBe(0.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tpi.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TPI**

`scripts/tpi.ts`:

```ts
export function computeDepression(elev: Float32Array, w: number, h: number, radius: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          sum += elev[yy * w + xx];
          n++;
        }
      }
      const tpi = sum / n - elev[y * w + x];
      out[y * w + x] = Math.min(3, Math.max(0.2, 1 + 0.6 * tpi));
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tpi.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the build script**

`scripts/build-elevation-grid.ts`:

```ts
import { writeFile } from 'node:fs/promises';
import { fromUrl } from 'geotiff';
import { computeDepression } from './tpi.js';
import type { ElevationGrid } from '../shared/types.js';

const BBOX = { lonMin: 121.2, lonMax: 121.8, latMin: 30.95, latMax: 31.45 };
const STEP = { lon: 0.003, lat: 0.0025 };
const TPI_RADIUS = 4; // ~1.1km neighborhood at ~280m cells

// Copernicus GLO-30 public COGs; tile named by its SW corner, 1°x1°.
const tileUrl = (latSW: number, lonSW: number) => {
  const name = `Copernicus_DSM_COG_10_N${latSW}_00_E${String(lonSW).padStart(3, '0')}_00_DEM`;
  return `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
};

async function loadTile(latSW: number, lonSW: number) {
  const tiff = await fromUrl(tileUrl(latSW, lonSW));
  const image = await tiff.getImage();
  const raster = (await image.readRasters({ interleave: true })) as Float32Array;
  const [ox, oy] = image.getOrigin();          // top-left lon, lat
  const [rx, ry] = image.getResolution();      // ry is negative
  const width = image.getWidth();
  return { raster, ox, oy, rx, ry, width, height: image.getHeight() };
}

function sample(t: Awaited<ReturnType<typeof loadTile>>, lon: number, lat: number): number {
  const px = Math.min(t.width - 1, Math.max(0, Math.round((lon - t.ox) / t.rx)));
  const py = Math.min(t.height - 1, Math.max(0, Math.round((lat - t.oy) / t.ry)));
  return t.raster[py * t.width + px];
}

const lons: number[] = [];
for (let v = BBOX.lonMin; v <= BBOX.lonMax + 1e-9; v += STEP.lon) lons.push(Number(v.toFixed(5)));
const lats: number[] = [];
for (let v = BBOX.latMin; v <= BBOX.latMax + 1e-9; v += STEP.lat) lats.push(Number(v.toFixed(5)));

console.log(`grid ${lons.length} x ${lats.length}; downloading DEM tiles...`);
const tiles = { 30: await loadTile(30, 121), 31: await loadTile(31, 121) };

const elev = new Float32Array(lons.length * lats.length);
lats.forEach((lat, y) => {
  const tile = lat < 31 ? tiles[30] : tiles[31];
  lons.forEach((lon, x) => {
    elev[y * lons.length + x] = sample(tile, lon, lat);
  });
});

const depression = computeDepression(elev, lons.length, lats.length, TPI_RADIUS);
const grid: ElevationGrid = {
  lons, lats,
  elevation: Array.from(elev, (v) => Number(v.toFixed(1))),
  depression: Array.from(depression, (v) => Number(v.toFixed(2))),
};
await writeFile(new URL('../data/elevation-grid.json', import.meta.url), JSON.stringify(grid));
console.log(`wrote data/elevation-grid.json (${lons.length * lats.length} cells)`);
```

Also create `data/reports.json` containing exactly:

```json
[]
```

- [ ] **Step 6: Run the build script and sanity-check output**

Run: `mkdir -p data && npm run build-elevation`
Expected: logs `grid 201 x 201` (±1) and writes the file. Then run:

```bash
node -e "const g=require('./data/elevation-grid.json'); const e=g.elevation; console.log('cells', e.length, 'min', Math.min(...e), 'max', Math.max(...e))"
```

Expected: ~40k cells; min ≥ −5 and max ≤ 40 (central Shanghai is roughly 2–6 m elevation; small negatives near water are fine). If values look like nodata sentinels (e.g. −9999), filter them to 0 in the script and re-run.

- [ ] **Step 7: Commit (including the generated data)**

```bash
git add scripts/tpi.ts scripts/build-elevation-grid.ts tests/tpi.test.ts data/elevation-grid.json data/reports.json
git commit -m "feat: elevation grid with depression factor from Copernicus GLO-30 DEM"
```

---

### Task 9: Map page with flood overlay (synthetic data first, then real)

**Files:**
- Create: `web/src/mapview.ts`, `web/src/api.ts`, `web/src/strings.ts`, `web/src/style.css`
- Modify: `web/index.html`, `web/src/main.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5 and 8: `wgs84ToGcj02`, `precomputeCellWeights`, `computeFloodSeries`, `drawFloodCanvas`, `floodColor`, `FLOOD_BANDS`, `/api/rain`, `/api/elevation`, `/api/reports`, types from `shared/types.ts`.
- Produces:
  - `initMap(container: HTMLElement, elevGrid: ElevationGrid): { map: maplibregl.Map; canvas: HTMLCanvasElement; repaint(): void }` from `mapview.ts` — creates the MapLibre map with AMap raster tiles and a `canvas` source whose corners are the elevation-grid bbox corners run through `wgs84ToGcj02`.
  - `fetchRain(): Promise<RainGrid>`, `fetchElevation(): Promise<ElevationGrid>`, `fetchReports(): Promise<Report[]>` from `api.ts` (throw on non-2xx).
  - `t(key: string): string`, `setLang(lang: 'zh' | 'en'): void`, `getLang(): 'zh' | 'en'` from `strings.ts`.

**Note for implementer:** this task builds visible UI — invoke the `frontend-design` skill and the `dataviz` skill (legend/sliders are data-adjacent UI) before writing the HTML/CSS.

- [ ] **Step 1: Strings module**

`web/src/strings.ts`:

```ts
const dict = {
  zh: {
    title: '上海内涝地图',
    drainage: '排水效率',
    drainageHint: '拖动模拟排水系统好坏',
    now: '现在',
    estimated: '过去（估计）',
    predicted: '未来（预测）',
    bandNone: '无明显积水',
    bandPossible: '可能积水',
    bandSevere: '严重积水',
    legendDisclaimer: '模型估算，非实测数据',
    updatedAt: '数据更新于',
    loading: '数据加载中…',
    noData: '暂无降雨数据，请稍后刷新',
    reports: '积水报告',
    langToggle: 'EN',
  },
  en: {
    title: 'Shanghai Flood Map',
    drainage: 'Drainage efficiency',
    drainageHint: 'Drag to simulate drainage quality',
    now: 'Now',
    estimated: 'Past (estimated)',
    predicted: 'Future (predicted)',
    bandNone: 'No significant water',
    bandPossible: 'Possible flooding',
    bandSevere: 'Severe flooding',
    legendDisclaimer: 'Model estimate, not measurements',
    updatedAt: 'Data updated',
    loading: 'Loading…',
    noData: 'No rain data yet, refresh later',
    reports: 'Flood reports',
    langToggle: '中文',
  },
} as const;

export type Lang = 'zh' | 'en';
let lang: Lang = (localStorage.getItem('lang') as Lang) || 'zh';
export const getLang = () => lang;
export function setLang(l: Lang) { lang = l; localStorage.setItem('lang', l); }
export function t(key: keyof typeof dict['zh']): string { return dict[lang][key]; }
```

- [ ] **Step 2: API module**

`web/src/api.ts`:

```ts
import type { RainGrid, ElevationGrid, Report } from '../../shared/types.js';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
export const fetchRain = () => getJson<RainGrid>('/api/rain');
export const fetchElevation = () => getJson<ElevationGrid>('/api/elevation');
export const fetchReports = () => getJson<Report[]>('/api/reports');
```

- [ ] **Step 3: Map view with canvas source**

`web/src/mapview.ts`:

```ts
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { wgs84ToGcj02 } from './gcj02.js';
import type { ElevationGrid } from '../../shared/types.js';

const AMAP_TILES = [1, 2, 3, 4].map(
  (i) => `https://webrd0${i}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`,
);

export function initMap(container: HTMLElement, elev: ElevationGrid) {
  const map = new maplibregl.Map({
    container,
    center: wgs84ToGcj02(121.47, 31.23),
    zoom: 10,
    style: {
      version: 8,
      sources: { base: { type: 'raster', tiles: AMAP_TILES, tileSize: 256, attribution: '© 高德地图' } },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    },
  });

  const canvas = document.createElement('canvas');
  canvas.width = elev.lons.length;
  canvas.height = elev.lats.length;

  const dLon = elev.lons[1] - elev.lons[0];
  const dLat = elev.lats[1] - elev.lats[0];
  const w = elev.lons[0] - dLon / 2, e = elev.lons[elev.lons.length - 1] + dLon / 2;
  const s = elev.lats[0] - dLat / 2, n = elev.lats[elev.lats.length - 1] + dLat / 2;

  map.on('load', () => {
    map.addSource('flood', {
      type: 'canvas',
      canvas,
      animate: false,
      coordinates: [wgs84ToGcj02(w, n), wgs84ToGcj02(e, n), wgs84ToGcj02(e, s), wgs84ToGcj02(w, s)],
    });
    map.addLayer({ id: 'flood', type: 'raster', source: 'flood', paint: { 'raster-resampling': 'linear' } });
  });

  return { map, canvas, repaint: () => map.triggerRepaint() };
}
```

- [ ] **Step 4: Page shell, styles, bootstrap with a SYNTHETIC flood field**

Replace `web/index.html` body content:

```html
<body>
  <div id="map"></div>
  <div id="panel">
    <h1 data-s="title"></h1>
    <label><span data-s="drainage"></span>
      <input id="drainage" type="range" min="0.2" max="2" step="0.1" value="1" />
    </label>
    <p class="hint" data-s="drainageHint"></p>
    <div id="legend"></div>
    <p class="hint" data-s="legendDisclaimer"></p>
    <p id="freshness"></p>
    <button id="lang"></button>
  </div>
  <div id="timebar">
    <input id="time" type="range" />
    <div id="timelabel"></div>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
```

`web/src/style.css` (imported from main.ts):

```css
html, body, #map { height: 100%; margin: 0; }
#panel {
  position: absolute; top: 12px; left: 12px; z-index: 2;
  background: rgba(255, 255, 255, 0.92); border-radius: 8px; padding: 12px 16px;
  font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  max-width: 260px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
#panel h1 { font-size: 16px; margin: 0 0 8px; }
.hint { font-size: 12px; color: #666; margin: 4px 0; }
#timebar {
  position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
  z-index: 2; width: min(640px, 90vw); background: rgba(255, 255, 255, 0.92);
  border-radius: 8px; padding: 8px 16px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  font-family: system-ui, sans-serif;
}
#time { width: 100%; }
#timelabel { text-align: center; font-size: 13px; }
#legend div { display: flex; align-items: center; gap: 6px; font-size: 12px; }
#legend i { width: 18px; height: 12px; display: inline-block; border-radius: 2px; }
```

`web/src/main.ts` (this task renders a synthetic field to prove the overlay pipeline; Task 10 replaces it with real data):

```ts
import './style.css';
import { initMap } from './mapview.js';
import { drawFloodCanvas, floodColor, FLOOD_BANDS } from './render.js';
import { fetchElevation } from './api.js';
import { t, getLang, setLang } from './strings.js';

function applyStrings() {
  document.querySelectorAll<HTMLElement>('[data-s]').forEach((el) => {
    el.textContent = t(el.dataset.s as any);
  });
  document.getElementById('lang')!.textContent = t('langToggle');
  const legend = document.getElementById('legend')!;
  legend.innerHTML = '';
  for (const [label, v] of [
    ['bandNone', 0], ['bandPossible', FLOOD_BANDS.possible], ['bandSevere', FLOOD_BANDS.severe],
  ] as const) {
    const [r, g, b, a] = floodColor(v + 1);
    legend.insertAdjacentHTML(
      'beforeend',
      `<div><i style="background: rgba(${r},${g},${b},${a / 255})"></i>${t(label)}</div>`,
    );
  }
}

const elev = await fetchElevation();
const { canvas, repaint } = initMap(document.getElementById('map')!, elev);

// Synthetic field: flood proportional to depression factor, to visually verify
// alignment and the transparent-to-blue ramp. Replaced with the real model in the next task.
const synthetic = Float32Array.from(elev.depression, (d) => (d - 0.9) * 60);
drawFloodCanvas(canvas.getContext('2d')!, synthetic, elev.lons.length, elev.lats.length);
repaint();

applyStrings();
document.getElementById('lang')!.addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
  applyStrings();
});
```

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, open `http://localhost:5173`. Verify: AMap tiles load with Chinese labels; a blue-tinted overlay appears over central Shanghai showing spatial variation (depressions bluer); overlay edges align with the bbox (Huangpu River bends should line up with the basemap — this validates the GCJ-02 corner transform); panel and legend show Chinese, and the EN button switches languages. Take a screenshot for the task record. Stop the server.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: all PASS (no new tests in this task; confirms no regressions).

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "feat: maplibre map with AMap tiles and canvas flood overlay (synthetic field)"
```

---

### Task 10: Real data wiring — time slider, drainage slider, freshness

**Files:**
- Modify: `web/src/main.ts`

**Interfaces:**
- Consumes: `fetchRain`, `computeFloodSeries`, `precomputeCellWeights`, `drawFloodCanvas`, `t`; all shapes as defined in earlier tasks.
- Produces: fully interactive map. No new exports.

- [ ] **Step 1: Replace the synthetic block in `web/src/main.ts`**

Replace everything below `applyStrings` definition with:

```ts
import { fetchRain } from './api.js';               // move to top imports
import { precomputeCellWeights } from './interp.js'; // move to top imports
import { computeFloodSeries } from './model.js';     // move to top imports

const freshness = document.getElementById('freshness')!;
freshness.textContent = t('loading');

const elev = await fetchElevation();
const { canvas, repaint } = initMap(document.getElementById('map')!, elev);
const ctx = canvas.getContext('2d')!;
applyStrings();

const timeInput = document.getElementById('time') as HTMLInputElement;
const drainInput = document.getElementById('drainage') as HTMLInputElement;
const timeLabel = document.getElementById('timelabel')!;

try {
  const rain = await fetchRain();
  const weights = precomputeCellWeights(rain, elev);
  let series = computeFloodSeries(rain, weights, elev.depression, Number(drainInput.value));

  timeInput.min = '0';
  timeInput.max = String(rain.hours.length - 1);
  timeInput.value = String(rain.nowIndex);

  const draw = () => {
    const ti = Number(timeInput.value);
    drawFloodCanvas(ctx, series[ti], elev.lons.length, elev.lats.length);
    repaint();
    const d = new Date(rain.hours[ti]);
    const rel = ti - rain.nowIndex;
    const relText = rel === 0 ? t('now') : `${rel > 0 ? '+' : ''}${rel}h`;
    const mode = rel < 0 ? t('estimated') : rel > 0 ? t('predicted') : '';
    timeLabel.textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00 (${relText}) ${mode}`;
  };

  timeInput.addEventListener('input', draw);
  drainInput.addEventListener('input', () => {
    series = computeFloodSeries(rain, weights, elev.depression, Number(drainInput.value));
    draw();
  });

  const f = new Date(rain.fetchedAt);
  freshness.textContent = `${t('updatedAt')} ${String(f.getHours()).padStart(2, '0')}:${String(f.getMinutes()).padStart(2, '0')}`;
  draw();
} catch {
  freshness.textContent = t('noData');
}
```

(Keep the language-toggle listener; after `setLang`, call `applyStrings()` — freshness/time labels re-render on next interaction, which is acceptable for v1.)

- [ ] **Step 2: Manual verification**

Run: `npm run dev` (server must have completed at least one sweep — check `cache/rain-grid.json` exists; if the day is dry, temporarily multiply `rainMm[c]` by 10 in the console via the drainage slider at 0.2 to see accumulation, or verify the overlay is correctly fully transparent). Verify: time slider moves through 73 hours with correct labels (过去（估计）/未来（预测）); drainage slider visibly changes flood extent within ~100 ms; freshness timestamp shows.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/main.ts
git commit -m "feat: wire real rain data with time and drainage sliders"
```

---

### Task 11: Click popup with local curve + reports layer

**Files:**
- Modify: `web/src/mapview.ts`, `web/src/main.ts`
- Test: no new unit tests (DOM/canvas glue); full suite must stay green.

**Interfaces:**
- Consumes: `Report` from `shared/types.ts`; `fetchReports` from `api.ts`; `FLOOD_BANDS` from `render.ts`; `series`/`rain`/`elev` state from `main.ts`.
- Produces:
  - `addReports(map: maplibregl.Map, reports: Report[]): void` in `mapview.ts` — one `maplibregl.Marker` per report at `wgs84ToGcj02(lon, lat)`, popup shows title, source (linked if `url`), and local time.
  - `showCellPopup(map, gcjLngLat, series, hours, nowIndex, cellIdx): void` in `mapview.ts` — popup containing a 240×80 canvas sparkline of the flood index across all hours with a vertical "now" line, plus the current band label.

- [ ] **Step 1: Implement `addReports` and `showCellPopup` in `mapview.ts`**

Append:

```ts
import type { Report } from '../../shared/types.js';
import { FLOOD_BANDS } from './render.js';
import { t } from './strings.js';

export function addReports(map: maplibregl.Map, reports: Report[]) {
  for (const rep of reports) {
    const [lng, lat] = wgs84ToGcj02(rep.lon, rep.lat);
    const link = rep.url ? `<a href="${rep.url}" target="_blank" rel="noopener">${rep.source}</a>` : rep.source;
    new maplibregl.Marker({ color: ['#7EB8FF', '#2E6BE6', '#0B2E8A'][rep.severity - 1] })
      .setLngLat([lng, lat])
      .setPopup(new maplibregl.Popup().setHTML(
        `<strong>${rep.title}</strong><br>${link} · ${new Date(rep.time).toLocaleString()}`,
      ))
      .addTo(map);
  }
}

export function showCellPopup(
  map: maplibregl.Map,
  gcjLngLat: { lng: number; lat: number },
  series: Float32Array[],
  hours: string[],
  nowIndex: number,
  cellIdx: number,
) {
  const cv = document.createElement('canvas');
  cv.width = 240; cv.height = 80;
  const ctx = cv.getContext('2d')!;
  const values = series.map((s) => s[cellIdx]);
  const max = Math.max(FLOOD_BANDS.severe, ...values);
  ctx.strokeStyle = '#2E6BE6';
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * 240;
    const y = 78 - (v / max) * 70;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  const nx = (nowIndex / (values.length - 1)) * 240;
  ctx.strokeStyle = '#999';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(nx, 0); ctx.lineTo(nx, 80); ctx.stroke();

  const nowV = values[nowIndex];
  const band = nowV >= FLOOD_BANDS.severe ? t('bandSevere') : nowV >= FLOOD_BANDS.possible ? t('bandPossible') : t('bandNone');
  const wrap = document.createElement('div');
  wrap.append(Object.assign(document.createElement('div'), { textContent: band, style: 'font-weight:600' }), cv);
  new maplibregl.Popup().setLngLat(gcjLngLat).setDOMContent(wrap).addTo(map);
}
```

- [ ] **Step 2: Wire into `main.ts`**

Inside the `try` block of Task 10's code, after `draw()` wiring, add:

```ts
import { addReports, showCellPopup } from './mapview.js'; // move to top imports
import { fetchReports } from './api.js';                  // move to top imports
import { wgs84ToGcj02 } from './gcj02.js';                // move to top imports

fetchReports().then((reports) => addReports(mapHandle.map, reports)).catch(() => {});

mapHandle.map.on('click', (ev) => {
  // Invert: find nearest elevation cell. GCJ-02 offset in Shanghai is a few hundred
  // meters; for cell lookup (~280 m cells) invert by subtracting the local offset.
  const [glon, glat] = [ev.lngLat.lng, ev.lngLat.lat];
  const [glon2, glat2] = wgs84ToGcj02(glon, glat);
  const wlon = glon - (glon2 - glon); // first-order inverse
  const wlat = glat - (glat2 - glat);
  const xi = Math.round((wlon - elev.lons[0]) / (elev.lons[1] - elev.lons[0]));
  const yi = Math.round((wlat - elev.lats[0]) / (elev.lats[1] - elev.lats[0]));
  if (xi < 0 || xi >= elev.lons.length || yi < 0 || yi >= elev.lats.length) return;
  showCellPopup(mapHandle.map, ev.lngLat, series, rain.hours, rain.nowIndex, yi * elev.lons.length + xi);
});
```

(Rename the `initMap` result variable to `mapHandle` throughout `main.ts` so `mapHandle.map` is available.)

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. Add one temporary entry to `data/reports.json`:

```json
[{"id": "t1", "lon": 121.4737, "lat": 31.2304, "severity": 2, "title": "测试:人民广场积水", "source": "上海发布", "time": "2026-08-10T06:00:00Z"}]
```

Verify: a blue marker appears at People's Square (aligned with the basemap label — validates report GCJ-02 conversion); clicking it shows the popup; clicking anywhere on the map shows the sparkline popup with a dashed "now" line and a band label. Revert `data/reports.json` to `[]`.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/mapview.ts web/src/main.ts
git commit -m "feat: click popup with local flood curve and curated reports layer"
```

---

### Task 12: Production build, README, final verification

**Files:**
- Create: `README.md`
- Test: full suite + production smoke test.

**Interfaces:**
- Consumes: everything.
- Produces: deployable app; `npm run build && npm start` serves the full site on `:8787`.

- [ ] **Step 1: Production smoke test**

```bash
npm run build
npm start
```

Open `http://localhost:8787` (no Vite). Verify the map, sliders, and popups all work served from `dist/`. Stop the server.

- [ ] **Step 2: Write README.md**

```markdown
# 上海内涝地图 · Shanghai Flood Map

Estimates street flooding in central Shanghai by combining Caiyun rainfall
data with terrain (Copernicus GLO-30). Flood levels are **model estimates,
not measurements**.

## Run

    npm install
    echo "CAIYUN_API_TOKEN=..." > .env
    npm run dev        # dev: vite on :5173, api on :8787

Production: `npm run build && npm start` → everything on :8787.

The rain cache fills on first fetch (~1 min); the −24h history window
self-accumulates over the first day of uptime.

## Deploy

Any Node 20+ host (Render/Fly free tiers work): build command
`npm install && npm run build`, start command `npm start`, env var
`CAIYUN_API_TOKEN`. Note: the host stores `cache/rain-grid.json` on local
disk; ephemeral filesystems lose history on restart (acceptable — it
re-accumulates).

## Curated reports

Hand-edit `data/reports.json`; each entry:

    { "id": "unique", "lon": 121.47, "lat": 31.23, "severity": 1|2|3,
      "title": "...", "source": "上海发布", "url": "optional", "time": "ISO" }

Coordinates are WGS-84 (the app converts to GCJ-02 for display).

## Regenerating the elevation grid

`npm run build-elevation` (downloads two Copernicus DEM tiles, ~100 MB;
output is committed so this is rarely needed).
```

- [ ] **Step 3: Full test suite one last time**

Run: `npx vitest run`
Expected: all suites PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README with run, deploy, and curation instructions"
```

---

## Self-Review Notes

- Spec coverage: rain fetch/cache/stagger (T7), history fallback (T7 merge rule 4), elevation + depression (T8), client model + both sliders (T4, T10), transparent→blue ramp (T5), GCJ-02 (T2, corners in T9, reports/click in T11), Chinese-first + EN toggle (T9), freshness stamp (T10), curated reports (T8 file, T11 layer), popup curve (T11), stale-cache-on-failure (T7), prod deploy path (T12). Legend disclaimer (T9). Tile fallback: AMap URLs live in one constant in `mapview.ts`; swapping to OSM is a one-line config change documented by the constant's placement — acceptable for v1.
- Caiyun response-shape risk is handled by the live probe step (T6 Step 4) with explicit instruction to reconcile code + fixtures.
- Type consistency: `RainGrid.precip[hour][lat][lon]`, row-major `latIdx * lons.length + lonIdx` used consistently in T3/T4/T5/T8/T11; `CellWeights` produced in T3, consumed in T4/T10.
