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
  it('interpolates along lon independently of lat', () => {
    // Asymmetric in lon only: both lat rows are [0, 10], so a tx/ty swap or a
    // transposed flat index cannot produce the right answer by symmetry.
    const cells = { lons: [121.05], lats: [31.0] };
    const w = precomputeCellWeights(rain, cells);
    const out = rainAtCells([[0, 10], [0, 10]], w, 2);
    expect(out[0]).toBeCloseTo(5);
  });
  it('emits cells lat-outer, lon-inner in row-major order', () => {
    const cells = { lons: [121.0, 121.1], lats: [31.0, 31.1] };
    const w = precomputeCellWeights(rain, cells);
    // Every cell sits exactly on a distinct rain-grid point, so each output
    // must reproduce that point's value: slot = latIdx * cells.lons.length + lonIdx.
    const out = rainAtCells([[1, 2], [3, 4]], w, 2);
    expect(out[0]).toBeCloseTo(1); // lat 31.0, lon 121.0
    expect(out[1]).toBeCloseTo(2); // lat 31.0, lon 121.1
    expect(out[2]).toBeCloseTo(3); // lat 31.1, lon 121.0
    expect(out[3]).toBeCloseTo(4); // lat 31.1, lon 121.1
  });
  it('treats null rain values as 0', () => {
    const cells = { lons: [121.0], lats: [31.0] };
    const w = precomputeCellWeights(rain, cells);
    const out = rainAtCells([[null, 1], [2, 3]], w, 2);
    expect(out[0]).toBeCloseTo(0);
  });
});
