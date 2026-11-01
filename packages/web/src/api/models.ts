/**
 * Client helpers for the mechflow model API served by `packages/server`.
 *
 * The editor loads a model via {@link fetchModel} (which returns the server's
 * content hash) and saves via {@link saveModel}. Passing the loaded hash back
 * as If-Match lets the server reject a write with 409 when the file changed on
 * disk meanwhile, so the editor never silently clobbers a concurrent edit.
 */

import type { Report, SchemaError } from "@mechflow/core";

/** Download a complete game or folder tree as a ZIP file. */
export async function exportArchive(path: string, kind: "game" | "folder", fetchImpl: typeof fetch = fetch): Promise<Blob> {
  const query = new URLSearchParams({ path, kind });
  const res = await fetchImpl(`/api/archive?${query}`);
  if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `export failed: ${res.status}`);
  return res.blob();
}

/** Import a game as a new game, or a folder into the chosen game. */
export async function importArchive(file: File, game?: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const query = game === undefined ? "" : `?${new URLSearchParams({ game })}`;
  const res = await fetchImpl(`/api/archive${query}`, { method: "POST", headers: { "content-type": "application/zip" }, body: file });
  const result = await res.json() as { path?: string; error?: string };
  if (!res.ok) throw new Error(result.error ?? `import failed: ${res.status}`);
  return result.path!;
}

/** Response of `GET /api/models`. */
export interface ModelList {
  /** Repo-relative model paths, sorted. */
  models: string[];
  /** Every folder under the models root, empty ones too, sorted. */
  folders?: string[];
}

export interface ModelResponse {
  /** Raw YAML text. */
  yaml: string;
  /** Parsed model, or null when the YAML failed validation. */
  model: unknown;
  /** Validation errors, or null when the model parsed. */
  errors: (string | SchemaError)[] | null;
  /** Content hash of the YAML (sha1 of the UTF-8 text). */
  hash: string;
}

export interface PutResult {
  ok: true;
  model: unknown;
  /** Content hash of what was just written. */
  hash: string;
}

export interface ConflictResponse {
  conflict: true;
  /** The If-Match the client sent. */
  loaded: string;
  /** The server's current hash. */
  hash: string;
  /** The server's current YAML. */
  yaml: string;
}

/**
 * Thrown by {@link saveModel} when the server rejects a write with 409 because
 * the file changed on disk since the browser loaded it. Carries the server's
 * current YAML so the editor can offer reload or overwrite.
 */
export class ConflictError extends Error {
  constructor(
    public readonly path: string,
    public readonly loadedHash: string,
    public readonly remoteHash: string,
    public readonly remoteYaml: string,
  ) {
    super(`model changed on disk since loaded (${loadedHash} != ${remoteHash})`);
    this.name = "ConflictError";
  }
}

function modelUrl(path: string): string {
  return `/api/models/${encodeURIComponent(path)}`;
}

/** List all models (`GET /api/models`). */
export async function fetchModels(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelList> {
  const res = await fetchImpl("/api/models");
  if (!res.ok) {
    throw new Error(`failed to list models: ${res.status}`);
  }
  return (await res.json()) as ModelList;
}

/** Create a folder (and missing parents) under the models root. */
export async function createFolder(path: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl("/api/folders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (res.status === 409) throw new Error(`${path} already exists`);
  if (!res.ok) throw new Error(`failed to create folder ${path}: ${res.status}`);
}

/** Rename or move a folder, models and all. */
export async function renameFolder(path: string, to: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl("/api/folders/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, to }),
  });
  if (res.status === 409) throw new Error(`${to} already exists`);
  if (!res.ok) throw new Error(`failed to rename folder ${path}: ${res.status}`);
}

/** Delete a folder; the server refuses one that still holds files. */
export async function deleteFolder(path: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl("/api/folders/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (res.status === 409) throw new Error(`${path} is not empty: move or delete its models first`);
  if (!res.ok) throw new Error(`failed to delete folder ${path}: ${res.status}`);
}

/** Fetch a model by repo-relative path. */
export async function fetchModel(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelResponse> {
  const res = await fetchImpl(modelUrl(path));
  if (!res.ok) {
    throw new Error(`failed to fetch ${path}: ${res.status}`);
  }
  return (await res.json()) as ModelResponse;
}

/** URL for a model's analysis report. */
function reportUrl(path: string): string {
  return `${modelUrl(path)}/report`;
}

/** Fetch the analysis report for a model by repo-relative path. */
export async function fetchReport(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Report> {
  const res = await fetchImpl(reportUrl(path));
  if (!res.ok) {
    throw new Error(`failed to fetch report for ${path}: ${res.status}`);
  }
  return (await res.json()) as Report;
}

/**
 * Save a model's YAML. When `ifMatch` is provided, a concurrent remote edit
 * produces a 409 and a {@link ConflictError} carrying the server's current
 * YAML; the editor then decides whether to auto-apply (no unsaved edits) or
 * surface a reload/overwrite banner (unsaved edits present).
 */
export async function saveModel(
  path: string,
  yaml: string,
  ifMatch?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PutResult> {
  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const res = await fetchImpl(modelUrl(path), {
    method: "PUT",
    headers,
    body: yaml,
  });
  if (res.status === 409) {
    const conflict = (await res.json()) as ConflictResponse;
    throw new ConflictError(path, conflict.loaded, conflict.hash, conflict.yaml);
  }
  if (!res.ok) {
    throw new Error(`failed to save ${path}: ${res.status}`);
  }
  return (await res.json()) as PutResult;
}

/** Create a model; a concurrent file at the same path must remain untouched. */
export async function createModel(
  path: string,
  yaml: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PutResult> {
  const res = await fetchImpl(modelUrl(path), {
    method: "PUT",
    headers: { "content-type": "text/plain", "if-none-match": "*" },
    body: yaml,
  });
  if (!res.ok) throw new Error(`failed to create ${path}: ${res.status}`);
  return (await res.json()) as PutResult;
}

/** Rename a model without replacing an existing destination. */
export async function renameModel(
  path: string,
  destination: string,
  ifMatch?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${modelUrl(path)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ifMatch ? { "if-match": ifMatch } : {}) },
    body: JSON.stringify({ path: destination }),
  });
  if (!res.ok) throw new Error(`failed to rename ${path}: ${res.status}`);
}

/** Delete a model, checking the loaded hash when provided. */
export async function deleteModel(
  path: string,
  ifMatch?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(modelUrl(path), {
    method: "DELETE",
    headers: ifMatch ? { "if-match": ifMatch } : undefined,
  });
  if (!res.ok) throw new Error(`failed to delete ${path}: ${res.status}`);
}
