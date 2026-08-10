/**
 * One-time build step: sample the Copernicus GLO-30 DEM over the Shanghai bbox
 * into data/elevation-grid.json, with a TPI-derived depression factor.
 *
 * The output is committed, so deploys never re-download the ~100 MB of DEM.
 * Re-run with `npm run build-elevation` only when the bbox or step changes.
 */
import { writeFile } from 'node:fs/promises';
import { fromUrl } from 'geotiff';
import { computeDepression } from './tpi.js';
import type { ElevationGrid } from '../shared/types.js';

const BBOX = { lonMin: 121.2, lonMax: 121.8, latMin: 30.95, latMax: 31.45 };
const STEP = { lon: 0.003, lat: 0.0025 };
const TPI_RADIUS = 4; // ~1.1km neighborhood at ~280m cells

// Copernicus GLO-30 public COGs; tile named by its SW corner, 1°x1°.
const tileUrl = (latSW: number, lonSW: number) => {
  const name = `Copernicus_DSM_COG_10_N${latSW}_00_E${String(lonSW).padStart(3, '0')}_00_DEM`;
  return `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
};

async function loadTile(latSW: number, lonSW: number) {
  const tiff = await fromUrl(tileUrl(latSW, lonSW));
  const image = await tiff.getImage();
  const raster = (await image.readRasters({ interleave: true })) as Float32Array;
  const [ox, oy] = image.getOrigin(); // top-left lon, lat
  const [rx, ry] = image.getResolution(); // ry is negative
  const width = image.getWidth();
  return { raster, ox, oy, rx, ry, width, height: image.getHeight() };
}

/**
 * Mean of every source pixel whose centre falls in the cell's footprint.
 *
 * A cell is ~280m wide and a DEM pixel ~28m, so one nearest-neighbour pixel would
 * stand in for ~100 of them and just as easily land on a rooftop as on the street
 * beside it. That reads as noise, not topography: it left adjacent cells differing
 * by 2.0m on average, as large as the terrain signal itself, and drove 20% of the
 * grid onto the depression floor and 4% onto the ceiling. Averaging the block
 * instead is what makes the TPI neighbourhood mean measure terrain.
 */
function sample(t: Awaited<ReturnType<typeof loadTile>>, lon: number, lat: number): number {
  const clampX = (v: number) => Math.min(t.width - 1, Math.max(0, v));
  const clampY = (v: number) => Math.min(t.height - 1, Math.max(0, v));
  // rx > 0 (lon ascends with x), ry < 0 (lat descends with y), so the north edge
  // gives the low row index.
  const x0 = clampX(Math.round((lon - STEP.lon / 2 - t.ox) / t.rx));
  const x1 = clampX(Math.round((lon + STEP.lon / 2 - t.ox) / t.rx));
  const y0 = clampY(Math.round((lat + STEP.lat / 2 - t.oy) / t.ry));
  const y1 = clampY(Math.round((lat - STEP.lat / 2 - t.oy) / t.ry));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // No nodata handling: both tiles were swept pixel by pixel (25.9M values) and
      // carry no void sentinel and no NaN — GDAL_NODATA is unset on both.
      sum += t.raster[y * t.width + x];
      n++;
    }
  }
  return sum / n;
}

const lons: number[] = [];
for (let v = BBOX.lonMin; v <= BBOX.lonMax + 1e-9; v += STEP.lon) lons.push(Number(v.toFixed(5)));
const lats: number[] = [];
for (let v = BBOX.latMin; v <= BBOX.latMax + 1e-9; v += STEP.lat) lats.push(Number(v.toFixed(5)));

console.log(`grid ${lons.length} x ${lats.length}; downloading DEM tiles...`);
const tiles = { 30: await loadTile(30, 121), 31: await loadTile(31, 121) };

const elev = new Float32Array(lons.length * lats.length);
lats.forEach((lat, y) => {
  const tile = lat < 31 ? tiles[30] : tiles[31];
  lons.forEach((lon, x) => {
    elev[y * lons.length + x] = sample(tile, lon, lat);
  });
});

const depression = computeDepression(elev, lons.length, lats.length, TPI_RADIUS);
const grid: ElevationGrid = {
  lons,
  lats,
  elevation: Array.from(elev, (v) => Number(v.toFixed(1))),
  depression: Array.from(depression, (v) => Number(v.toFixed(2))),
};
await writeFile(new URL('../data/elevation-grid.json', import.meta.url), JSON.stringify(grid));
console.log(`wrote data/elevation-grid.json (${lons.length * lats.length} cells)`);
