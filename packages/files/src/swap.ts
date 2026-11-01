import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
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
 * removals. A writer that crashes inside that window leaves the model only
 * under its aside name ({@link asidePath}); readers put a stale one back with
 * {@link recoverStaleModel}.
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

    const staged = asidePath(target);
    if (!retryOnMissing(() => renameSync(target, staged))) return conflict(target);
    let keepStaged = false;
    try {
      if (!hashesMatch(hashYaml(readFileSync(staged, "utf8")), expected)) {
        // Put it back unless another writer already published a newer file,
        // which would have replaced this one anyway.
        linkIfAbsent(staged, target);
        return conflict(target);
      }
      return publish(tmp, target, data);
    } catch (error) {
      // Never drop the model on an unexpected error: put it back first, or
      // leave it aside for recoverStaleModel if even that fails.
      try {
        linkIfAbsent(staged, target);
      } catch {
        keepStaged = true;
      }
      throw error;
    } finally {
      if (!keepStaged && existsSync(staged)) unlinkSync(staged);
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
  const read = (): boolean => retryOnMissing(() => (text = readFileSync(target, "utf8")));
  return read() || (recoverStaleModel(target) && read()) ? text : null;
}

/**
 * True when `target` is a regular file. Like {@link readModelText}, retries
 * briefly while a concurrent swap has the file moved aside.
 */
export function isModelFileSync(target: string): boolean {
  let file = false;
  const check = (): boolean => retryOnMissing(() => (file = statSync(target).isFile()));
  return (check() || (recoverStaleModel(target) && check())) && file;
}

/**
 * Temp file holding new content before it is published. Hidden and named
 * `.<file>.tmp-<pid>-<uuid>` so the server's watcher can ignore it.
 */
export function tempPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
}

/**
 * Where a swap moves the current model while it compares hashes:
 * `.<file>.aside-<pid>-<uuid>`. Kept apart from {@link tempPath} because after
 * a crash the aside file is the last committed content and must be restored,
 * while a temp file holds a write that never published.
 */
export function asidePath(target: string): string {
  return join(dirname(target), `.${basename(target)}.aside-${process.pid}-${randomUUID()}`);
}

/** A hidden swap file name, parsed: the model it belongs to and its writer. */
export interface SwapFileName {
  /** Base name of the model file. */
  original: string;
  /** `temp`: unpublished new content. `aside`: the model, moved aside. */
  kind: "temp" | "aside";
  pid: number;
}

const SWAP_FILE_RE = /^\.(.+)\.(tmp|aside)-(\d+)-[0-9a-f-]+$/;

/** Parse a {@link tempPath} or {@link asidePath} base name; null for any other. */
export function parseSwapFileName(name: string): SwapFileName | null {
  const match = SWAP_FILE_RE.exec(name);
  if (!match) return null;
  return { original: match[1]!, kind: match[2] === "aside" ? "aside" : "temp", pid: Number(match[3]) };
}

/**
 * A swap file older than this was left by a crashed writer: a live swap keeps
 * its files for microseconds.
 */
export const STALE_SWAP_MS = 10_000;
/**
 * Minimum age before a swap file whose writer pid is not running counts as
 * stale. The pid check alone is not enough: the HTTP server can run in a
 * container while the MCP server runs on the host, so a live writer's pid may
 * not exist in this process's pid namespace.
 */
export const DEAD_WRITER_SWAP_MS = 1_000;

/**
 * True when the swap file at `path` was left by a writer that is gone: older
 * than {@link STALE_SWAP_MS}, or older than {@link DEAD_WRITER_SWAP_MS} with no
 * live process under its pid. Age is from ctime, which a rename updates (the
 * mtime of an aside file is the model's own, possibly days old). False when
 * the file no longer exists or the name is not a swap file.
 */
export function isStaleSwapFile(path: string, now = Date.now()): boolean {
  const parsed = parseSwapFileName(basename(path));
  if (!parsed) return false;
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return false;
  const age = now - stats.ctimeMs;
  return age > STALE_SWAP_MS || (age > DEAD_WRITER_SWAP_MS && !processAlive(parsed.pid));
}

/**
 * If `target` is missing because a writer crashed with it moved aside, put the
 * stale aside file back. Publishes with `link`, like a swap, so it never
 * replaces a file another writer created meanwhile. True when `target` exists
 * afterwards because of it or of a writer or reader that got there first.
 */
export function recoverStaleModel(target: string, now = Date.now()): boolean {
  return restoreAsides(dirname(target), basename(target), now).length > 0;
}

/**
 * Run {@link recoverStaleModel} for every model in `dir` (not recursive) that
 * a crashed writer left moved aside, so a directory listing taken afterwards
 * includes it. Returns the base names now present again.
 */
export function recoverStaleModels(dir: string, now = Date.now()): string[] {
  return restoreAsides(dir, null, now);
}

function restoreAsides(dir: string, only: string | null, now: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const present = new Set(entries);
  const restored: string[] = [];
  for (const entry of entries) {
    const parsed = parseSwapFileName(entry);
    if (parsed?.kind !== "aside" || (only !== null && parsed.original !== only)) continue;
    if (present.has(parsed.original)) continue;
    const aside = join(dir, entry);
    if (!isStaleSwapFile(aside, now)) continue;
    try {
      // false (EEXIST): someone else already put a model back; leave this one.
      if (linkIfAbsent(aside, join(dir, parsed.original))) unlinkIfPresent(aside);
    } catch (error) {
      // Another reader restored and removed this aside file first.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!existsSync(join(dir, parsed.original))) continue;
    }
    present.add(parsed.original);
    restored.push(parsed.original);
  }
  return restored;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** False only when no process has `pid` (in this pid namespace). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
