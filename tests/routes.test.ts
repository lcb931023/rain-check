import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter } from '../server/routes.js';
import { CITIES, type City } from '../shared/cities.js';

export function makeApp(cacheDir: string, dataDir: string, cities?: City[]) {
  const app = express();
  app.use('/api', createRouter({ cacheDir, dataDir, cities }));
  return app;
}

describe('routes', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rain-routes-'));
    await writeFile(join(dir, 'rain-grid-shanghai.json'), '{"city":"shanghai"}');
    await writeFile(join(dir, 'rain-grid-beijing.json'), '{"city":"beijing"}');
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(makeApp('/tmp/none', '/tmp/none')).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/cities lists every enabled city with a centre', async () => {
    const res = await request(makeApp('/tmp/none', '/tmp/none')).get('/api/cities');
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).toEqual(CITIES.map((c) => c.id));
    const shanghai = res.body.find((c: any) => c.id === 'shanghai');
    expect(shanghai.name.zh).toBe('上海');
    // The inner-city bbox centres on People's Square.
    expect(shanghai.center[0]).toBeCloseTo(121.48, 2);
    expect(shanghai.center[1]).toBeCloseTo(31.23, 2);
  });

  it('GET /api/cities omits cities not enabled in this process', async () => {
    const only = CITIES.filter((c) => c.id === 'zhengzhou');
    const res = await request(makeApp('/tmp/none', '/tmp/none', only)).get('/api/cities');
    expect(res.body.map((c: any) => c.id)).toEqual(['zhengzhou']);
  });

  it('serves the rain cache of the requested city', async () => {
    const res = await request(makeApp(dir, dir)).get('/api/rain?city=beijing');
    expect(res.status).toBe(200);
    expect(res.body.city).toBe('beijing');
  });

  it('falls back to the first enabled city when no city is given', async () => {
    const res = await request(makeApp(dir, dir)).get('/api/rain');
    expect(res.status).toBe(200);
    expect(res.body.city).toBe('shanghai');
  });

  it('503s for an enabled city that has no cache yet, rather than another city\'s data', async () => {
    const res = await request(makeApp(dir, dir)).get('/api/rain?city=zhengzhou');
    expect(res.status).toBe(503);
  });

  it('404s an unknown city instead of reading a path built from it', async () => {
    for (const bad of ['nowhere', '../../etc/passwd', '']) {
      const res = await request(makeApp(dir, dir)).get(`/api/rain?city=${encodeURIComponent(bad)}`);
      // '' is not a registry id, so it 404s too rather than silently defaulting.
      expect(res.status).toBe(404);
    }
  });

  it('404s a city that exists in the registry but is not enabled here', async () => {
    const only = CITIES.filter((c) => c.id === 'shanghai');
    const res = await request(makeApp(dir, dir, only)).get('/api/rain?city=beijing');
    expect(res.status).toBe(404);
  });
});
