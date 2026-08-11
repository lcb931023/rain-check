import { describe, it, expect } from 'vitest';
import { contourFeatures, elevationScale, rampColor, MAJOR_EVERY } from '../web/src/elevation.js';
import type { ElevationGrid } from '../shared/types.js';

const identity = (lon: number, lat: number): [number, number] => [lon, lat];

/** A plane tilting up with lat, so every contour is a known horizontal line. */
function ramp(w: number, h: number, perRow: number): ElevationGrid {
  const lons = Array.from({ length: w }, (_, i) => i);
  const lats = Array.from({ length: h }, (_, i) => i);
  const elevation = Array.from({ length: w * h }, (_, k) => Math.floor(k / w) * perRow);
  return { lons, lats, elevation, depression: elevation.map(() => 1) };
}

describe('elevationScale', () => {
  it('clips the ramp to percentiles but keeps the true extremes', () => {
    // 100 values 0..99 with one spike, as a tower cluster appears in a surface model.
    const data = [...Array.from({ length: 99 }, (_, i) => i), 5000];
    const s = elevationScale(data);
    expect(s.min).toBe(0);
    expect(s.max).toBe(5000);
    expect(s.hi).toBeLessThan(100); // the spike does not drag the ramp ceiling up
    expect(s.lo).toBeGreaterThanOrEqual(0);
  });

  it('picks a coarser contour interval as the range widens', () => {
    const span = (lo: number, hi: number) =>
      elevationScale(Array.from({ length: 200 }, (_, i) => lo + (hi - lo) * (i / 199))).interval;
    // Roughly the three shipped cities: ~8m, ~22m, ~67m.
    expect(span(0, 8)).toBeLessThan(span(30, 52));
    expect(span(30, 52)).toBeLessThan(span(80, 150));
  });

  it('keeps the contour count readable across very different terrain', () => {
    for (const [lo, hi] of [[0, 8], [30, 52], [80, 150], [0, 3000]] as const) {
      const s = elevationScale(Array.from({ length: 200 }, (_, i) => lo + (hi - lo) * (i / 199)));
      expect(s.levels.length).toBeGreaterThan(1);
      expect(s.levels.length).toBeLessThanOrEqual(15);
    }
  });

  it('spans contours across the true range, not the clipped ramp', () => {
    const data = [...Array.from({ length: 99 }, () => 10), 90];
    const s = elevationScale(data);
    expect(s.levels[s.levels.length - 1]).toBeGreaterThan(s.hi); // high ground still gets lines
  });

  it('survives a perfectly flat grid without emitting nonsense', () => {
    const s = elevationScale(Array.from({ length: 50 }, () => 7));
    expect(s.min).toBe(7);
    expect(s.max).toBe(7);
    expect(s.levels.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('rampColor', () => {
  it('clamps outside 0..1 rather than extrapolating past the ramp', () => {
    expect(rampColor(-5)).toEqual(rampColor(0));
    expect(rampColor(5)).toEqual(rampColor(1));
  });
  it('returns byte channels throughout', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      for (const c of rampColor(t)) {
        expect(Number.isInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('contourFeatures', () => {
  it('places a contour at the latitude where the plane crosses that level', () => {
    const grid = ramp(5, 5, 10); // rows at 0,10,20,30,40
    const scale = elevationScale(grid.elevation);
    const fc = contourFeatures(grid, scale, identity);
    const f = fc.features.find((x) => x.properties!.level === 20)!;
    expect(f).toBeDefined();
    for (const seg of (f.geometry as GeoJSON.MultiLineString).coordinates) {
      for (const [, lat] of seg) expect(lat).toBeCloseTo(2, 6); // row index 2 holds 20m
    }
  });

  it('emits nothing for a flat grid, rather than a line everywhere', () => {
    const flat: ElevationGrid = {
      lons: [0, 1, 2], lats: [0, 1, 2],
      elevation: Array(9).fill(5), depression: Array(9).fill(1),
    };
    const fc = contourFeatures(flat, elevationScale(flat.elevation), identity);
    expect(fc.features.every((f) => (f.geometry as GeoJSON.MultiLineString).coordinates.length === 0)).toBe(true);
  });

  it('marks every Nth contour as major so they can be counted', () => {
    const grid = ramp(4, 30, 1);
    const scale = elevationScale(grid.elevation);
    const fc = contourFeatures(grid, scale, identity);
    const majors = fc.features.filter((f) => f.properties!.major);
    expect(majors.length).toBeGreaterThan(0);
    for (const f of majors) {
      expect(Math.round((f.properties!.level as number) / scale.interval) % MAJOR_EVERY).toBe(0);
    }
  });

  it('runs every vertex through the projection', () => {
    const grid = ramp(5, 5, 10);
    const shifted = contourFeatures(grid, elevationScale(grid.elevation), (lon, lat) => [lon + 100, lat + 100]);
    for (const f of shifted.features) {
      for (const seg of (f.geometry as GeoJSON.MultiLineString).coordinates) {
        for (const [lon, lat] of seg) {
          expect(lon).toBeGreaterThanOrEqual(100);
          expect(lat).toBeGreaterThanOrEqual(100);
        }
      }
    }
  });

  it('produces only finite coordinates, including across equal-valued corners', () => {
    // Terraced ground: many cells have identical corners, which is where an
    // interpolation that divides by the corner difference would emit NaN.
    const grid: ElevationGrid = {
      lons: [0, 1, 2, 3], lats: [0, 1, 2, 3],
      elevation: [0, 0, 0, 0, 0, 5, 5, 0, 0, 5, 5, 0, 0, 0, 0, 0],
      depression: Array(16).fill(1),
    };
    const fc = contourFeatures(grid, elevationScale(grid.elevation), identity);
    for (const f of fc.features) {
      for (const seg of (f.geometry as GeoJSON.MultiLineString).coordinates) {
        for (const [lon, lat] of seg) {
          expect(Number.isFinite(lon)).toBe(true);
          expect(Number.isFinite(lat)).toBe(true);
        }
      }
    }
  });

  it('closes a contour around a hill into a loop of segments', () => {
    // A single high cell in the middle: its contour must ring it, so every crossing
    // point appears exactly twice — once as each of two segments' endpoints.
    const grid: ElevationGrid = {
      lons: [0, 1, 2], lats: [0, 1, 2],
      elevation: [0, 0, 0, 0, 10, 0, 0, 0, 0],
      depression: Array(9).fill(1),
    };
    const fc = contourFeatures(grid, elevationScale(grid.elevation), identity);
    const f = fc.features.find((x) => (x.geometry as GeoJSON.MultiLineString).coordinates.length > 0)!;
    const ends = (f.geometry as GeoJSON.MultiLineString).coordinates.flat().map((p) => p.join(','));
    const counts = new Map<string, number>();
    for (const e of ends) counts.set(e, (counts.get(e) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
  });
});
