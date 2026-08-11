import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Roll into a single .1 file past this size, so a long-running server cannot fill the disk. */
const MAX_BYTES = 5_000_000;

let logFile: string | null = null;
let queue: Promise<void> = Promise.resolve();

/** Until this is called nothing is written to disk, which keeps tests off the filesystem. */
export function initLog(path: string): void { logFile = path; }

function append(level: string, args: unknown[]): void {
  if (!logFile) return;
  const line = `${new Date().toISOString()} ${level} ${args.map((a) => String(a)).join(' ')}\n`;
  // Chained rather than awaited: serialising the appends stops two writers interleaving
  // mid-line, and detaching them stops a slow disk from stalling a sweep. A failed write
  // is swallowed on purpose — logging must never be the thing that breaks the fetcher.
  queue = queue
    .then(async () => {
      const file = logFile!;
      await mkdir(dirname(file), { recursive: true });
      const size = await stat(file).then((s) => s.size).catch(() => 0);
      if (size > MAX_BYTES) await rename(file, `${file}.1`).catch(() => {});
      await appendFile(file, line);
    })
    .catch(() => {});
}

export const log = (...a: unknown[]) => { console.log(...a); append('INFO', a); };
export const warn = (...a: unknown[]) => { console.warn(...a); append('WARN', a); };
export const error = (...a: unknown[]) => { console.error(...a); append('ERROR', a); };

/**
 * File-only. Per-point request lines are what make a rate-limit or quota failure
 * diagnosable after the fact (their timestamps show the real spacing between calls),
 * but there are one per point per sweep, so they stay out of the console.
 */
export const trace = (...a: unknown[]) => append('TRACE', a);
