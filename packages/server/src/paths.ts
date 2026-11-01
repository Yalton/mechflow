import { readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/** File extensions treated as mechflow models. */
export const MODEL_EXTENSIONS = new Set([".yaml", ".yml"]);

/**
 * Resolve a client-supplied model path to an absolute location under
 * `modelsRoot`, rejecting any path that escapes the root (e.g. `../` or an
 * absolute path). Returns `null` when the path is empty or escapes the root,
 * so callers can treat a `null` result as "not allowed".
 */
export function resolveModelPath(modelsRoot: string, modelPath: string): string | null {
  const trimmed = (modelPath ?? "").trim();
  if (!trimmed) return null;
  // Normalize separators and collapse any traversal before touching the FS.
  const normalized = normalize(trimmed.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  const abs = resolve(modelsRoot, normalized);
  // Second line of defense: the resolved path must stay inside the root.
  const rel = relative(modelsRoot, abs);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return abs;
}

/** True when `abs` is an existing regular file. */
export function isRegularFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** True when `abs` is an existing directory. */
export function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List every model under `modelsRoot` as a sorted, repo-relative path using
 * forward slashes. Returns an empty array when the root does not exist.
 */
export function listModels(modelsRoot: string): string[] {
  const results: string[] = [];
  if (!isDirectory(modelsRoot)) return results;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs);
      } else if (stat.isFile() && MODEL_EXTENSIONS.has(extname(abs))) {
        results.push(relative(modelsRoot, abs).split(sep).join("/"));
      }
    }
  };
  walk(modelsRoot);
  return results.sort();
}

/**
 * List every folder under `modelsRoot` (empty ones too) as a sorted, relative
 * path using forward slashes. Hidden folders (a name starting with ".") and
 * everything under them are left out.
 */
export function listFolders(modelsRoot: string): string[] {
  const results: string[] = [];
  if (!isDirectory(modelsRoot)) return results;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const abs = join(dir, entry);
      if (!isDirectory(abs)) continue;
      results.push(relative(modelsRoot, abs).split(sep).join("/"));
      walk(abs);
    }
  };
  walk(modelsRoot);
  return results.sort();
}

/**
 * True when `folderPath` is a usable new folder path: relative, inside the
 * root, and made of visible names (no segment empty or starting with ".").
 */
export function isValidFolderPath(folderPath: string): boolean {
  const segments = (folderPath ?? "").trim().replace(/\\/g, "/").split("/");
  return segments.length > 0 && segments.every((s) => s.trim() !== "" && !s.startsWith("."));
}
