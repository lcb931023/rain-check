import { describe, it, expect, afterEach, vi } from 'vitest';
import { CITIES } from '../shared/cities.js';

/** CONFIG reads process.env once at module load, so each case needs a fresh module registry. */
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  return (await import('../server/config.js')).CONFIG;
}

afterEach(() => vi.unstubAllEnvs());

describe('CONFIG.cities', () => {
  it('defaults to the whole registry when CITIES is unset', async () => {
    const cfg = await loadConfig({ CITIES: undefined });
    expect(cfg.cities.map((c) => c.id)).toEqual(CITIES.map((c) => c.id));
  });

  it('restricts the sweep to the listed cities, in the order given', async () => {
    const cfg = await loadConfig({ CITIES: 'zhengzhou,shanghai' });
    expect(cfg.cities.map((c) => c.id)).toEqual(['zhengzhou', 'shanghai']);
  });

  it('accepts one city, so a storm can be watched without paying for the rest', async () => {
    const cfg = await loadConfig({ CITIES: 'zhengzhou' });
    expect(cfg.cities.map((c) => c.id)).toEqual(['zhengzhou']);
  });

  it('tolerates whitespace and trailing separators', async () => {
    const cfg = await loadConfig({ CITIES: ' beijing , shanghai ,' });
    expect(cfg.cities.map((c) => c.id)).toEqual(['beijing', 'shanghai']);
  });

  it('throws on an unknown id rather than silently sweeping fewer cities', async () => {
    await expect(loadConfig({ CITIES: 'shanghai,atlantis' })).rejects.toThrow(/atlantis/);
  });
});

describe('CONFIG.fetchOnStart', () => {
  it('is off by default, so a dev restart does not spend a sweep', async () => {
    expect((await loadConfig({ FETCH_ON_START: undefined })).fetchOnStart).toBe(false);
  });

  it('accepts 1, true and yes', async () => {
    for (const v of ['1', 'true', 'TRUE', 'yes']) {
      expect((await loadConfig({ FETCH_ON_START: v })).fetchOnStart).toBe(true);
    }
  });

  it('treats 0 and empty as off', async () => {
    for (const v of ['0', '', 'false']) {
      expect((await loadConfig({ FETCH_ON_START: v })).fetchOnStart).toBe(false);
    }
  });
});
