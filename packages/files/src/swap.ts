import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { hashYaml, hashesMatch } from "./hash.js";

/**
 * Compare-and-swap writes for model files, shared by every writer (the HTTP
 * server and the MCP server run as separate processes).
 *
 * A plain "read, compare hash, rename over" has a window between the compare
 * and the rename where another process can write and then be silently
 * overwritten. Instead the swap takes the current file out of the way with an
 * atomic `rename` (so no later writer can change what we compare), checks its
 * hash, and publishes with `link`, which fails rather than replacing a file
 * another writer created in the meantime. Either way at most one writer wins
 * and the loser sees a conflict. No lock files, so a crashed writer cannot
 * wedge the others; at worst it leaves a hidden temp file behind.
 *
 * The cost is a brief window where the model path does not exist. Readers use
 * {@link readModelText}, which retries through it, and the watcher debounces
 * removals.
 */

/** Outcome of {@link compareAndSwapFileSync}. */
export type SwapResult =
  | { ok: true; hash: string }
  /** The file did not hold the expected content; `current` is what it holds now. */
  | { ok: false; hash: string | null; current: string | null };

/**
 * Write `data` to `target` only if its current content hash is `expected`.
 *
 * - `expected` a hash: replace the file if it still hashes to it. A missing
 *   file is a conflict (`current` null): it may only be moved aside by another
 *   writer's swap, and its content must not be lost. Write unconditionally to
 *   recreate a deleted model.
 * - `expected` `null`: create the file only if it does not exist.
 * - `expected` `undefined`: replace unconditionally (still atomic).
 */
export function compareAndSwapFileSync(
  target: string,
  data: string,
  expected?: string | null,
): SwapResult {
  const tmp = tempPath(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, data, "utf8");
  try {
    if (expected === undefined) {
      renameSync(tmp, target);
      return { ok: true, hash: hashYaml(data) };
    }
    if (expected === null) return publish(tmp, target, data);

    const staged = tempPath(target);
    if (!retryOnMissing(() => renameSync(target, staged))) return conflict(target);
    try {
      if (!hashesMatch(hashYaml(readFileSync(staged, "utf8")), expected)) {
        // Put it back unless another writer already published a newer file,
        // which would have replaced this one anyway.
        linkIfAbsent(staged, target);
        return conflict(target);
      }
      return publish(tmp, target, data);
    } finally {
      if (existsSync(staged)) unlinkSync(staged);
    }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** Unconditional atomic write (temp file + rename). */
export function writeFileAtomicSync(target: string, data: string): void {
  compareAndSwapFileSync(target, data);
}

/**
 * Read a model file, or `null` when it does not exist. Retries briefly on
 * ENOENT, since a concurrent {@link compareAndSwapFileSync} moves the file
 * aside for an instant.
 */
export function readModelText(target: string): string | null {
  let text: string | null = null;
  return retryOnMissing(() => (text = readFileSync(target, "utf8"))) ? text : null;
}

/**
 * True when `target` is a regular file. Like {@link readModelText}, retries
 * briefly while a concurrent swap has the file moved aside.
 */
export function isModelFileSync(target: string): boolean {
  let file = false;
  return retryOnMissing(() => (file = statSync(target).isFile())) && file;
}

/**
 * Temp file next to `target`. Hidden and named `.<file>.tmp-<pid>-<uuid>` so the
 * server's watcher can ignore it.
 */
export function tempPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
}

/**
 * Backoff (ms) while a file is missing. A swap keeps the file aside for
 * microseconds, but the writer can be descheduled in that window, so allow
 * about half a second before calling the file gone.
 */
const MISSING_BACKOFF_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run `op`, retrying with backoff while it fails with ENOENT (the file may be
 * moved aside by another writer's swap). False if the file stayed missing.
 */
function retryOnMissing(op: () => void): boolean {
  for (let attempt = 0; ; attempt++) {
    try {
      op();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const delay = MISSING_BACKOFF_MS[attempt];
      if (delay === undefined) return false;
      Atomics.wait(sleeper, 0, 0, delay);
    }
  }
}

function publish(tmp: string, target: string, data: string): SwapResult {
  return linkIfAbsent(tmp, target) ? { ok: true, hash: hashYaml(data) } : conflict(target);
}

/** Hard-link `source` to `target`; false if `target` already exists. */
function linkIfAbsent(source: string, target: string): boolean {
  try {
    linkSync(source, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function conflict(target: string): SwapResult {
  const current = readModelText(target);
  return { ok: false, hash: current === null ? null : hashYaml(current), current };
}
