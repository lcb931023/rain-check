import type { RainGrid, ElevationGrid, Report } from '../../shared/types.js';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
export const fetchRain = () => getJson<RainGrid>('/api/rain');
export const fetchElevation = () => getJson<ElevationGrid>('/api/elevation');
export const fetchReports = () => getJson<Report[]>('/api/reports');
