import type { BBox } from '../../shared/cities.js';
import type { RainGrid, ElevationGrid, Report } from '../../shared/types.js';

export interface CityInfo {
  id: string;
  name: { zh: string; en: string };
  center: [number, number];
  bbox: BBox;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
const q = (city: string) => `?city=${encodeURIComponent(city)}`;

export const fetchCities = () => getJson<CityInfo[]>('/api/cities');
export const fetchRain = (city: string) => getJson<RainGrid>(`/api/rain${q(city)}`);
export const fetchElevation = (city: string) => getJson<ElevationGrid>(`/api/elevation${q(city)}`);
export const fetchReports = (city: string) => getJson<Report[]>(`/api/reports${q(city)}`);
