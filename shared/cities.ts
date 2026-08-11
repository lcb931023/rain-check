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
 * Each bbox is ~0.6 deg lon x 0.5 deg lat around the urban core, which keeps every city
 * on the same grid dimensions (182 rain points, 201 x 201 cells) and so on the same
 * per-city quota cost. Bounds follow the built-up area, not the municipal boundary:
 * Shanghai's outer ring plus Pudong, Beijing's 6th Ring, Zhengzhou's urban districts
 * plus Zhengdong New District.
 */
export const CITIES: City[] = [
  {
    id: 'shanghai',
    name: { zh: '上海', en: 'Shanghai' },
    bbox: { lonMin: 121.2, lonMax: 121.8, latMin: 30.95, latMax: 31.45 },
    rainStep: RAIN_STEP,
    elevStep: ELEV_STEP,
  },
  {
    id: 'beijing',
    name: { zh: '北京', en: 'Beijing' },
    bbox: { lonMin: 116.1, lonMax: 116.7, latMin: 39.7, latMax: 40.2 },
    rainStep: RAIN_STEP,
    elevStep: ELEV_STEP,
  },
  {
    id: 'zhengzhou',
    name: { zh: '郑州', en: 'Zhengzhou' },
    bbox: { lonMin: 113.35, lonMax: 113.95, latMin: 34.5, latMax: 35.0 },
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
