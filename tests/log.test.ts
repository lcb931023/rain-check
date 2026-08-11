import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The module holds the log path in module state, so each case gets a fresh copy. */
async function freshLogger() {
  vi.resetModules();
  return import('../server/log.js');
}
const dir = () => mkdtemp(join(tmpdir(), 'rain-log-'));
/** Appends are detached from the caller, so give the queue a turn before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => vi.restoreAllMocks());

describe('log', () => {
  it('writes nothing to disk until initLog names a file', async () => {
    const d = await dir();
    const { log } = await freshLogger();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    log('before init');
    await settle();
    expect(await readdir(d)).toEqual([]);
  });

  it('appends timestamped, levelled lines', async () => {
    const d = await dir();
    const file = join(d, 'server.log');
    const { initLog, log, warn, error } = await freshLogger();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    initLog(file);
    log('hello', 42);
    warn('careful');
    error('boom');
    await settle();

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO hello 42$/);
    expect(lines[1]).toContain('WARN careful');
    expect(lines[2]).toContain('ERROR boom');
  });

  it('still mirrors everything to the console', async () => {
    const { initLog, log } = await freshLogger();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    initLog(join(await dir(), 'server.log'));
    log('visible');
    expect(spy).toHaveBeenCalledWith('visible');
  });

  it('keeps trace out of the console but in the file', async () => {
    const d = await dir();
    const file = join(d, 'server.log');
    const { initLog, trace } = await freshLogger();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    initLog(file);
    trace('per-point detail');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toContain('TRACE per-point detail');
  });

  it('rolls the file once it passes the size cap', async () => {
    const d = await dir();
    const file = join(d, 'server.log');
    await writeFile(file, 'x'.repeat(5_000_001));
    const { initLog, log } = await freshLogger();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    initLog(file);
    log('after roll');
    await settle();

    expect((await readdir(d)).sort()).toEqual(['server.log', 'server.log.1']);
    expect(await readFile(file, 'utf8')).toContain('after roll'); // fresh file, not the old bulk
  });

  it('does not throw when the log cannot be written', async () => {
    // A path whose parent is a file, so mkdir and appendFile both fail.
    const d = await dir();
    const blocker = join(d, 'blocker');
    await writeFile(blocker, '');
    const { initLog, log } = await freshLogger();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    initLog(join(blocker, 'server.log'));
    expect(() => log('swallowed')).not.toThrow();
    await settle();
  });
});
