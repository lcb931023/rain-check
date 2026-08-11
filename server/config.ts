import { CITIES, findCity, type City } from '../shared/cities.js';

/**
 * Every enabled city costs a full 182-point sweep against the same Caiyun quota pool,
 * so CITIES=shanghai,zhengzhou trims the sweep to what you actually watch. Unset means
 * the whole registry. An unknown id fails at startup rather than silently sweeping less.
 */
function enabledCities(): City[] {
  const ids = process.env.CITIES?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids?.length) return CITIES;
  return ids.map((id) => {
    const city = findCity(id);
    if (!city) throw new Error(`unknown city in CITIES: ${id} (known: ${CITIES.map((c) => c.id).join(', ')})`);
    return city;
  });
}

export const CONFIG = {
  port: Number(process.env.PORT ?? 8787),
  cities: enabledCities(),
  refreshMinutes: Number(process.env.RAIN_REFRESH_MINUTES ?? 180),
  fetchOnStart: /^(1|true|yes)$/i.test(process.env.FETCH_ON_START ?? ''),
  cacheDir: new URL('../cache/', import.meta.url).pathname,
  logDir: new URL('../logs/', import.meta.url).pathname,
  dataDir: new URL('../data/', import.meta.url).pathname,
  distDir: new URL('../dist/', import.meta.url).pathname,
};
