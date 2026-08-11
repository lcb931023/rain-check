import { describe, it, expect, vi } from 'vitest';
import { fetchPointWeather } from '../server/caiyun.js';

// Mirrors the real v2.6 payload's extra fields (verified via live probe): `nearest`
// sits alongside `local` and diverged ~10x at the same point, and hourly entries
// carry `probability`. Both are present so the assertions below pin the mapper's
// narrowing rather than passing incidentally against a thinner fixture.
const fakeResponse = {
  status: 'ok',
  result: {
    realtime: {
      precipitation: {
        local: { status: 'ok', datasource: 'radar', intensity: 2.5 },
        nearest: { status: 'ok', intensity: 7.28, distance: 1000 },
      },
    },
    hourly: {
      precipitation: [{ datetime: '2026-08-10T08:00+08:00', value: 1.2, probability: 54 }],
    },
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
    expect(url).not.toContain('begin');
  });
  it('appends begin when given, for history backfill', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeResponse });
    await fetchPointWeather(121.47, 31.23, 'TOKEN', fetchFn as any, 1786000000);
    expect(fetchFn.mock.calls[0][0] as string).toContain('begin=1786000000');
  });
  it('gives the request an abort deadline', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => fakeResponse });
    await fetchPointWeather(121.47, 31.23, 'TOKEN', fetchFn as any);
    const init = fetchFn.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false); // armed for this request, not already spent
  });
  it('throws on non-ok API status', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'failed', error: 'quota' }) });
    await expect(fetchPointWeather(121, 31, 'T', fetchFn as any)).rejects.toThrow(/quota/);
  });
  it('throws on HTTP error', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '' });
    await expect(fetchPointWeather(121, 31, 'T', fetchFn as any)).rejects.toThrow(/429/);
  });

  it('carries the error body, which is what separates throttling from an exhausted quota', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"status":"failed","error":"exceed the total number of requests"}',
    });
    await expect(fetchPointWeather(121, 31, 'T', fetchFn as any))
      .rejects.toThrow(/429.*exceed the total number of requests/);
  });

  it('still reports the status when the body cannot be read', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => { throw new Error('stream already consumed'); },
    });
    await expect(fetchPointWeather(121, 31, 'T', fetchFn as any)).rejects.toThrow(/caiyun HTTP 503/);
  });

  it('never leaks the token into the thrown message', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'nope' });
    await expect(fetchPointWeather(121, 31, 'SECRET-TOKEN', fetchFn as any))
      .rejects.toThrow(expect.not.stringContaining('SECRET-TOKEN') as any);
  });
});
