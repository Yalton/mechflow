import os from 'node:os';

/**
 * Size the worker pool by what the machine has free, not by its core count.
 *
 * Each worker renders the whole App in jsdom. Vitest's default (cores - 1)
 * on a host already running ~50 other jobs, with swap full, starved the
 * App and sidebar tests past their 5 s test and 1 s `waitFor` budgets.
 * Forced probe: on one CPU, 16 workers failed 3 of 3
 * runs and 2 workers failed 0 of 2. So: one worker per idle core (cores
 * minus the 1-minute load average) and per 512 MB of available memory,
 * at least 2 and at most the default.
 */
export function workerCount(
  cores = os.availableParallelism(),
  load = os.loadavg()[0] ?? 0,
  freeBytes = os.freemem(),
): number {
  const byCpu = Math.floor(cores - load);
  const byMemory = Math.floor(freeBytes / (512 * 1024 * 1024));
  return Math.max(2, Math.min(cores - 1, byCpu, byMemory));
}
