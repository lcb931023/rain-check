import type { ElevationGrid } from '../../shared/types.js';

/**
 * Hypsometric ramp, deliberately free of blue: the flood layer draws blue over the top of
 * this one, and a blue lowland would read as water.
 */
export const RAMP: [number, [number, number, number]][] = [
  [0.00, [26, 107, 60]],
  [0.25, [127, 196, 90]],
  [0.50, [242, 224, 107]],
  [0.75, [217, 139, 58]],
  [1.00, [140, 90, 60]],
];

/** ~65%, so the basemap's streets stay readable under the tint. */
const FILL_ALPHA = 165;

/** Every 5th contour is drawn heavier, which is what lets you count them without labels. */
export const MAJOR_EVERY = 5;

const MAX_CONTOURS = 14;
const NICE_STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];

export function rampColor(t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < RAMP.length - 2 && RAMP[i + 1][0] < u) i++;
  const [t0, c0] = RAMP[i];
  const [t1, c1] = RAMP[i + 1];
  const k = t1 === t0 ? 0 : (u - t0) / (t1 - t0);
  return [0, 1, 2].map((n) => Math.round(c0[n] + (c1[n] - c0[n]) * k)) as [number, number, number];
}

export interface ElevationScale {
  /** Ramp bounds, clipped to percentiles. */
  lo: number;
  hi: number;
  /** True extremes, for the legend's end labels. */
  min: number;
  max: number;
  interval: number;
  levels: number[];
}

/**
 * Derived from the grid at runtime rather than configured per city, because the cities
 * differ by an order of magnitude: Shanghai spans ~8m, Beijing ~22m, Zhengzhou ~67m. A
 * fixed ramp would render Shanghai as one flat colour.
 *
 * The ramp clips to the 2nd/98th percentiles: this is a surface model, so a cluster of
 * towers sits in the data as a spike that would otherwise compress the whole city into
 * the bottom of the ramp. Contours still span the true range, so high ground keeps lines.
 */
export function elevationScale(elevation: ArrayLike<number>): ElevationScale {
  const sorted = Array.from(elevation).sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const lo = at(0.02);
  const hi = at(0.98);
  const span = max - min;
  const interval = NICE_STEPS.find((s) => span / s <= MAX_CONTOURS) ?? NICE_STEPS[NICE_STEPS.length - 1];

  const levels: number[] = [];
  for (let v = Math.ceil(min / interval) * interval; v <= max; v += interval) {
    levels.push(Number(v.toFixed(3))); // rebuilt by addition, so trim the float drift
  }
  return { lo, hi, min, max, interval, levels };
}

export function drawElevationCanvas(
  ctx: CanvasRenderingContext2D,
  elevation: number[],
  w: number,
  h: number,
  scale: ElevationScale,
): void {
  const img = ctx.createImageData(w, h);
  const span = scale.hi - scale.lo || 1;
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y; // lats ascend south->north; canvas rows go top->bottom
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rampColor((elevation[srcRow * w + x] - scale.lo) / span);
      const o = (y * w + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = FILL_ALPHA;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Marching squares over the elevation grid, one MultiLineString per level.
 *
 * Corner bits are bl=1, br=2, tr=4, tl=8. Cases 5 and 10 are saddles, where the two
 * crossings can be joined two ways; the cell mean decides, which is the standard
 * disambiguation and keeps neighbouring cells consistent.
 *
 * Segments are emitted unjoined rather than stitched into rings: MapLibre renders a
 * MultiLineString of two-point segments identically, and stitching would only matter
 * for labelling, which needs a glyph server this style deliberately does not have.
 */
export function contourFeatures(
  grid: ElevationGrid,
  scale: ElevationScale,
  project: (lon: number, lat: number) => [number, number],
): GeoJSON.FeatureCollection {
  const { lons, lats, elevation } = grid;
  const W = lons.length;
  const at = (x: number, y: number) => elevation[y * W + x];

  const features = scale.levels.map((level) => {
    const segments: [number, number][][] = [];
    for (let y = 0; y < lats.length - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const bl = at(x, y), br = at(x + 1, y), tr = at(x + 1, y + 1), tl = at(x, y + 1);
        const idx = (bl > level ? 1 : 0) | (br > level ? 2 : 0) | (tr > level ? 4 : 0) | (tl > level ? 8 : 0);
        if (idx === 0 || idx === 15) continue;

        const mix = (a: number, b: number, va: number, vb: number) =>
          va === vb ? a : a + (b - a) * ((level - va) / (vb - va));
        const bottom = (): [number, number] => [mix(lons[x], lons[x + 1], bl, br), lats[y]];
        const right = (): [number, number] => [lons[x + 1], mix(lats[y], lats[y + 1], br, tr)];
        const top = (): [number, number] => [mix(lons[x], lons[x + 1], tl, tr), lats[y + 1]];
        const left = (): [number, number] => [lons[x], mix(lats[y], lats[y + 1], bl, tl)];

        const push = (a: [number, number], b: [number, number]) =>
          segments.push([project(a[0], a[1]), project(b[0], b[1])]);

        switch (idx) {
          case 1: case 14: push(left(), bottom()); break;
          case 2: case 13: push(bottom(), right()); break;
          case 3: case 12: push(left(), right()); break;
          case 4: case 11: push(right(), top()); break;
          case 6: case 9: push(bottom(), top()); break;
          case 7: case 8: push(left(), top()); break;
          case 5:
            if ((bl + br + tr + tl) / 4 > level) { push(left(), top()); push(bottom(), right()); }
            else { push(left(), bottom()); push(right(), top()); }
            break;
          case 10:
            if ((bl + br + tr + tl) / 4 > level) { push(left(), bottom()); push(right(), top()); }
            else { push(left(), top()); push(bottom(), right()); }
            break;
        }
      }
    }
    return {
      type: 'Feature' as const,
      properties: {
        level,
        major: Math.round(level / scale.interval) % MAJOR_EVERY === 0,
      },
      geometry: { type: 'MultiLineString' as const, coordinates: segments },
    };
  });

  return { type: 'FeatureCollection', features: features.filter((f) => f.geometry.coordinates.length > 0) };
}
