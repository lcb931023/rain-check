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
