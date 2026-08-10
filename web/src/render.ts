export const FLOOD_BANDS = { possible: 5, severe: 30 };

// Piecewise-linear ramp: value (flood index, mm-equivalent) -> [r,g,b,alpha0-255]
const STOPS: [number, [number, number, number, number]][] = [
  [0, [126, 184, 255, 0]],
  [FLOOD_BANDS.possible, [126, 184, 255, 64]],
  [FLOOD_BANDS.severe, [46, 107, 230, 140]],
  [80, [11, 46, 138, 217]],
];

export function floodColor(v: number): [number, number, number, number] {
  if (v <= 0) return [126, 184, 255, 0];
  const last = STOPS[STOPS.length - 1];
  if (v >= last[0]) return [...last[1]];
  let i = 0;
  while (STOPS[i + 1][0] < v) i++;
  const [v0, c0] = STOPS[i];
  const [v1, c1] = STOPS[i + 1];
  const t = (v - v0) / (v1 - v0);
  return [0, 1, 2, 3].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as [number, number, number, number];
}

export function drawFloodCanvas(
  ctx: CanvasRenderingContext2D,
  flood: Float32Array,
  w: number,
  h: number,
): void {
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y; // lats ascend south->north; canvas rows go top->bottom
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = floodColor(flood[srcRow * w + x]);
      const o = (y * w + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}
