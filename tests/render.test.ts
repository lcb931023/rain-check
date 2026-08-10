import { describe, it, expect } from 'vitest';
import { floodColor, FLOOD_BANDS, drawFloodCanvas } from '../web/src/render.js';

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
  it('interpolates strictly between stops on every channel', () => {
    // midway between the 5mm stop [126,184,255,64] and the 30mm stop [46,107,230,140]
    const mid = floodColor(17.5);
    const lo = floodColor(FLOOD_BANDS.possible);
    const hi = floodColor(FLOOD_BANDS.severe);
    // rgb fall from light to deep blue while alpha rises, so bound each channel by its own endpoints
    for (const k of [0, 1, 2, 3]) {
      expect(mid[k]).toBeGreaterThan(Math.min(lo[k], hi[k]));
      expect(mid[k]).toBeLessThan(Math.max(lo[k], hi[k]));
    }
  });
});

describe('drawFloodCanvas', () => {
  const w = 2;
  const h = 3;

  function stubCtx() {
    const data = new Uint8ClampedArray(w * h * 4);
    const ctx = {
      createImageData: () => ({ data }),
      putImageData: () => {},
    } as unknown as CanvasRenderingContext2D;
    return { ctx, data };
  }

  const alphaAt = (data: Uint8ClampedArray, row: number, col: number) =>
    data[(row * w + col) * 4 + 3];

  it('puts the northernmost (last) lat row in canvas row 0', () => {
    const { ctx, data } = stubCtx();
    const flood = new Float32Array(w * h);
    // lats ascend south->north, so the LAST row is the northernmost
    flood[(h - 1) * w + 0] = 100;
    flood[(h - 1) * w + 1] = 100;

    drawFloodCanvas(ctx, flood, w, h);

    // ...and it must land on the TOP canvas row
    expect(alphaAt(data, 0, 0)).toBeGreaterThan(0);
    expect(alphaAt(data, 0, 1)).toBeGreaterThan(0);
    // the bottom canvas row is the southernmost lat row, which had no water
    expect(alphaAt(data, h - 1, 0)).toBe(0);
    expect(alphaAt(data, h - 1, 1)).toBe(0);
  });

  it('puts the southernmost (first) lat row in the last canvas row', () => {
    const { ctx, data } = stubCtx();
    const flood = new Float32Array(w * h);
    flood[0] = 100;

    drawFloodCanvas(ctx, flood, w, h);

    expect(alphaAt(data, h - 1, 0)).toBeGreaterThan(0);
    expect(alphaAt(data, 0, 0)).toBe(0);
  });

  it('preserves column order and writes RGBA per cell', () => {
    const { ctx, data } = stubCtx();
    const flood = new Float32Array(w * h);
    flood[(h - 1) * w + 1] = 100; // north row, east column only

    drawFloodCanvas(ctx, flood, w, h);

    expect(alphaAt(data, 0, 0)).toBe(0);
    expect(alphaAt(data, 0, 1)).toBeGreaterThan(0);
    // deep water renders as saturated deep blue, not a warm hue
    const o = (0 * w + 1) * 4;
    expect(data[o + 2]).toBeGreaterThan(data[o]);
  });
});
