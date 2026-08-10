export interface CellWeights { idx: Uint32Array; w: Float32Array } // 4 entries per cell

function bracket(arr: number[], v: number): [number, number, number] {
  // returns [i0, i1, t] such that arr[i0] <= v <= arr[i1], t in [0,1]; clamped at edges
  if (v <= arr[0]) return [0, 0, 0];
  const last = arr.length - 1;
  if (v >= arr[last]) return [last, last, 0];
  let i = 0;
  while (arr[i + 1] < v) i++;
  return [i, i + 1, (v - arr[i]) / (arr[i + 1] - arr[i])];
}

export function precomputeCellWeights(
  rain: { lons: number[]; lats: number[] },
  cells: { lons: number[]; lats: number[] },
): CellWeights {
  const n = cells.lons.length * cells.lats.length;
  const idx = new Uint32Array(n * 4);
  const w = new Float32Array(n * 4);
  const W = rain.lons.length;
  let c = 0;
  for (const lat of cells.lats) {
    const [y0, y1, ty] = bracket(rain.lats, lat);
    for (const lon of cells.lons) {
      const [x0, x1, tx] = bracket(rain.lons, lon);
      idx[c * 4 + 0] = y0 * W + x0;
      idx[c * 4 + 1] = y0 * W + x1;
      idx[c * 4 + 2] = y1 * W + x0;
      idx[c * 4 + 3] = y1 * W + x1;
      w[c * 4 + 0] = (1 - ty) * (1 - tx);
      w[c * 4 + 1] = (1 - ty) * tx;
      w[c * 4 + 2] = ty * (1 - tx);
      w[c * 4 + 3] = ty * tx;
      c++;
    }
  }
  return { idx, w };
}

export function rainAtCells(
  precipHour: (number | null)[][],
  weights: CellWeights,
  nRainLons: number,
): Float32Array {
  const flat = new Float32Array(precipHour.length * nRainLons);
  for (let y = 0; y < precipHour.length; y++)
    for (let x = 0; x < nRainLons; x++)
      flat[y * nRainLons + x] = precipHour[y][x] ?? 0;
  const n = weights.idx.length / 4;
  const out = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    out[c] =
      flat[weights.idx[c * 4]] * weights.w[c * 4] +
      flat[weights.idx[c * 4 + 1]] * weights.w[c * 4 + 1] +
      flat[weights.idx[c * 4 + 2]] * weights.w[c * 4 + 2] +
      flat[weights.idx[c * 4 + 3]] * weights.w[c * 4 + 3];
  }
  return out;
}
