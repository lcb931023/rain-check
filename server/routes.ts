import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createRouter(opts: { cacheDir: string; dataDir: string }) {
  const r = Router();
  r.get('/health', (_req, res) => res.json({ ok: true }));

  const serveJson = (path: string, missingStatus: number) => async (_req: any, res: any) => {
    try {
      res.type('json').send(await readFile(path, 'utf8'));
    } catch {
      res.status(missingStatus).json({ error: 'not available yet' });
    }
  };
  r.get('/rain', (req, res) => serveJson(join(opts.cacheDir, 'rain-grid.json'), 503)(req, res));
  r.get('/elevation', (req, res) => serveJson(join(opts.dataDir, 'elevation-grid.json'), 500)(req, res));
  r.get('/reports', (req, res) => serveJson(join(opts.dataDir, 'reports.json'), 500)(req, res));
  return r;
}
