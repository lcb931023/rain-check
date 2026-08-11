import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CITIES, cityCenter, elevationFile, rainCacheFile, reportsFile, type City,
} from '../shared/cities.js';

export function createRouter(opts: { cacheDir: string; dataDir: string; cities?: City[] }) {
  const cities = opts.cities ?? CITIES;
  const r = Router();
  r.get('/health', (_req, res) => res.json({ ok: true }));

  r.get('/cities', (_req, res) => res.json(
    cities.map((c) => ({ id: c.id, name: c.name, center: cityCenter(c), bbox: c.bbox })),
  ));

  /**
   * Resolves ?city= to a registry entry and takes the filename from that entry, so an id
   * never reaches a path — `?city=../../etc/passwd` is a 404, not a traversal. Omitting
   * the param falls back to the first enabled city, which keeps the bare /api/rain working.
   */
  const serveCityJson = (
    dir: string,
    fileFor: (id: string) => string,
    missingStatus: number,
  ) => async (req: any, res: any) => {
    const id = typeof req.query.city === 'string' ? req.query.city : cities[0].id;
    const city = cities.find((c) => c.id === id);
    if (!city) return res.status(404).json({ error: `unknown city: ${id}` });
    try {
      res.type('json').send(await readFile(join(dir, fileFor(city.id)), 'utf8'));
    } catch {
      res.status(missingStatus).json({ error: 'not available yet' });
    }
  };

  r.get('/rain', serveCityJson(opts.cacheDir, rainCacheFile, 503));
  r.get('/elevation', serveCityJson(opts.dataDir, elevationFile, 500));
  r.get('/reports', serveCityJson(opts.dataDir, reportsFile, 500));
  return r;
}
