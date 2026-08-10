import type { RainGrid } from '../../shared/types.js';
import { rainAtCells, type CellWeights } from './interp.js';

export const RUNOFF = 0.8;
export const NOMINAL_DRAIN_MM_PER_HOUR = 10;

export function computeFloodSeries(
  rain: RainGrid,
  weights: CellWeights,
  depression: number[] | Float32Array,
  drainageFactor: number,
): Float32Array[] {
  const nCells = weights.idx.length / 4;
  const drain = NOMINAL_DRAIN_MM_PER_HOUR * drainageFactor;
  const water = new Float32Array(nCells);
  const out: Float32Array[] = [];
  for (let t = 0; t < rain.hours.length; t++) {
    const rainMm = rainAtCells(rain.precip[t], weights, rain.lons.length);
    const flood = new Float32Array(nCells);
    for (let c = 0; c < nCells; c++) {
      water[c] = Math.max(0, water[c] + rainMm[c] * RUNOFF - drain);
      flood[c] = water[c] * depression[c];
    }
    out.push(flood);
  }
  return out;
}
