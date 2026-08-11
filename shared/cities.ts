export interface BBox { lonMin: number; lonMax: number; latMin: number; latMax: number }

export interface City {
  id: string;
  name: { zh: string; en: string };
  bbox: BBox;
  /** Caiyun sample spacing; ~0.6 x 0.5 deg at this step is a 14 x 13 = 182-point sweep. */
  rainStep: { lon: number; lat: number };
  /** DEM cell spacing; 0.6 x 0.5 deg at this step is a 201 x 201 grid of ~280 m cells. */
  elevStep: { lon: number; lat: number };
}

const RAIN_STEP = { lon: 0.045, lat: 0.04 };
const ELEV_STEP = { lon: 0.003, lat: 0.0025 };

/**
 * Each bbox covers only the inner city — roughly Shanghai's Inner Ring plus Lujiazui and
 * Xujiahui, Beijing inside the 3rd/4th Ring, Zhengzhou's Erqi core plus Zhengdong New
 * District. About 0.2 deg on a side rather than the 0.6 x 0.5 these started as, which
 * drops a sweep from 182 points per city to 20-25 and keeps every city inside a single
 * 1-degree DEM tile.
 *
 * `latMax` for Beijing stops at 39.99 on purpose: 40.0 would spill into the N40 tile for
 * one row of pixels and double that city's DEM download for nothing.
 */
export const CITIES: City[] = [
  {
    id: 'shanghai',
    name: { zh: '上海', en: 'Shanghai' },
    bbox: { lonMin: 121.38, lonMax: 121.58, latMin: 31.15, latMax: 31.31 },
    rainStep: RAIN_STEP,
    elevStep: ELEV_STEP,
  },
  {
    id: 'beijing',
    name: { zh: '北京', en: 'Beijing' },
    bbox: { lonMin: 116.28, lonMax: 116.5, latMin: 39.84, latMax: 39.99 },
    rainStep: RAIN_STEP,
    elevStep: ELEV_STEP,
  },
  {
    id: 'zhengzhou',
    name: { zh: '郑州', en: 'Zhengzhou' },
    bbox: { lonMin: 113.56, lonMax: 113.78, latMin: 34.68, latMax: 34.84 },
    rainStep: RAIN_STEP,
    elevStep: ELEV_STEP,
  },
];

export const findCity = (id: string | undefined | null): City | undefined =>
  CITIES.find((c) => c.id === id);

export const cityCenter = (c: City): [number, number] => [
  (c.bbox.lonMin + c.bbox.lonMax) / 2,
  (c.bbox.latMin + c.bbox.latMax) / 2,
];

/** Both cache and data files are named per city, so one server holds every city's grids. */
export const rainCacheFile = (id: string) => `rain-grid-${id}.json`;
export const elevationFile = (id: string) => `elevation-grid-${id}.json`;
export const reportsFile = (id: string) => `reports-${id}.json`;
