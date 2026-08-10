import 'dotenv/config';
import express from 'express';
import { CONFIG } from './config.js';
import { createRouter } from './routes.js';

const app = express();
app.use('/api', createRouter({ cacheDir: CONFIG.cacheDir, dataDir: CONFIG.dataDir }));
app.use(express.static(CONFIG.distDir));

app.listen(CONFIG.port, () => console.log(`server on :${CONFIG.port}`));
