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
