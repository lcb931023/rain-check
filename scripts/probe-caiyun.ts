import 'dotenv/config';
import { fetchPointWeather } from '../server/caiyun.js';

const token = process.env.CAIYUN_API_TOKEN;
if (!token) throw new Error('CAIYUN_API_TOKEN missing from .env');
const out = await fetchPointWeather(121.4737, 31.2304, token);
console.log('realtime mm/h:', out.realtimeIntensity);
console.log('first 3 hourly:', out.hourly.slice(0, 3));
console.log('hourly count:', out.hourly.length);
