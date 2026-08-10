import { describe, it, expect } from 'vitest';
import { computeDepression } from '../scripts/tpi.js';

describe('computeDepression', () => {
  it('is 1.0 on perfectly flat ground', () => {
    const flat = new Float32Array(9).fill(4);
    const d = computeDepression(flat, 3, 3, 1);
    expect(d[4]).toBeCloseTo(1.0);
  });
  it('exceeds 1 in a hollow and is below 1 on a mound', () => {
    // center cell 2m below its ring vs 2m above
    const hollow = new Float32Array([4, 4, 4, 4, 2, 4, 4, 4, 4]);
    const mound = new Float32Array([4, 4, 4, 4, 6, 4, 4, 4, 4]);
    expect(computeDepression(hollow, 3, 3, 1)[4]).toBeGreaterThan(1);
    expect(computeDepression(mound, 3, 3, 1)[4]).toBeLessThan(1);
  });
  it('clips the neighborhood at edges and scales the offset by 0.6', () => {
    // Corner cell sees only the 4 in-grid cells of its box, mean (0+4+4+4)/4 = 3,
    // so 1 + 0.6 * (3 - 0) = 2.8 -- unclamped, which pins the coefficient too.
    // Counting out-of-grid cells as 0 would give 1.8; a coefficient of 1.0, 4.0.
    const corner = new Float32Array([0, 4, 4, 4, 4, 4, 4, 4, 4]);
    expect(computeDepression(corner, 3, 3, 1)[0]).toBeCloseTo(2.8, 5);
  });
  it('clamps to [0.2, 3]', () => {
    const extreme = new Float32Array([50, 50, 50, 50, 0, 50, 50, 50, 50]);
    expect(computeDepression(extreme, 3, 3, 1)[4]).toBe(3);
    const ridge = new Float32Array([0, 0, 0, 0, 50, 0, 0, 0, 0]);
    // 0.2 has no exact Float32 representation, so compare within float32 epsilon;
    // the unclamped value here is -25.6, far outside this tolerance.
    expect(computeDepression(ridge, 3, 3, 1)[4]).toBeCloseTo(0.2, 6);
  });
});
