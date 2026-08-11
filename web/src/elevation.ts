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
const NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];

/** Detail handle range: 1 is the grid's own resolution, 4 the finest offered. */
export const MAX_DETAIL = 4;

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
export function elevationScale(elevation: ArrayLike<number>, detail = 1): ElevationScale {
  const sorted = Array.from(elevation).sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const lo = at(0.02);
  const hi = at(0.98);
  const span = max - min;
  // `detail` raises the contour budget, so the same nice-step ladder lands a rung or two
  // finer: Shanghai's 2m becomes 1m at detail 2 and 0.5m at detail 4.
  const budget = MAX_CONTOURS * Math.max(1, detail);
  const interval = NICE_STEPS.find((s) => span / s <= budget) ?? NICE_STEPS[NICE_STEPS.length - 1];

  const levels: number[] = [];
  for (let v = Math.ceil(min / interval) * interval; v <= max; v += interval) {
    levels.push(Number(v.toFixed(3))); // rebuilt by addition, so trim the float drift
  }
  return { lo, hi, min, max, interval, levels };
}

/**
 * Bilinearly upsamples the grid by `factor` before contouring.
 *
 * This smooths, it does not reveal: the source DEM is ~30m but these grids are sampled at
 * ~280m cells, and interpolating between those cells cannot recover what was averaged away.
 * Its job is to stop the finer intervals the detail handle selects from coming out as
 * stair-steps around each cell. Genuinely finer terrain means a smaller elevStep and a
 * rebuild, which is a data change rather than a view setting.
 */
export function supersample(grid: ElevationGrid, factor: number): ElevationGrid {
  const f = Math.round(factor);
  if (f <= 1) return grid;
  const W = grid.lons.length;
  const H = grid.lats.length;
  const nW = (W - 1) * f + 1;
  const nH = (H - 1) * f + 1;
  const lons = Array.from({ length: nW }, (_, i) => grid.lons[0] + (i / f) * (grid.lons[1] - grid.lons[0]));
  const lats = Array.from({ length: nH }, (_, j) => grid.lats[0] + (j / f) * (grid.lats[1] - grid.lats[0]));

  const elevation = new Array<number>(nW * nH);
  for (let j = 0; j < nH; j++) {
    const gy = j / f;
    const y0 = Math.min(H - 2, Math.floor(gy));
    const ty = gy - y0;
    for (let i = 0; i < nW; i++) {
      const gx = i / f;
      const x0 = Math.min(W - 2, Math.floor(gx));
      const tx = gx - x0;
      const a = grid.elevation[y0 * W + x0];
      const b = grid.elevation[y0 * W + x0 + 1];
      const c = grid.elevation[(y0 + 1) * W + x0];
      const d = grid.elevation[(y0 + 1) * W + x0 + 1];
      elevation[j * nW + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  // depression is not used for contouring; carry a same-length filler so the shape holds.
  return { lons, lats, elevation, depression: elevation };
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

/** Where `level` falls between two corner values; equal corners fall back to the first. */
const mix = (a: number, b: number, va: number, vb: number, level: number) =>
  (va === vb ? a : a + (b - a) * ((level - va) / (vb - va)));

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

  const { levels, interval } = scale;
  const byLevel = levels.map<[number, number][][]>(() => []);
  if (levels.length === 0) return { type: 'FeatureCollection', features: [] };
  const first = levels[0];

  // Per level, only the cells whose corner range straddles it can hold a crossing. Walking
  // cells on the outside and slicing to that range turns the cost from cells x levels into
  // roughly cells, which is what keeps the detail handle interactive: at detail 4 the
  // supersampled grid has ~16x the cells and the finer interval ~4x the levels, so the
  // naive product is ~64x the work.
  for (let y = 0; y < lats.length - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const bl = at(x, y), br = at(x + 1, y), tr = at(x + 1, y + 1), tl = at(x, y + 1);
      const lo = Math.min(bl, br, tr, tl);
      const hi = Math.max(bl, br, tr, tl);
      const from = Math.max(0, Math.ceil((lo - first) / interval));
      const to = Math.min(levels.length - 1, Math.floor((hi - first) / interval));

      for (let li = from; li <= to; li++) {
        const level = levels[li];
        const idx = (bl > level ? 1 : 0) | (br > level ? 2 : 0) | (tr > level ? 4 : 0) | (tl > level ? 8 : 0);
        if (idx === 0 || idx === 15) continue;

        // Crossing points as plain numbers. Allocating a closure per edge per cell, as an
        // earlier version did, dominated the runtime once the grid was supersampled.
        const bx = mix(lons[x], lons[x + 1], bl, br, level);
        const ry = mix(lats[y], lats[y + 1], br, tr, level);
        const tx = mix(lons[x], lons[x + 1], tl, tr, level);
        const ly = mix(lats[y], lats[y + 1], bl, tl, level);
        const segs = byLevel[li];
        const add = (ax: number, ay: number, bx2: number, by2: number) =>
          segs.push([project(ax, ay), project(bx2, by2)]);

        switch (idx) {
          case 1: case 14: add(lons[x], ly, bx, lats[y]); break;
          case 2: case 13: add(bx, lats[y], lons[x + 1], ry); break;
          case 3: case 12: add(lons[x], ly, lons[x + 1], ry); break;
          case 4: case 11: add(lons[x + 1], ry, tx, lats[y + 1]); break;
          case 6: case 9: add(bx, lats[y], tx, lats[y + 1]); break;
          case 7: case 8: add(lons[x], ly, tx, lats[y + 1]); break;
          case 5:
            if ((bl + br + tr + tl) / 4 > level) {
              add(lons[x], ly, tx, lats[y + 1]); add(bx, lats[y], lons[x + 1], ry);
            } else {
              add(lons[x], ly, bx, lats[y]); add(lons[x + 1], ry, tx, lats[y + 1]);
            }
            break;
          case 10:
            if ((bl + br + tr + tl) / 4 > level) {
              add(lons[x], ly, bx, lats[y]); add(lons[x + 1], ry, tx, lats[y + 1]);
            } else {
              add(lons[x], ly, tx, lats[y + 1]); add(bx, lats[y], lons[x + 1], ry);
            }
            break;
        }
      }
    }
  }

  const features = levels
    .map((level, li) => ({
      type: 'Feature' as const,
      properties: { level, major: Math.round(level / interval) % MAJOR_EVERY === 0 },
      geometry: { type: 'MultiLineString' as const, coordinates: byLevel[li] },
    }))
    .filter((f) => f.geometry.coordinates.length > 0);

  return { type: 'FeatureCollection', features };
}
