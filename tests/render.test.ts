import { describe, it, expect } from 'vitest';
import { floodColor, FLOOD_BANDS } from '../web/src/render.js';

describe('floodColor', () => {
  it('is fully transparent at zero water', () => {
    expect(floodColor(0)[3]).toBe(0);
  });
  it('gets more opaque and more blue as flooding deepens', () => {
    const low = floodColor(FLOOD_BANDS.possible);
    const high = floodColor(FLOOD_BANDS.severe * 3);
    expect(high[3]).toBeGreaterThan(low[3]);
    expect(low[3]).toBeGreaterThan(0);
    // blue channel dominates red at every level
    expect(low[2]).toBeGreaterThan(low[0]);
    expect(high[2]).toBeGreaterThan(high[0]);
  });
  it('saturates instead of overflowing at extreme values', () => {
    expect(floodColor(10000)[3]).toBeLessThanOrEqual(255);
  });
});
