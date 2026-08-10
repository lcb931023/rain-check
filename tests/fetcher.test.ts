import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridAxes, mergeRainCache, sweep } from '../server/fetcher.js';
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
      staggerMs: 0,
      now: () => now,
    });
    expect(await readdir(dir)).toEqual([]); // no rain-grid.json, no leftover .tmp
    expect(errors.mock.calls.at(-1)?.[0]).toBe('sweep failed entirely; no cache yet');
    errors.mockRestore();
  });

  it('writes the grid atomically on success, leaving no temp file behind', async () => {
    const dir = await freshDir();
    await sweep({
      fetchPoint: async () => pw(3, 1),
      cacheDir: dir,
      staggerMs: 0,
      now: () => now,
    });
    expect(await readdir(dir)).toEqual(['rain-grid.json']);
    const written: RainGrid = JSON.parse(await readFile(join(dir, 'rain-grid.json'), 'utf8'));
    expect(written.fetchedAt).toBe(now.toISOString());
    expect(written.hours.length).toBe(73);
    expect(written.precip[written.nowIndex][0][0]).toBe(3);
  });

  it('leaves an existing cache untouched when every point fails', async () => {
    const dir = await freshDir();
    await sweep({ fetchPoint: async () => pw(3, 1), cacheDir: dir, staggerMs: 0, now: () => now });
    const file = join(dir, 'rain-grid.json');
    const before = await readFile(file, 'utf8');
    const beforeMtime = (await stat(file)).mtimeMs;

    const errors = quietErrors();
    await sweep({
      fetchPoint: async () => { throw new Error('caiyun HTTP 400'); },
      cacheDir: dir,
      staggerMs: 0,
      now: () => new Date('2026-08-10T07:30:00Z'),
    });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(beforeMtime); // not rewritten at all
    expect(await readdir(dir)).toEqual(['rain-grid.json']);
    expect(errors.mock.calls.at(-1)?.[0]).toBe('sweep failed entirely; serving stale cache');
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
      staggerMs: 0,
      now: () => now,
    });
    await vi.waitFor(() => expect(firstCalls).toBe(1));

    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sweep({
      fetchPoint: async () => { secondCalls++; return pw(9, 9); },
      cacheDir: dirB,
      staggerMs: 0,
      now: () => now,
    });
    expect(secondCalls).toBe(0); // no requests issued
    expect(await readdir(dirB)).toEqual([]); // and no cache written
    expect(warns.mock.calls.at(-1)?.[0]).toBe('sweep already in flight; skipping this tick');
    warns.mockRestore();

    release();
    await first;
    expect(await readdir(dirA)).toEqual(['rain-grid.json']); // the held sweep still finishes

    // The flag clears afterwards, so the next tick is not locked out.
    await sweep({ fetchPoint: async () => pw(3, 1), cacheDir: dirB, staggerMs: 0, now: () => now });
    expect(await readdir(dirB)).toEqual(['rain-grid.json']);
  });
});
