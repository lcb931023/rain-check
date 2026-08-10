/**
 * Topographic Position Index -> depression factor.
 *
 * depression[i] = clamp(1 + 0.6 * (meanNeighborhood - elev[i]), 0.2, 3)
 *
 * The neighborhood is a square box of +/-`radius` cells around the cell,
 * clipped at the grid edges, and it includes the cell itself. Cells that sit
 * below their surroundings (hollows) come out above 1; ridges come out below 1.
 */
export function computeDepression(
  elev: Float32Array,
  w: number,
  h: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          sum += elev[yy * w + xx];
          n++;
        }
      }
      const tpi = sum / n - elev[y * w + x];
      out[y * w + x] = Math.min(3, Math.max(0.2, 1 + 0.6 * tpi));
    }
  }
  return out;
}
