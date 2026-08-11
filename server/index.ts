import 'dotenv/config';
import express from 'express';
import { CONFIG } from './config.js';
import { createRouter } from './routes.js';
import { startFetcherLoop } from './fetcher.js';

const app = express();
app.use('/api', createRouter({ cacheDir: CONFIG.cacheDir, dataDir: CONFIG.dataDir, cities: CONFIG.cities }));
app.use(express.static(CONFIG.distDir));

startFetcherLoop();

app.listen(CONFIG.port, () => console.log(`server on :${CONFIG.port}`));
