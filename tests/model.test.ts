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
