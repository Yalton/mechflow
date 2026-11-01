import {
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analyzeModel, parseModelYaml, serializeModelYaml, type Model } from "@mechflow/core";
import { isRegularFile, isValidFolderPath, listFolders, listModels, MODEL_EXTENSIONS, resolveModelPath } from "./paths.js";
import { ArchiveError, exportArchive, importArchive, MAX_ARCHIVE_BYTES } from "./archive.js";
import {
  compareAndSwapFileSync,
  hashYaml,
  hashesMatch,
  isModelFileSync,
  readModelText,
  tempPath,
} from "@mechflow/files";

/**
 * Request handlers for the mechflow server.
 *
 * The router lives in {@link createRequestHandler}; these helpers each own one
 * concern (list / read / write / report / static) and are exported so tests can
 * exercise them directly. All filesystem access is confined to this module.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Read the full request body as UTF-8 text. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Reduce an HTTP header to a single string, or undefined when absent. */
function normalizeHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** List every model under `modelsRoot`. */
export function handleListModels(modelsRoot: string, res: ServerResponse): void {
  sendJson(res, 200, { models: listModels(modelsRoot), folders: listFolders(modelsRoot) });
}

/**
 * Where a would-be folder path stands: "invalid" (bad name, outside the root,
 * or through a symlink leaving it), "file" (a file is in the way), "exists"
 * (already a folder) or "new" (some of it is missing and may be created).
 * Every part that exists must be a real folder inside the root.
 */
function folderStanding(
  modelsRoot: string,
  folderPath: string,
): { state: "invalid" | "file" | "exists" | "new"; abs: string } {
  const abs = isValidFolderPath(folderPath) ? resolveModelPath(modelsRoot, folderPath) : null;
  if (!abs) return { state: "invalid", abs: "" };
  const root = realpathSync(modelsRoot);
  const parts = relative(modelsRoot, abs).split(sep);
  for (let i = 1; i <= parts.length; i++) {
    const part = join(modelsRoot, ...parts.slice(0, i));
    let stat;
    try {
      stat = statSync(part);
    } catch {
      return { state: "new", abs }; // the rest of the path is new
    }
    if (!stat.isDirectory()) return { state: "file", abs };
    const inside = relative(root, realpathSync(part));
    if (inside.startsWith("..") || isAbsolute(inside)) return { state: "invalid", abs };
  }
  return { state: "exists", abs };
}

/** The path relative to the root, with forward slashes. */
function relativeToRoot(modelsRoot: string, abs: string): string {
  return relative(modelsRoot, abs).split(sep).join("/");
}

/** Create a folder (and any missing parents) under the root. 409 when it already exists. */
export function handleCreateFolder(modelsRoot: string, folderPath: string, res: ServerResponse): void {
  const { state, abs } = folderStanding(modelsRoot, folderPath);
  if (state === "invalid") return sendError(res, 400, "invalid folder path");
  if (state === "file") return sendError(res, 409, "a file is in the way");
  if (state === "exists") return sendError(res, 409, "folder already exists");
  mkdirSync(abs, { recursive: true });
  sendJson(res, 201, { ok: true, path: relativeToRoot(modelsRoot, abs) });
}

/**
 * An existing folder under the root, by its real location, or null: the root
 * itself, a file, a missing path and anything resolving outside the root are
 * all null.
 */
function existingFolder(modelsRoot: string, folderPath: string): string | null {
  const abs = isValidFolderPath(folderPath) ? resolveModelPath(modelsRoot, folderPath) : null;
  if (!abs) return null;
  try {
    if (!lstatSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  const inside = relative(realpathSync(modelsRoot), realpathSync(abs));
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? abs : null;
}

/** True when `dir` holds nothing but (possibly nested) empty folders. */
function holdsNoFiles(dir: string): boolean {
  return readdirSync(dir).every((entry) => {
    const abs = join(dir, entry);
    return lstatSync(abs).isDirectory() && holdsNoFiles(abs);
  });
}

/**
 * Rename or move a folder, models and all. The destination must not exist;
 * its missing parents are created. A folder cannot move inside itself.
 */
export function handleRenameFolder(modelsRoot: string, from: string, to: string, res: ServerResponse): void {
  const source = existingFolder(modelsRoot, from);
  if (!source) return sendError(res, 404, "folder not found");
  const target = isValidFolderPath(to) ? resolveModelPath(modelsRoot, to) : null;
  if (!target) return sendError(res, 400, "invalid folder path");
  if (target === source || target.startsWith(`${source}${sep}`)) {
    return sendError(res, 400, "a folder cannot move inside itself");
  }
  try {
    lstatSync(target);
    return sendError(res, 409, "destination already exists");
  } catch { /* destination is free */ }
  // Missing parents are created, through the same checks as a new folder.
  const parent = relativeToRoot(modelsRoot, dirname(target));
  if (parent !== "") {
    const standing = folderStanding(modelsRoot, parent);
    if (standing.state === "invalid" || standing.state === "file") return sendError(res, 400, "invalid folder path");
    if (standing.state === "new") mkdirSync(standing.abs, { recursive: true });
  }
  renameSync(source, target);
  sendJson(res, 200, { ok: true, path: relativeToRoot(modelsRoot, target) });
}

/** Delete a folder that holds no files (empty subfolders go with it). */
export function handleDeleteFolder(modelsRoot: string, folderPath: string, res: ServerResponse): void {
  const abs = existingFolder(modelsRoot, folderPath);
  if (!abs) return sendError(res, 404, "folder not found");
  if (!holdsNoFiles(abs)) return sendError(res, 409, "folder not empty");
  rmSync(abs, { recursive: true });
  sendJson(res, 200, { ok: true });
}


/**
 * Return the YAML text, parsed model, and any validation errors for a model.
 * A 404 is returned only when the file does not exist; a file that fails
 * validation still returns 200 with the errors populated (it is a read).
 */
export function handleGetModel(
  modelsRoot: string,
  modelPath: string,
  res: ServerResponse,
): void {
  const abs = resolveModelPath(modelsRoot, modelPath);
  const yaml = abs && isModelFileSync(abs) ? readModelText(abs) : null;
  if (yaml === null) return sendError(res, 404, "model not found");
  const result = parseModelYaml(yaml);
  if (result.ok) {
    sendJson(res, 200, { yaml, model: result.model, errors: null, hash: hashYaml(yaml) });
  } else {
    sendJson(res, 200, { yaml, model: null, errors: result.errors, hash: hashYaml(yaml) });
  }
}

/**
 * Validate a PUT body with `parseModelYaml` and, when valid, write it
 * atomically. Invalid input is rejected with 422 and the validation error list.
 *
 * When `ifMatch` is provided (the hash the client loaded), a file that has
 * changed on disk since that hash is rejected with 409 and the current YAML so
 * the client can offer reload/overwrite instead of clobbering a remote edit.
 * The check and the write are one compare-and-swap ({@link compareAndSwapFileSync}),
 * so a write by another process (the MCP server) cannot slip in between.
 */
export function handlePutModel(
  modelsRoot: string,
  modelPath: string,
  body: string,
  res: ServerResponse,
  ifMatch?: string,
  ifNoneMatch?: string,
): void {
  const abs = resolveModelPath(modelsRoot, modelPath);
  if (!abs) {
    return sendError(res, 400, "invalid model path");
  }
  const result = parseModelYaml(body);
  if (!result.ok) {
    return sendJson(res, 422, { errors: result.errors });
  }
  const swap = compareAndSwapFileSync(abs, body, ifNoneMatch === "*" ? null : ifMatch);
  if (!swap.ok) {
    if (ifNoneMatch === "*") return sendError(res, 409, "model already exists");
    return sendJson(res, 409, {
      conflict: true,
      loaded: ifMatch,
      hash: swap.hash,
      yaml: swap.current,
    });
  }
  sendJson(res, 200, { ok: true, model: result.model, hash: swap.hash });
}

function safeExistingModel(modelsRoot: string, path: string): string | null {
  const abs = resolveModelPath(modelsRoot, path);
  if (!abs || !MODEL_EXTENSIONS.has(extname(abs)) || !isModelFileSync(abs)) return null;
  if (!lstatSync(abs).isFile()) return null;
  const root = realpathSync(modelsRoot);
  const rel = relative(root, realpathSync(abs));
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) ? abs : null;
}

/** Move a model without replacing an existing file or following a path outside the root. */
export function handleRenameModel(
  modelsRoot: string,
  modelPath: string,
  destination: string,
  res: ServerResponse,
  ifMatch?: string,
): void {
  const source = safeExistingModel(modelsRoot, modelPath);
  if (!source) return sendError(res, 404, "model not found");
  const target = resolveModelPath(modelsRoot, destination);
  if (!target || !MODEL_EXTENSIONS.has(extname(target))) {
    return sendError(res, 400, "invalid destination path");
  }
  if (source === target) return sendError(res, 400, "destination matches source");
  if (!existsSync(dirname(target))) return sendError(res, 400, "destination directory not found");
  const root = realpathSync(modelsRoot);
  const rel = relative(root, realpathSync(dirname(target)));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return sendError(res, 400, "invalid destination path");
  }
  try {
    lstatSync(target);
    return sendError(res, 409, "destination already exists");
  } catch { /* destination is free */ }
  const yaml = readModelText(source);
  if (yaml === null) return sendError(res, 404, "model not found");
  if (ifMatch !== undefined && !hashesMatch(hashYaml(yaml), ifMatch)) {
    return sendJson(res, 409, { conflict: true, hash: hashYaml(yaml), yaml });
  }
  const staged = stageModel(source);
  const stagedYaml = readFileSync(staged, "utf8");
  if (stagedYaml !== yaml) {
    return sendJson(res, 409, { conflict: true, recoveryPath: restoreStaged(source, staged) });
  }
  try {
    linkSync(staged, target);
  } catch (error) {
    const recoveryPath = restoreStaged(source, staged);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return sendJson(res, 409, { error: "destination already exists", recoveryPath });
    }
    throw error;
  }
  unlinkSync(staged);
  sendJson(res, 200, { ok: true, path: destination, hash: hashYaml(yaml) });
}

/** Remove a model, checking the loaded hash when supplied. */
export function handleDeleteModel(
  modelsRoot: string,
  modelPath: string,
  res: ServerResponse,
  ifMatch?: string,
): void {
  const abs = safeExistingModel(modelsRoot, modelPath);
  if (!abs) return sendError(res, 404, "model not found");
  const yaml = readModelText(abs);
  if (yaml === null) return sendError(res, 404, "model not found");
  if (ifMatch !== undefined && !hashesMatch(hashYaml(yaml), ifMatch)) {
    return sendJson(res, 409, { conflict: true, hash: hashYaml(yaml), yaml });
  }
  const staged = stageModel(abs);
  if (readFileSync(staged, "utf8") !== yaml) {
    return sendJson(res, 409, { conflict: true, recoveryPath: restoreStaged(abs, staged) });
  }
  unlinkSync(staged);
  sendJson(res, 200, { ok: true });
}

/** Analyze a model and return the combined report. */
export function handleReport(
  modelsRoot: string,
  modelPath: string,
  res: ServerResponse,
): void {
  const abs = resolveModelPath(modelsRoot, modelPath);
  const yaml = abs && isModelFileSync(abs) ? readModelText(abs) : null;
  if (yaml === null) return sendError(res, 404, "model not found");
  const result = parseModelYaml(yaml);
  if (!result.ok) {
    return sendJson(res, 422, { errors: result.errors });
  }
  const report = analyzeModel(result.model);
  sendJson(res, 200, report);
}

/** Atomically remove the source pathname while retaining its inode for a safe decision. */
export function stageModel(source: string): string {
  const staged = tempPath(source);
  renameSync(source, staged);
  return staged;
}

/** Restore a failed move without replacing an intervening writer's model. */
export function restoreStaged(source: string, staged: string): string | null {
  try {
    linkSync(staged, source);
    unlinkSync(staged);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const recovered = join(dirname(source), `${basename(source, extname(source))}-recovered-${randomUUID()}${extname(source)}`);
    linkSync(staged, recovered);
    unlinkSync(staged);
    return basename(recovered);
  }
}

function serveFile(abs: string, res: ServerResponse): void {
  const type = CONTENT_TYPES[extname(abs)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(abs).pipe(res);
}

/**
 * Serve a file from `webDist`, falling back to the SPA entrypoint
 * (`index.html`) for any path that is not a real file.
 */
export function handleStatic(webDist: string, pathname: string, res: ServerResponse): void {
  const safe = resolveModelPath(webDist, pathname.replace(/^\//, ""));
  if (safe && isRegularFile(safe)) {
    serveFile(safe, res);
    return;
  }
  const entry = join(webDist, "index.html");
  if (isRegularFile(entry)) {
    serveFile(entry, res);
  } else {
    sendError(res, 404, "not found");
  }
}

/**
 * Turn a PUT body into YAML. A body sent as `application/json` is `{ model }`,
 * the same model object GET returns, and is serialized with the core
 * serializer; any other body is YAML text and passes through. Validation
 * happens afterwards in {@link handlePutModel}, so a well-formed JSON body
 * holding an invalid model still 422s.
 */
export function putBodyToYaml(
  body: string,
  contentType: string | undefined,
): { yaml: string } | { error: string } {
  if (!contentType?.toLowerCase().startsWith("application/json")) return { yaml: body };
  let payload: unknown;
  try { payload = JSON.parse(body); } catch {
    return { error: "invalid JSON body" };
  }
  const model = (payload as { model?: unknown } | null)?.model;
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    return { error: "model required" };
  }
  return { yaml: serializeModelYaml(model as Model) };
}

const API_MODELS_PREFIX = "/api/models/";

function readArchiveBody(req: IncomingMessage): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_ARCHIVE_BYTES) chunks.push(chunk);
    });
    req.on("end", () => resolve(bytes > MAX_ARCHIVE_BYTES ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The router. API routes live under `/api/models` and `/api/folders`; everything else is served
 * as static files from `webDist` with SPA fallback. Unknown methods get 405.
 */
export function createRequestHandler(
  modelsRoot: string,
  webDist: string,
): (req: IncomingMessage, res: ServerResponse) => void | Promise<void> {
  return async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/api/archive") {
        if (method === "GET") {
          const path = url.searchParams.get("path") ?? "";
          const kind = url.searchParams.get("kind");
          if (kind !== "game" && kind !== "folder") return sendError(res, 400, "archive kind required");
          try {
            const zip = exportArchive(modelsRoot, path, kind);
            res.writeHead(200, {
              "content-type": "application/zip",
              "content-disposition": `attachment; filename="${basename(path).replace(/[^a-zA-Z0-9._-]/g, "_")}.zip"`,
              "content-length": zip.byteLength,
            });
            res.end(zip);
          } catch (error) {
            if (error instanceof ArchiveError) return sendError(res, error.status, error.message);
            throw error;
          }
          return;
        }
        if (method === "POST") {
          const body = await readArchiveBody(req);
          if (body === null) return sendError(res, 413, "archive is too large");
          try {
            const path = importArchive(modelsRoot, body, url.searchParams.get("game") ?? undefined);
            sendJson(res, 201, { path });
          } catch (error) {
            if (error instanceof ArchiveError) return sendError(res, error.status, error.message);
            throw error;
          }
          return;
        }
        return sendError(res, 405, "method not allowed");
      }

      if (pathname === "/api/models") {
        if (method === "GET") {
          handleListModels(modelsRoot, res);
          return;
        }
        return sendError(res, 405, "method not allowed");
      }

      // POST /api/folders {path} creates; /rename {path, to} renames or
      // moves; /delete {path} deletes an empty folder.
      if (pathname === "/api/folders" || pathname === "/api/folders/rename" || pathname === "/api/folders/delete") {
        if (method !== "POST") return sendError(res, 405, "method not allowed");
        let payload: unknown;
        try { payload = JSON.parse(await readBody(req)); } catch {
          return sendError(res, 400, "invalid JSON body");
        }
        const { path: folder, to } = (payload ?? {}) as { path?: unknown; to?: unknown };
        if (typeof folder !== "string") return sendError(res, 400, "path required");
        if (pathname.endsWith("/rename")) {
          if (typeof to !== "string") return sendError(res, 400, "to required");
          handleRenameFolder(modelsRoot, folder, to, res);
        } else if (pathname.endsWith("/delete")) {
          handleDeleteFolder(modelsRoot, folder, res);
        } else {
          handleCreateFolder(modelsRoot, folder, res);
        }
        return;
      }

      if (pathname.startsWith(API_MODELS_PREFIX)) {
        const rest = pathname.slice(API_MODELS_PREFIX.length);
        if (method === "POST" && rest.endsWith("/rename")) {
          const base = rest.slice(0, -"/rename".length);
          let payload: unknown;
          try { payload = JSON.parse(await readBody(req)); } catch {
            return sendError(res, 400, "invalid JSON body");
          }
          const destination = (payload as { path?: unknown } | null)?.path;
          if (typeof destination !== "string") return sendError(res, 400, "path required");
          handleRenameModel(modelsRoot, base, destination, res, normalizeHeader(req.headers["if-match"]));
          return;
        }
        // `/api/models/<path>/report` — only when the base path is a real file.
        if (method === "GET" && rest.endsWith("/report")) {
          const base = rest.slice(0, -"/report".length);
          const baseAbs = resolveModelPath(modelsRoot, base);
          if (baseAbs && isModelFileSync(baseAbs)) {
            handleReport(modelsRoot, base, res);
            return;
          }
        }
        if (rest === "") {
          return sendError(res, 400, "model path required");
        }
        if (method === "GET") {
          handleGetModel(modelsRoot, rest, res);
          return;
        }
        if (method === "PUT") {
          const body = putBodyToYaml(await readBody(req), normalizeHeader(req.headers["content-type"]));
          if ("error" in body) return sendError(res, 400, body.error);
          const ifMatch = normalizeHeader(req.headers["if-match"]);
          handlePutModel(modelsRoot, rest, body.yaml, res, ifMatch, normalizeHeader(req.headers["if-none-match"]));
          return;
        }
        if (method === "DELETE") {
          handleDeleteModel(modelsRoot, rest, res, normalizeHeader(req.headers["if-match"]));
          return;
        }
        return sendError(res, 405, "method not allowed");
      }

      handleStatic(webDist, pathname, res);
    } catch {
      sendError(res, 500, "internal error");
    }
  };
}
