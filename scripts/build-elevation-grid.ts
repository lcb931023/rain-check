/**
 * One-time build step: sample the Copernicus GLO-30 DEM over a city's bbox into
 * data/elevation-grid-<city>.json, with a TPI-derived depression factor.
 *
 * The outputs are committed, so deploys never re-download the ~100 MB per DEM tile.
 * Re-run only when a bbox or step changes:
 *   npm run build-elevation -- beijing     # one city
 *   npm run build-elevation -- all         # every city in the registry
 */
import { writeFile } from 'node:fs/promises';
import { fromUrl, Pool } from 'geotiff';
import { computeDepression } from './tpi.js';
import { CITIES, elevationFile, findCity, type BBox, type City } from '../shared/cities.js';
import type { ElevationGrid } from '../shared/types.js';

const TPI_RADIUS = 4; // ~1.1km neighborhood at ~280m cells

// Copernicus GLO-30 public COGs; tile named by its SW corner, 1°x1°.
const tileUrl = (latSW: number, lonSW: number) => {
  const name = `Copernicus_DSM_COG_10_N${latSW}_00_E${String(lonSW).padStart(3, '0')}_00_DEM`;
  return `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
};

// S3 throttles many parallel block fetches, so retry and cap concurrency.
const fetchPool = new Pool(8);

/**
 * Reads only the pixel window the bbox touches, not the whole 1°x1° tile. An inner-city
 * box is ~3% of a tile's area, and since these COGs are fetched over HTTP range requests
 * that is the difference between a ~100 MB download and a couple of MB. The window is
 * grown by half a cell on each side because sample() averages over a cell's footprint,
 * and clamped to the tile, so a bbox running off the tile edge reads to the edge.
 */
async function loadTileOnce(
  latSW: number,
  lonSW: number,
  bbox: BBox,
  step: { lon: number; lat: number },
) {
  const tiff = await fromUrl(tileUrl(latSW, lonSW), { retry: 5, pool: fetchPool });
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin(); // top-left lon, lat
  const [rx, ry] = image.getResolution(); // ry is negative
  const tileW = image.getWidth();
  const tileH = image.getHeight();

  const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  // rx > 0 (lon ascends with x), ry < 0 (lat descends with y), so latMax gives the low row.
  const x0 = clamp(Math.floor((bbox.lonMin - step.lon / 2 - ox) / rx), tileW - 1);
  const x1 = clamp(Math.ceil((bbox.lonMax + step.lon / 2 - ox) / rx), tileW - 1);
  const y0 = clamp(Math.floor((bbox.latMax + step.lat / 2 - oy) / ry), tileH - 1);
  const y1 = clamp(Math.ceil((bbox.latMin - step.lat / 2 - oy) / ry), tileH - 1);
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;

  // geotiff's window is [left, top, right, bottom) with the right/bottom edges exclusive.
  const raster = (await image.readRasters({
    interleave: true,
    window: [x0, y0, x1 + 1, y1 + 1],
  })) as Float32Array;
  const pct = ((width * height) / (tileW * tileH) * 100).toFixed(1);
  console.log(`  tile ${latSW}/${lonSW}: read ${width}x${height} px (${pct}% of tile)`);
  return { raster, ox, oy, rx, ry, x0, y0, width, height };
}

// The initial header fetch can also fail transiently; geotiff's internal retry
// does not fully cover it, so retry the whole tile load a few times.
async function loadTile(
  latSW: number,
  lonSW: number,
  bbox: BBox,
  step: { lon: number; lat: number },
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await loadTileOnce(latSW, lonSW, bbox, step);
    } catch (err) {
      if (attempt >= 5) throw err;
      console.warn(`tile ${latSW}/${lonSW} failed (${String(err)}); retrying ${attempt + 1}/5...`);
    }
  }
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
function sample(
  t: Awaited<ReturnType<typeof loadTile>>,
  lon: number,
  lat: number,
  STEP: { lon: number; lat: number },
): number {
  // Pixel coords are absolute within the tile, but the raster only holds the window, so
  // they are clamped to the window's bounds and shifted by its origin on the way in.
  const clampX = (v: number) => Math.min(t.x0 + t.width - 1, Math.max(t.x0, v));
  const clampY = (v: number) => Math.min(t.y0 + t.height - 1, Math.max(t.y0, v));
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
      // No nodata handling: the two Shanghai tiles were swept pixel by pixel (25.9M
      // values) and carry no void sentinel and no NaN — GDAL_NODATA is unset on both.
      // Other cities' tiles are not individually verified, so buildCity range-checks
      // its output instead; Copernicus voids would surface there as absurd elevations.
      sum += t.raster[(y - t.y0) * t.width + (x - t.x0)];
      n++;
    }
  }
  return sum / n;
}

const axis = (min: number, max: number, step: number) => {
  const out: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(5)));
  return out;
};

/** Tile key for the 1°x1° cell a point falls in; a bbox spanning a whole degree needs several. */
const tileKey = (lat: number, lon: number) => `${Math.floor(lat)}/${Math.floor(lon)}`;

async function buildCity(city: City): Promise<void> {
  const { bbox, elevStep: STEP } = city;
  const lons = axis(bbox.lonMin, bbox.lonMax, STEP.lon);
  const lats = axis(bbox.latMin, bbox.latMax, STEP.lat);

  // Every 1°x1° tile the bbox touches, not just the corner ones: a bbox wider than a
  // degree also covers interior tiles, and a missing one would fault while sampling.
  const keys = new Set<string>();
  for (let lat = Math.floor(bbox.latMin); lat <= Math.floor(bbox.latMax); lat++) {
    for (let lon = Math.floor(bbox.lonMin); lon <= Math.floor(bbox.lonMax); lon++) {
      keys.add(tileKey(lat, lon));
    }
  }
  console.log(`${city.id}: grid ${lons.length} x ${lats.length}; downloading ${keys.size} DEM tile(s) ${[...keys].join(' ')}...`);

  const tiles = new Map<string, Awaited<ReturnType<typeof loadTile>>>();
  for (const key of keys) {
    const [lat, lon] = key.split('/').map(Number);
    tiles.set(key, await loadTile(lat, lon, bbox, STEP));
  }

  const elev = new Float32Array(lons.length * lats.length);
  lats.forEach((lat, y) => {
    lons.forEach((lon, x) => {
      elev[y * lons.length + x] = sample(tiles.get(tileKey(lat, lon))!, lon, lat, STEP);
    });
  });

  // A tile carrying void sentinels (-32767 and friends) would otherwise be written out as
  // plausible-looking terrain, so fail loudly instead of committing a garbage grid.
  const lo = Math.min(...elev), hi = Math.max(...elev);
  if (!Number.isFinite(lo) || lo < -100 || hi > 9000) {
    throw new Error(`${city.id}: implausible elevations ${lo}..${hi} m — check the DEM tiles for voids`);
  }
  console.log(`${city.id}: elevation ${lo.toFixed(1)}..${hi.toFixed(1)} m`);

  const depression = computeDepression(elev, lons.length, lats.length, TPI_RADIUS);
  const grid: ElevationGrid = {
    lons,
    lats,
    elevation: Array.from(elev, (v) => Number(v.toFixed(1))),
    depression: Array.from(depression, (v) => Number(v.toFixed(2))),
  };
  const name = elevationFile(city.id);
  await writeFile(new URL(`../data/${name}`, import.meta.url), JSON.stringify(grid));
  console.log(`wrote data/${name} (${lons.length * lats.length} cells)`);
}

const arg = process.argv[2];
const targets = arg === 'all' ? CITIES : [findCity(arg)];
if (!targets[0]) {
  console.error(`usage: npm run build-elevation -- <${CITIES.map((c) => c.id).join('|')}|all>`);
  process.exit(1);
}
for (const city of targets as City[]) await buildCity(city);

// geotiff's Pool holds worker threads open, which keep the event loop alive: without this
// the script sits there after writing its output, looking like it is still downloading.
await fetchPool.destroy();
