import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

/**
 * Merges one sweep's results into the previous grid. Pure.
 * Returns `old` unchanged (by reference, possibly null) when no point succeeded,
 * so the caller can tell "nothing to write" from "new grid" — `fetchedAt` only
 * ever advances on a sweep that fetched at least one point.
 */
export function mergeRainCache(
  old: RainGrid | null,
  results: (PointWeather | null)[][],
  axes: { lons: number[]; lats: number[] },
  now: Date,
): RainGrid | null {
  if (!results.flat().some((r) => r !== null)) return old;
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

/**
 * Delay between point requests. Caiyun refills this account's bucket at roughly
 * one request per 360 ms: a 120 ms stagger drew HTTP 429 on two of every three
 * points, in the same phase-locked lattice on every sweep, so those cells were
 * permanently empty. 450 ms clears the refill rate; a 182-point sweep takes
 * ~82 s, well inside the 30-minute refresh.
 */
const STAGGER_MS = 450;

async function readCache(file: string): Promise<RainGrid | null> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** Write via a same-directory temp file + rename, so readers never see a partial grid. */
async function writeCacheAtomic(file: string, grid: RainGrid): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(grid));
  await rename(tmp, file);
}

export async function sweep(opts: {
  fetchPoint?: (lon: number, lat: number) => Promise<PointWeather>;
  cacheDir?: string;
  staggerMs?: number;
  now?: () => Date;
} = {}): Promise<void> {
  const cacheDir = opts.cacheDir ?? CONFIG.cacheDir;
  const staggerMs = opts.staggerMs ?? STAGGER_MS;
  const now = opts.now ?? (() => new Date());
  let fetchPoint = opts.fetchPoint;
  if (!fetchPoint) {
    const token = process.env.CAIYUN_API_TOKEN;
    if (!token) { console.warn('CAIYUN_API_TOKEN missing; fetcher idle'); return; }
    fetchPoint = (lon, lat) => fetchPointWeather(lon, lat, token);
  }

  const axes = gridAxes(CONFIG);
  const results: (PointWeather | null)[][] = [];
  for (const lat of axes.lats) {
    const row: (PointWeather | null)[] = [];
    for (const lon of axes.lons) {
      try {
        row.push(await fetchPoint(lon, lat));
      } catch (e) {
        console.error(`fetch failed @${lon},${lat}:`, (e as Error).message);
        row.push(null);
      }
      await new Promise((r) => setTimeout(r, staggerMs));
    }
    results.push(row);
  }

  const file = join(cacheDir, 'rain-grid.json');
  const old = await readCache(file);
  const merged = mergeRainCache(old, results, axes, now());
  if (!merged || merged === old) {
    console.error('sweep failed entirely; serving stale cache');
    return;
  }
  await writeCacheAtomic(file, merged);
  console.log(`rain cache updated ${merged.fetchedAt} (${axes.lons.length * axes.lats.length} pts)`);
}

export function startFetcherLoop(): void {
  sweep().catch((e) => console.error('sweep error:', e));
  setInterval(() => sweep().catch((e) => console.error('sweep error:', e)), CONFIG.refreshMinutes * 60_000);
}
