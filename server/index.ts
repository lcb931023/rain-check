import 'dotenv/config';
import express from 'express';
import { join } from 'node:path';
import { CONFIG } from './config.js';
import { createRouter } from './routes.js';
import { startFetcherLoop } from './fetcher.js';
import { initLog, log } from './log.js';

const app = express();
app.use('/api', createRouter({ cacheDir: CONFIG.cacheDir, dataDir: CONFIG.dataDir, cities: CONFIG.cities }));
app.use(express.static(CONFIG.distDir));

initLog(join(CONFIG.logDir, 'server.log'));
// The startup line is what dates a log: without it there is no way to tell which run a
// later error belongs to, or whether a restart sat between two of them. Never the token.
log(`server starting: port=${CONFIG.port} cities=${CONFIG.cities.map((c) => c.id).join(',')}`
  + ` refreshMinutes=${CONFIG.refreshMinutes} fetchOnStart=${CONFIG.fetchOnStart}`
  + ` token=${process.env.CAIYUN_API_TOKEN ? 'set' : 'MISSING'}`);

startFetcherLoop();

app.listen(CONFIG.port, () => log(`server on :${CONFIG.port}`));
