export const CONFIG = {
  port: Number(process.env.PORT ?? 8787),
  bbox: { lonMin: 121.2, lonMax: 121.8, latMin: 30.95, latMax: 31.45 },
  rainStep: { lon: 0.045, lat: 0.04 },
  refreshMinutes: Number(process.env.RAIN_REFRESH_MINUTES ?? 180),
  cacheDir: new URL('../cache/', import.meta.url).pathname,
  dataDir: new URL('../data/', import.meta.url).pathname,
  distDir: new URL('../dist/', import.meta.url).pathname,
};
