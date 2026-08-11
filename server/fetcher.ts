import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG } from './config.js';
import { error, log, trace, warn } from './log.js';
import { fetchPointWeather, type PointWeather } from './caiyun.js';
import { rainCacheFile, type City } from '../shared/cities.js';
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
 * Merges one sweep's results into the previous grid. Pure and mode-agnostic:
 * it uses whatever hours each point's series covers (forecast sweeps bring
 * now..+47h, backfill sweeps -24h..+23h) and carries the rest from the old
 * cache; hours neither covers stay null rather than pretending to be dry.
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
          // Any hour the fetched series covers wins, past or future: backfilled past hours
          // are observations, strictly better than the radar snapshots or stale forecasts
          // the old cache carried for them.
          const fc = point.hourly.find((p) => hourStart(new Date(p.datetime)).toISOString() === h);
          if (fc) return fc.value;
        }
        const oi = oldHourIdx.get(h);
        if (old && oi !== undefined) return old.precip[oi][y][x];
        return null;
      }),
    ),
  );
  return { fetchedAt: now.toISOString(), lons: axes.lons, lats: axes.lats, hours, nowIndex, precip };
}

/**
 * Delay between point requests. This account's Caiyun plan is hard-limited to
 * QPS 1 (per its quota page), which matched the observed behavior: a 120 ms
 * stagger drew HTTP 429 on two of every three points in a phase-locked lattice,
 * and 450 ms (~2.2 QPS) still drew scattered 429s. 1100 ms stays under 1 QPS
 * with margin; an inner-city grid of 20-25 points costs ~25s of stagger plus
 * request latency, and cities are swept back to back, so even all three stay
 * well inside the 3-hour refresh.
 */
const STAGGER_MS = 1100;

/**
 * Consecutive failed points before a city's sweep gives up. Sized below the ~20-25 points
 * an inner-city grid holds, so a genuinely throttled account is abandoned early, while the
 * scattered one-off 429s that a warm cache absorbs never reach it.
 */
const MAX_CONSECUTIVE_FAILURES = 6;

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

/**
 * Whether the next sweep should spend its one call per point on history
 * (begin=-26h, window -24h..+24h) instead of forecast (now..+48h). True when
 * more than a quarter of the coming window's past-hour slots are null in the
 * cache — a cold start or a long outage. The threshold keeps a handful of
 * chronically rate-limited points (~6% of the grid) from trapping every sweep
 * in backfill mode, which would permanently cost the +24h..+48h forecast tail.
 */
export function needsBackfill(old: RainGrid | null, now: Date): boolean {
  if (!old) return true;
  const start = hourStart(new Date(now.getTime() - 24 * 3600_000));
  let nulls = 0;
  let total = 0;
  for (let i = 0; i < 24; i++) {
    const h = new Date(start.getTime() + i * 3600_000).toISOString();
    const oi = old.hours.indexOf(h);
    for (const row of oi === -1 ? [] : old.precip[oi]) {
      for (const v of row) {
        total++;
        if (v === null) nulls++;
      }
    }
    if (oi === -1) {
      const pts = old.lats.length * old.lons.length;
      total += pts;
      nulls += pts;
    }
  }
  return nulls / total > 0.25;
}

interface SweepOptions {
  fetchPoint?: (lon: number, lat: number, begin?: number) => Promise<PointWeather>;
  cacheDir?: string;
  staggerMs?: number;
  now?: () => Date;
  cities?: City[];
}

/**
 * A sweep takes a couple of minutes and the refresh interval is 3 h, but a slow
 * or retrying upstream could push one past the next tick. Two overlapping sweeps would
 * double the request rate into a rate-limited API and race on the cache files, so a
 * second sweep is skipped rather than queued — the next tick picks it up.
 */
let sweepInFlight = false;

export async function sweep(opts: SweepOptions = {}): Promise<void> {
  if (sweepInFlight) {
    warn('sweep already in flight; skipping this tick');
    return;
  }
  sweepInFlight = true;
  try {
    await runSweep(opts);
  } finally {
    sweepInFlight = false;
  }
}

async function runSweep(opts: SweepOptions): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const cities = opts.cities ?? CONFIG.cities;
  let fetchPoint = opts.fetchPoint;
  if (!fetchPoint) {
    const token = process.env.CAIYUN_API_TOKEN;
    if (!token) { warn('CAIYUN_API_TOKEN missing; fetcher idle'); return; }
    fetchPoint = (lon, lat, begin) => fetchPointWeather(lon, lat, token, undefined, begin);
  }

  // Every city draws on the same account's QPS budget, so they are swept one after
  // another, never concurrently. Each city's cache stands alone: one city failing
  // (or being rate-limited into a stale cache) must not cost the others their sweep.
  for (const city of cities) {
    try {
      await sweepCity(city, {
        fetchPoint,
        cacheDir: opts.cacheDir ?? CONFIG.cacheDir,
        staggerMs: opts.staggerMs ?? STAGGER_MS,
        now,
      });
    } catch (e) {
      error(`[${city.id}] sweep aborted:`, (e as Error).message);
    }
  }
}

async function sweepCity(city: City, opts: {
  fetchPoint: (lon: number, lat: number, begin?: number) => Promise<PointWeather>;
  cacheDir: string;
  staggerMs: number;
  now: () => Date;
}): Promise<void> {
  const { fetchPoint, cacheDir, staggerMs, now } = opts;
  const file = join(cacheDir, rainCacheFile(city.id));
  const old = await readCache(file);
  // 26h rather than 24h: Caiyun returns hours starting only ~1-2h after `begin`
  // (observed in the probe), so a -24h request would clip the window's oldest hours.
  const begin = needsBackfill(old, now())
    ? Math.floor(now().getTime() / 1000) - 26 * 3600
    : undefined;
  log(begin === undefined
    ? `[${city.id}] sweep mode: forecast (now..+48h)`
    : `[${city.id}] sweep mode: backfill (-24h..+24h); forecast tail extends next sweep`);

  const axes = gridAxes(city);
  const results: (PointWeather | null)[][] = [];
  // When the account is rate-limited or out of quota every remaining point fails too, so
  // a run of consecutive failures means the rest of this city is doomed. Giving up leaves
  // those points null (they keep their cached values) instead of spending minutes and a
  // fresh burst of rejected requests proving the same thing.
  let consecutiveFailures = 0;
  let abandoned = false;
  let ok = 0;
  let failed = 0;
  const startedAt = Date.now();
  for (const lat of axes.lats) {
    const row: (PointWeather | null)[] = [];
    for (const lon of axes.lons) {
      if (abandoned) { row.push(null); continue; }
      const t0 = Date.now();
      try {
        row.push(await fetchPoint(lon, lat, begin));
        consecutiveFailures = 0;
        ok++;
        trace(`[${city.id}] ok @${lon},${lat} ${Date.now() - t0}ms`);
      } catch (e) {
        failed++;
        error(`[${city.id}] fetch failed @${lon},${lat}:`, (e as Error).message);
        row.push(null);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          abandoned = true;
          error(`[${city.id}] ${consecutiveFailures} consecutive failures; abandoning the rest of this city`);
        }
      }
      await new Promise((r) => setTimeout(r, staggerMs));
    }
    results.push(row);
  }

  const points = axes.lons.length * axes.lats.length;
  // One line per city per sweep carrying the numbers a quota or throttling post-mortem
  // needs: how many calls were actually spent, how many came back, and over what span.
  log(`[${city.id}] sweep done: ${ok} ok, ${failed} failed, ${points - ok - failed} skipped`
    + ` of ${points} pts in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    + (abandoned ? ' (abandoned early)' : ''));

  const merged = mergeRainCache(old, results, axes, now());
  if (!merged || merged === old) {
    // Cold start and outage read the same from inside the loop but not from outside it:
    // with no cache on disk there is nothing to serve, and /api/rain 503s.
    error(`[${city.id}] ${old ? 'sweep failed entirely; serving stale cache' : 'sweep failed entirely; no cache yet'}`);
    return;
  }
  await writeCacheAtomic(file, merged);
  log(`[${city.id}] rain cache updated ${merged.fetchedAt} (${axes.lons.length * axes.lats.length} pts)`);
}

/**
 * Whether to sweep immediately at startup, rather than waiting out the first interval.
 * True when any enabled city's cache is missing or already older than the refresh
 * interval — i.e. when a sweep was due anyway — and always true under FETCH_ON_START.
 */
export async function shouldSweepOnStart(opts: {
  cacheDir: string;
  cities: City[];
  refreshMinutes: number;
  force: boolean;
  now?: () => Date;
}): Promise<boolean> {
  if (opts.force) return true;
  const now = (opts.now ?? (() => new Date()))();
  for (const city of opts.cities) {
    const cached = await readCache(join(opts.cacheDir, rainCacheFile(city.id)));
    if (!cached) return true;
    const ageMinutes = (now.getTime() - new Date(cached.fetchedAt).getTime()) / 60_000;
    if (!(ageMinutes < opts.refreshMinutes)) return true; // NaN fetchedAt counts as due
  }
  return false;
}

export function startFetcherLoop(): void {
  // `npm run dev` runs tsx watch, which restarts the server on every file save. An
  // unconditional startup sweep therefore turns each save into a full grid of Caiyun
  // calls against a fixed lifetime pool, which is the easiest way to drain it; so the
  // startup sweep is skipped while every city's cache is still fresh.
  shouldSweepOnStart({
    cacheDir: CONFIG.cacheDir,
    cities: CONFIG.cities,
    refreshMinutes: CONFIG.refreshMinutes,
    force: CONFIG.fetchOnStart,
  })
    .then((due) => {
      if (!due) {
        log('startup sweep skipped: every city cache is fresh (FETCH_ON_START=1 to force)');
        return;
      }
      return sweep().catch((e) => error('sweep error:', e));
    })
    .catch((e) => error('startup sweep check failed:', e));
  setInterval(() => sweep().catch((e) => error('sweep error:', e)), CONFIG.refreshMinutes * 60_000);
}
