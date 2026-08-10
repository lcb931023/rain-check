import { describe, it, expect, vi } from 'vitest';
import { fetchPointWeather } from '../server/caiyun.js';

const fakeResponse = {
  status: 'ok',
  result: {
    realtime: { precipitation: { local: { intensity: 2.5 } } },
    hourly: { precipitation: [{ datetime: '2026-08-10T08:00+08:00', value: 1.2 }] },
  },
};

describe('fetchPointWeather', () => {
  it('extracts realtime intensity and hourly precipitation', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeResponse });
    const out = await fetchPointWeather(121.47, 31.23, 'TOKEN', fetchFn as any);
    expect(out.realtimeIntensity).toBe(2.5);
    expect(out.hourly[0]).toEqual({ datetime: '2026-08-10T08:00+08:00', value: 1.2 });
    const url = (fetchFn.mock.calls[0][0] as string);
    expect(url).toContain('/TOKEN/121.47,31.23/weather');
    expect(url).toContain('hourlysteps=48');
  });
  it('throws on non-ok API status', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'failed', error: 'quota' }) });
    await expect(fetchPointWeather(121, 31, 'T', fetchFn as any)).rejects.toThrow(/quota/);
  });
  it('throws on HTTP error', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(fetchPointWeather(121, 31, 'T', fetchFn as any)).rejects.toThrow(/429/);
  });
});
