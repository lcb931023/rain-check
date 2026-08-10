export interface RainGrid {
  fetchedAt: string;          // ISO timestamp of last successful fetch
  lons: number[];             // ascending rain-grid point lons
  lats: number[];             // ascending rain-grid point lats
  hours: string[];            // ISO hour starts, ascending, ~-24h .. +48h
  nowIndex: number;           // index into hours for the current hour
  /** mm/h; indexed [hourIdx][latIdx][lonIdx]; null = missing */
  precip: (number | null)[][][];
}

export interface ElevationGrid {
  lons: number[];             // cell-center lons, ascending
  lats: number[];             // cell-center lats, ascending
  elevation: number[];        // meters, row-major [latIdx * lons.length + lonIdx]
  depression: number[];       // unitless factor >= 0, same indexing
}

export interface Report {
  id: string;
  lon: number;                // WGS-84
  lat: number;
  severity: 1 | 2 | 3;        // 1 = minor, 3 = severe
  title: string;
  source: string;             // e.g. "上海发布"
  url?: string;
  time: string;               // ISO
}
