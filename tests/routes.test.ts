import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter } from '../server/routes.js';

export function makeApp(cacheDir: string, dataDir: string) {
  const app = express();
  app.use('/api', createRouter({ cacheDir, dataDir }));
  return app;
}

describe('routes', () => {
  it('GET /api/health returns ok', async () => {
    const res = await request(makeApp('/tmp/none', '/tmp/none')).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
