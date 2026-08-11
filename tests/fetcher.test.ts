import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridAxes, mergeRainCache, needsBackfill, shouldSweepOnStart, sweep } from '../server/fetcher.js';
import type { PointWeather } from '../server/caiyun.js';
import type { City } from '../shared/cities.js';
import type { RainGrid } from '../shared/types.js';

const axes = { lons: [121.0], lats: [31.0] };

/**
 * A degenerate one-point bbox, so sweep tests exercise the loop without 182 fetches.
 * `lon` distinguishes cities, letting a fake fetchPoint tell whose point it is asked for.
 */
const city = (id: string, lon = 121.0): City => ({
  id,
  name: { zh: id, en: id },
  bbox: { lonMin: lon, lonMax: lon, latMin: 31.0, latMax: 31.0 },
  rainStep: { lon: 0.045, lat: 0.04 },
  elevStep: { lon: 0.003, lat: 0.0025 },
});
const testCity = city('testville');
const cities = [testCity];
const cacheName = 'rain-grid-testville.json';
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

/** A backfill-mode response: 48 hours starting 24h before `now` (covers -24h..+23h). */
function pwBackfill(realtime: number, hourlyValue: number): PointWeather {
  return {
    realtimeIntensity: realtime,
    hourly: Array.from({ length: 48 }, (_, i) => ({
      datetime: new Date(Date.UTC(2026, 7, 9, 6 + i)).toISOString(),
      value: hourlyValue,
    })),
  };
}

/** mergeRainCache returns null only on total failure with no old cache; tests assert around that. */
const grid = (g: RainGrid | null): RainGrid => {
  if (!g) throw new Error('expected a grid, got null');
  return g;
};

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
    const g = grid(mergeRainCache(null, [[pw(3, 1)]], axes, now));
    expect(g.hours.length).toBe(73);
    expect(g.hours[g.nowIndex]).toBe(hourIso('2026-08-10T06:00:00Z'));
    expect(g.hours[0]).toBe(hourIso('2026-08-09T06:00:00Z'));
  });
  it('uses realtime intensity for the current hour and forecast after', () => {
    const g = grid(mergeRainCache(null, [[pw(3, 1)]], axes, now));
    expect(g.precip[g.nowIndex][0][0]).toBe(3);
    expect(g.precip[g.nowIndex + 1][0][0]).toBe(1);
  });
  it('retains past hours from the old cache', () => {
    const old = mergeRainCache(null, [[pw(9, 1)]], axes, new Date('2026-08-10T04:30:00Z'));
    const g = grid(mergeRainCache(old, [[pw(3, 1)]], axes, now));
    const oldHourIdx = g.hours.indexOf(hourIso('2026-08-10T04:00:00Z'));
    expect(g.precip[oldHourIdx][0][0]).toBe(9); // the realtime value stored 2h ago survives
  });
  it('keeps old values for a point whose fetch failed, and returns old unchanged when all fail', () => {
    const old = mergeRainCache(null, [[pw(9, 1)]], axes, new Date('2026-08-10T04:30:00Z'));
    const g = mergeRainCache(old, [[null]], axes, now);
    expect(g).toBe(old);
  });
  it('returns null on total failure with no old cache, rather than an empty grid', () => {
    expect(mergeRainCache(null, [[null]], axes, now)).toBeNull();
  });
  it('fills past hours from a backfill response on a cold start', () => {
    const g = grid(mergeRainCache(null, [[pwBackfill(3, 2)]], axes, now));
    expect(g.precip[0][0][0]).toBe(2); // -24h comes straight from the fetched series
    expect(g.precip[g.nowIndex - 1][0][0]).toBe(2);
    expect(g.precip[g.nowIndex][0][0]).toBe(3); // radar still wins the current hour
    expect(g.precip[72][0][0]).toBeNull(); // beyond the fetched horizon: no data, not fake dry
  });
  it('prefers freshly fetched past hours over carried-forward cache', () => {
    const old = mergeRainCache(null, [[pw(9, 1)]], axes, new Date('2026-08-10T04:30:00Z'));
    const g = grid(mergeRainCache(old, [[pwBackfill(3, 2)]], axes, now));
    const h = g.hours.indexOf(hourIso('2026-08-10T04:00:00Z'));
    expect(g.precip[h][0][0]).toBe(2); // observed backfill beats the radar snapshot stored then
  });
  it('updates the succeeded point while the failed one keeps old values', () => {
    const twoPoints = { lons: [121.0, 121.045], lats: [31.0] };
    const old = mergeRainCache(null, [[pw(9, 5), pw(9, 5)]], twoPoints, new Date('2026-08-10T04:30:00Z'));
    const g = grid(mergeRainCache(old, [[pw(3, 1), null]], twoPoints, now));
    const past = g.hours.indexOf(hourIso('2026-08-10T04:00:00Z'));

    expect(g.precip[g.nowIndex][0][0]).toBe(3); // succeeded: radar now-cast
    expect(g.precip[g.nowIndex][0][1]).toBe(5); // failed: old cache's forecast for this hour
    expect(g.precip[g.nowIndex + 1][0][0]).toBe(1); // succeeded: fresh forecast
    expect(g.precip[g.nowIndex + 1][0][1]).toBe(5); // failed: old forecast, not overwritten
    expect(g.precip[past][0][0]).toBe(9); // both keep history regardless of this sweep
    expect(g.precip[past][0][1]).toBe(9);
  });
});

describe('needsBackfill', () => {
  it('is true with no cache at all', () => {
    expect(needsBackfill(null, now)).toBe(true);
  });
  it('is true when the past-24h window is entirely null in the cache', () => {
    // A forecast-mode grid fetched 30h ago: today's past-24h slots exist but hold no data.
    const old = grid(mergeRainCache(null, [[pw(9, 1)]], axes, new Date('2026-08-09T00:30:00Z')));
    expect(needsBackfill(old, now)).toBe(true);
  });
  it('is false when history is mostly present', () => {
    // Backfilled at 04:30 → past hours populated; two hours later only 2/24 slots are new holes.
    const old = grid(mergeRainCache(null, [[{
      realtimeIntensity: 9,
      hourly: Array.from({ length: 48 }, (_, i) => ({
        datetime: new Date(Date.UTC(2026, 7, 9, 4 + i)).toISOString(),
        value: 1,
      })),
    }]], axes, new Date('2026-08-10T04:30:00Z')));
    expect(needsBackfill(old, now)).toBe(false);
  });
  it('is true when more than a quarter of past slots are null', () => {
    // Forecast-mode cold start at 04:30 wrote no history at all except the current hour.
    const old = grid(mergeRainCache(null, [[pw(9, 1)]], axes, new Date('2026-08-10T04:30:00Z')));
    expect(needsBackfill(old, now)).toBe(true);
  });
});

describe('shouldSweepOnStart', () => {
  const freshDir = () => mkdtemp(join(tmpdir(), 'rain-start-'));
  const args = (cacheDir: string, force = false) =>
    ({ cacheDir, cities, refreshMinutes: 180, force, now: () => now });

  it('sweeps when a city has no cache at all', async () => {
    expect(await shouldSweepOnStart(args(await freshDir()))).toBe(true);
  });

  it('skips the startup sweep when every cache is younger than the refresh interval', async () => {
    const dir = await freshDir();
    await sweep({ fetchPoint: async () => pw(3, 1), cacheDir: dir, cities, staggerMs: 0, now: () => now });
    expect(await shouldSweepOnStart(args(dir))).toBe(false);
  });

  it('sweeps when the cache has aged past the refresh interval', async () => {
    const dir = await freshDir();
    const stale = new Date(now.getTime() - 200 * 60_000);
    await sweep({ fetchPoint: async () => pw(3, 1), cacheDir: dir, cities, staggerMs: 0, now: () => stale });
    expect(await shouldSweepOnStart(args(dir))).toBe(true);
  });

  it('sweeps a fresh cache anyway under FETCH_ON_START', async () => {
    const dir = await freshDir();
    await sweep({ fetchPoint: async () => pw(3, 1), cacheDir: dir, cities, staggerMs: 0, now: () => now });
    expect(await shouldSweepOnStart(args(dir, true))).toBe(true);
  });

  it('sweeps when only some of the enabled cities are cached', async () => {
    const dir = await freshDir();
    await sweep({ fetchPoint: async () => pw(3, 1), cacheDir: dir, cities, staggerMs: 0, now: () => now });
    const two = { ...args(dir), cities: [testCity, city('uncached', 122.0)] };
    expect(await shouldSweepOnStart(two)).toBe(true);
  });
});

describe('sweep', () => {
  const freshDir = () => mkdtemp(join(tmpdir(), 'rain-cache-'));
  /** A failing sweep logs one line per point; silence them and return the recorded calls. */
  const quietErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('writes nothing when every point fails and there is no cache yet', async () => {
    const dir = await freshDir();
    const errors = quietErrors();
    await sweep({
      fetchPoint: async () => { throw new Error('caiyun HTTP 429'); },
      cacheDir: dir,
      cities,
      staggerMs: 0,
      now: () => now,
    });
    expect(await readdir(dir)).toEqual([]); // no rain-grid-testville.json, no leftover .tmp
    expect(errors.mock.calls.at(-1)?.[0]).toBe('[testville] sweep failed entirely; no cache yet');
    errors.mockRestore();
  });

  it('writes the grid atomically on success, leaving no temp file behind', async () => {
    const dir = await freshDir();
    await sweep({
      fetchPoint: async () => pw(3, 1),
      cacheDir: dir,
      cities,
      staggerMs: 0,
      now: () => now,
    });
    expect(await readdir(dir)).toEqual([cacheName]);
    const written: RainGrid = JSON.parse(await readFile(join(dir, cacheName), 'utf8'));
    expect(written.fetchedAt).toBe(now.toISOString());
    expect(written.hours.length).toBe(73);
    expect(written.precip[written.nowIndex][0][0]).toBe(3);
  });

  it('leaves an existing cache untouched when every point fails', async () => {
    const dir = await freshDir();
    await sweep({ fetchPoint: async () => pw(3, 1), cacheDir: dir, cities, staggerMs: 0, now: () => now });
    const file = join(dir, cacheName);
    const before = await readFile(file, 'utf8');
    const beforeMtime = (await stat(file)).mtimeMs;

    const errors = quietErrors();
    await sweep({
      fetchPoint: async () => { throw new Error('caiyun HTTP 400'); },
      cacheDir: dir,
      cities,
      staggerMs: 0,
      now: () => new Date('2026-08-10T07:30:00Z'),
    });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(beforeMtime); // not rewritten at all
    expect(await readdir(dir)).toEqual([cacheName]);
    expect(errors.mock.calls.at(-1)?.[0]).toBe('[testville] sweep failed entirely; serving stale cache');
    errors.mockRestore();
  });

  it('backfills on a cold start, then sweeps forward once history is present', async () => {
    const dir = await freshDir();
    const begins: (number | undefined)[] = [];
    const fetchPoint = async (_lon: number, _lat: number, begin?: number) => {
      begins.push(begin);
      return begin === undefined ? pw(3, 1) : pwBackfill(3, 2);
    };

    await sweep({ fetchPoint, cacheDir: dir, cities, staggerMs: 0, now: () => now });
    // Cold start: every point asked for history starting 26h back (margin for Caiyun's
    // habit of returning hours only from ~1-2h after `begin`).
    expect(begins[0]).toBe(Math.floor(now.getTime() / 1000) - 26 * 3600);
    expect(new Set(begins).size).toBe(1);
    const g: RainGrid = JSON.parse(await readFile(join(dir, cacheName), 'utf8'));
    expect(g.precip[0][0][0]).toBe(2); // -24h populated on the very first sweep

    begins.length = 0;
    await sweep({ fetchPoint, cacheDir: dir, cities, staggerMs: 0, now: () => new Date('2026-08-10T07:30:00Z') });
    expect(begins.every((b) => b === undefined)).toBe(true); // warm cache: forecast mode
  });

  it('writes one cache per city and picks each city\'s mode from its own cache', async () => {
    const dir = await freshDir();
    const alpha = city('alpha', 121.0);
    const beta = city('beta', 122.0);
    const fetchPoint = async (_lon: number, _lat: number, begin?: number) =>
      (begin === undefined ? pw(3, 1) : pwBackfill(3, 2));

    // Seed alpha alone, so the next sweep meets a warm alpha and a cold beta.
    await sweep({ fetchPoint, cacheDir: dir, cities: [alpha], staggerMs: 0, now: () => now });

    const begins = new Map<number, number | undefined>();
    await sweep({
      fetchPoint: async (lon, lat, begin) => { begins.set(lon, begin); return fetchPoint(lon, lat, begin); },
      cacheDir: dir,
      cities: [alpha, beta],
      staggerMs: 0,
      now: () => new Date('2026-08-10T07:30:00Z'),
    });

    expect((await readdir(dir)).sort()).toEqual(['rain-grid-alpha.json', 'rain-grid-beta.json']);
    expect(begins.get(121.0)).toBeUndefined();     // warm: forecast
    expect(begins.get(122.0)).toBeTypeOf('number'); // cold: backfill, independent of alpha
  });

  it('sweeps the remaining cities when one city fails entirely', async () => {
    const dir = await freshDir();
    const errors = quietErrors();
    await sweep({
      fetchPoint: async (lon) => {
        if (lon === 121.0) throw new Error('caiyun HTTP 429');
        return pw(3, 1);
      },
      cacheDir: dir,
      cities: [city('alpha', 121.0), city('beta', 122.0)],
      staggerMs: 0,
      now: () => now,
    });
    expect(await readdir(dir)).toEqual(['rain-grid-beta.json']);
    errors.mockRestore();
  });

  it('only fetches points for the cities it is given', async () => {
    const dir = await freshDir();
    const lons: number[] = [];
    await sweep({
      fetchPoint: async (lon) => { lons.push(lon); return pw(3, 1); },
      cacheDir: dir,
      cities: [city('alpha', 121.0)],
      staggerMs: 0,
      now: () => now,
    });
    // One enabled city means one city's worth of calls, not the whole registry's.
    expect(lons).toEqual([121.0]);
    expect(await readdir(dir)).toEqual(['rain-grid-alpha.json']);
  });

  it('abandons a city after a run of consecutive failures', async () => {
    const dir = await freshDir();
    const errors = quietErrors();
    // A 12-point city whose every request is rejected, as a throttled account behaves.
    const wide: City = { ...city('wide'), bbox: { lonMin: 121, lonMax: 121.5, latMin: 31, latMax: 31.04 } };
    let calls = 0;
    await sweep({
      fetchPoint: async () => { calls++; throw new Error('caiyun HTTP 429'); },
      cacheDir: dir,
      cities: [wide],
      staggerMs: 0,
      now: () => now,
    });
    expect(gridAxes(wide).lons.length * gridAxes(wide).lats.length).toBeGreaterThan(6);
    expect(calls).toBe(6); // gave up rather than working through every doomed point
    errors.mockRestore();
  });

  it('skips a sweep that starts while another is still in flight', async () => {
    const dirA = await freshDir();
    const dirB = await freshDir();
    let firstCalls = 0;
    let secondCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });

    // The first sweep parks inside its very first point fetch, so it is provably mid-sweep.
    const first = sweep({
      fetchPoint: async () => { firstCalls++; await held; return pw(3, 1); },
      cacheDir: dirA,
      cities,
      staggerMs: 0,
      now: () => now,
    });
    await vi.waitFor(() => expect(firstCalls).toBe(1));

    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sweep({
      fetchPoint: async () => { secondCalls++; return pw(9, 9); },
      cacheDir: dirB,
      cities,
      staggerMs: 0,
      now: () => now,
    });
    expect(secondCalls).toBe(0); // no requests issued
    expect(await readdir(dirB)).toEqual([]); // and no cache written
    expect(warns.mock.calls.at(-1)?.[0]).toBe('sweep already in flight; skipping this tick');
    warns.mockRestore();

    release();
    await first;
    expect(await readdir(dirA)).toEqual([cacheName]); // the held sweep still finishes

    // The flag clears afterwards, so the next tick is not locked out.
    await sweep({ fetchPoint: async () => pw(3, 1), cacheDir: dirB, cities, staggerMs: 0, now: () => now });
    expect(await readdir(dirB)).toEqual([cacheName]);
  });
});
