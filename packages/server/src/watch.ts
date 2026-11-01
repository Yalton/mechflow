import { basename, relative } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { hashYaml, isModelFileSync, readModelText } from "@mechflow/files";

/**
 * File watching for the models directory.
 *
 * Wraps chokidar to produce a small, coalesced stream of model events:
 * - `model-changed` after a 100 ms debounce (rapid writes collapse to one),
 * - `model-removed` when a file is deleted.
 *
 * Atomic-write temp files (`.<name>.tmp-<pid>-<uuid>`) are ignored so a PUT
 * never surfaces as a spurious change.
 */

export type ModelWatchEvent =
  | { type: "model-changed"; path: string; hash: string }
  | { type: "model-removed"; path: string };

export interface WatcherHandle {
  close(): void;
  /** Resolves once the initial scan completes, so callers can write after
   * watching starts without the new file being treated as pre-existing. */
  ready: Promise<void>;
}

/** Debounce window for coalescing rapid writes to the same model. */
export const DEBOUNCE_MS = 100;

/** Matches the temp files written by `@mechflow/files` (`tempPath`). */
const TEMP_FILE_RE = /\.tmp-[\d]+-[0-9a-f-]+$/;

/**
 * Watch `modelsRoot`, invoking `onChange` once per debounced change/removal
 * with the model's repo-relative path. Returns a handle whose `close` stops
 * watching and clears pending timers.
 */
export function createWatcher(
  modelsRoot: string,
  onChange: (event: ModelWatchEvent) => void,
): WatcherHandle {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (abs: string, rel: string): void => {
    const existing = timers.get(rel);
    if (existing) clearTimeout(existing);
    timers.set(
      rel,
      setTimeout(() => {
        timers.delete(rel);
        emit(abs, rel);
      }, DEBOUNCE_MS),
    );
  };

  const emit = (abs: string, rel: string): void => {
    const yaml = isModelFileSync(abs) ? readModelText(abs) : null;
    if (yaml !== null) {
      onChange({ type: "model-changed", path: rel, hash: hashYaml(yaml) });
    } else {
      onChange({ type: "model-removed", path: rel });
    }
  };

  const watcher: FSWatcher = chokidarWatch(modelsRoot, {
    ignoreInitial: true,
    ignored: (p: string) => TEMP_FILE_RE.test(basename(p)),
  });

  // Resolve once the initial scan finishes so callers can write a file after
  // watching starts without it being swallowed as a pre-existing entry.
  const ready = new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve());
  });

  watcher.on("add", (p) => schedule(p, relative(modelsRoot, p)));
  watcher.on("change", (p) => schedule(p, relative(modelsRoot, p)));
  // Debounced like the others: a compare-and-swap write (`@mechflow/files`)
  // moves the file aside for an instant, so an unlink is often followed at
  // once by the new file. `emit` decides changed vs removed when it fires.
  watcher.on("unlink", (p) => schedule(p, relative(modelsRoot, p)));

  return {
    ready,
    close: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      watcher.close();
    },
  };
}
