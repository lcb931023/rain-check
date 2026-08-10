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
