import { compareAndSwapFileSync, hashYaml, readModelText, writeFileAtomicSync } from "@mechflow/files";
import path from "node:path";

/**
 * Thrown when a tool argument refers to a path outside the models root.
 * Kept separate so the server can report it as a client-visible tool error
 * rather than an internal failure.
 */
export class PathEscapeError extends Error {
  override name = "PathEscapeError";
}

/**
 * Resolve a model-root-relative path against the models root and confirm it
 * stays inside the root. Rejects anything that would escape (e.g. `../secret`).
 *
 * The check is done on the resolved absolute paths so that symlink-free lexical
 * traversal is not enough: `resolve` collapses `..` before comparing prefixes.
 */
export function resolveWithin(root: string, relative: string): string {
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(absRoot, relative);
  if (absTarget === absRoot) {
    throw new PathEscapeError(`path "${relative}" is the models root itself, not a model file`);
  }
  if (!absTarget.startsWith(absRoot + path.sep)) {
    throw new PathEscapeError(`path "${relative}" escapes the models root`);
  }
  return absTarget;
}

/** Read a model file's raw YAML text. Throws an ENOENT error if it is missing. */
export function readModelFile(absPath: string): string {
  const text = readModelText(absPath);
  if (text === null) {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${absPath}'`), {
      code: "ENOENT",
    });
  }
  return text;
}

/**
 * Write a model file atomically: write a sibling temp file then rename over the
 * target. A crash mid-write leaves the original file untouched. Unconditional:
 * use {@link updateModelFile} for a read-modify-write.
 */
export function writeModelFileAtomic(absPath: string, content: string): void {
  writeFileAtomicSync(absPath, content);
}

/**
 * Thrown when a model kept changing under {@link updateModelFile} (another
 * writer, such as the browser, saved it on every attempt).
 */
export class ModelConflictError extends Error {
  override name = "ModelConflictError";
  constructor(readonly path: string) {
    super(`model "${path}" kept changing on disk while it was being updated; try again`);
  }
}

/** How many times {@link updateModelFile} re-reads after losing a race. */
export const UPDATE_ATTEMPTS = 5;

/**
 * Read-modify-write a model file without losing a concurrent write: `transform`
 * maps the current text to the new text, which is published only if the file
 * still holds what was read (compare-and-swap). On a lost race the file is
 * re-read and `transform` runs again on the newer text. Returns the written text.
 */
export function updateModelFile(
  absPath: string,
  rel: string,
  transform: (text: string) => string,
): string {
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
    const text = readModelFile(absPath);
    const next = transform(text);
    if (compareAndSwapFileSync(absPath, next, hashYaml(text)).ok) return next;
  }
  throw new ModelConflictError(rel);
}
