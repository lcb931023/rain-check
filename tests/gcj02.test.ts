import { describe, it, expect } from 'vitest';
import { wgs84ToGcj02 } from '../web/src/gcj02.js';

describe('wgs84ToGcj02', () => {
  it('shifts Shanghai coordinates by a small offset', () => {
    const [glon, glat] = wgs84ToGcj02(121.4737, 31.2304);
    expect(Math.abs(glon - 121.4737)).toBeGreaterThan(0.001);
    expect(Math.abs(glon - 121.4737)).toBeLessThan(0.01);
    expect(Math.abs(glat - 31.2304)).toBeGreaterThan(0.0005);
    expect(Math.abs(glat - 31.2304)).toBeLessThan(0.01);
  });
  it('passes through coordinates outside China unchanged', () => {
    expect(wgs84ToGcj02(-74.006, 40.7128)).toEqual([-74.006, 40.7128]);
  });
});
