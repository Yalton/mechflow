import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { zipSync, unzipSync } from "fflate";
import { isStaleSwapFile, parseSwapFileName, readModelText, recoverStaleModel } from "@mechflow/files";
import { isValidFolderPath, resolveModelPath } from "./paths.js";

const MANIFEST = ".mechflow-archive.json";
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_CONTENT_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export class ArchiveError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type ArchiveKind = "game" | "folder";
interface Manifest { version: 1; kind: ArchiveKind; name: string }

function validName(name: string): boolean {
  return name === name.trim() && !name.includes("/") && !name.includes("\\") && !name.includes("\0") &&
    name !== "." && name !== ".." && isValidFolderPath(name);
}

function safeEntry(name: string): boolean {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  return path.startsWith("content/") && path !== "content/" && !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\0"));
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read the central directory so corrupted content cannot be published. */
function zipChecksums(data: Uint8Array): Map<string, { crc: number; size: number }> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === data.length) {
      end = at; break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new ArchiveError("invalid ZIP archive");
  }
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  if (count > MAX_ENTRIES || at + size !== end) throw new ArchiveError("invalid ZIP archive");
  const checksums = new Map<string, { crc: number; size: number }>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new ArchiveError("invalid ZIP archive");
    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > end || flags & 1) throw new ArchiveError("invalid ZIP archive");
    let name: string;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(at + 46, at + 46 + nameLength)); }
    catch { throw new ArchiveError("invalid ZIP archive"); }
    if (checksums.has(name)) throw new ArchiveError("archive has duplicate entries");
    const mode = view.getUint32(at + 38, true) >>> 16;
    if ((mode & 0xf000) === 0xa000) throw new ArchiveError("archive contains a symlink");
    checksums.set(name, { crc: view.getUint32(at + 16, true), size: view.getUint32(at + 24, true) });
    at = next;
  }
  if (at !== end) throw new ArchiveError("invalid ZIP archive");
  return checksums;
}

/** Export a complete real directory, retaining empty folders and file bytes. */
export function exportArchive(modelsRoot: string, path: string, kind: ArchiveKind): Uint8Array {
  for (let attempt = 0; ; attempt++) {
    try { return buildArchive(modelsRoot, path, kind); }
    catch (error) {
      if (!(error instanceof ArchiveError) || error.message !== "model save in progress" || attempt === 8) throw error;
      Atomics.wait(sleeper, 0, 0, [1, 2, 4, 8, 16, 32, 64, 128, 256][attempt]);
    }
  }
}

function buildArchive(modelsRoot: string, path: string, kind: ArchiveKind): Uint8Array {
  if (!isValidFolderPath(path) || (kind === "game" && path.includes("/"))) {
    throw new ArchiveError("invalid folder path");
  }
  const abs = resolveModelPath(modelsRoot, path);
  if (!abs || !lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ArchiveError("folder not found", 404);
  }
  const root = realpathSync(modelsRoot);
  const rel = relative(root, realpathSync(abs));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new ArchiveError("invalid folder path");
  const manifest: Manifest = { version: 1, kind, name: basename(path) };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const entries: Record<string, Uint8Array> = { [MANIFEST]: manifestBytes };
  let bytes = manifestBytes.length;
  let count = 1;
  const walk = (dir: string, prefix: string): void => {
    const children = readdirSync(dir, { withFileTypes: true });
    const listed = new Set(children.map((item) => item.name));
    for (const item of children) {
      const swap = parseSwapFileName(item.name);
      if (swap) {
        if (listed.has(swap.original)) continue;
        // The model is absent from this snapshot. While a swap is live it is
        // about to come back: retry instead of returning a ZIP without it.
        if (!isStaleSwapFile(join(dir, item.name))) throw new ArchiveError("model save in progress", 409);
        // A crashed writer left it moved aside: restore it, then retry so the
        // next pass lists it under its real name.
        if (swap.kind === "aside") {
          recoverStaleModel(join(dir, swap.original));
          throw new ArchiveError("model save in progress", 409);
        }
        // A stale temp file is a write that never published; skip it.
        continue;
      }
      if (++count > MAX_ENTRIES) throw new ArchiveError("folder has too many entries", 413);
      const entry = `${prefix}${item.name}`;
      if (!safeEntry(entry)) throw new ArchiveError("folder contains an unsupported path");
      const source = join(dir, item.name);
      if (item.isDirectory()) {
        entries[`${entry}/`] = new Uint8Array();
        walk(source, `${entry}/`);
      } else if (item.isFile()) {
        if (/\.ya?ml$/i.test(item.name) && readModelText(source) === null) {
          throw new ArchiveError("model save in progress", 409);
        }
        try { entries[entry] = readFileSync(source); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArchiveError("model save in progress", 409);
          throw error;
        }
        bytes += entries[entry].byteLength;
        if (bytes > MAX_CONTENT_BYTES) throw new ArchiveError("folder is too large to export", 413);
      } else {
        throw new ArchiveError("folder contains a symlink or unsupported file");
      }
    }
  };
  walk(abs, "content/");
  const zip = zipSync(entries);
  if (zip.byteLength > MAX_ARCHIVE_BYTES) throw new ArchiveError("archive is too large", 413);
  return zip;
}

/** Import into a new game, or place a folder under an existing game. */
export function importArchive(modelsRoot: string, data: Uint8Array, game?: string): string {
  if (data.byteLength > MAX_ARCHIVE_BYTES) throw new ArchiveError("archive is too large", 413);
  const checksums = zipChecksums(data);
  const seen = new Set<string>();
  let bytes = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, { filter: (file) => {
      if (++count > MAX_ENTRIES || seen.has(file.name)) throw new ArchiveError("archive has too many or duplicate entries");
      seen.add(file.name);
      bytes += file.originalSize;
      if (bytes > MAX_CONTENT_BYTES) throw new ArchiveError("archive is too large", 413);
      if (file.name !== MANIFEST && !safeEntry(file.name)) throw new ArchiveError("archive contains an unsafe path");
      return true;
    } });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError("invalid ZIP archive");
  }
  if (Object.keys(entries).length !== checksums.size) throw new ArchiveError("invalid ZIP archive");
  for (const [name, value] of Object.entries(entries)) {
    const expected = checksums.get(name);
    if (!expected || value.length !== expected.size || crc32(value) !== expected.crc) {
      throw new ArchiveError("archive content is damaged");
    }
  }
  let manifest: Manifest;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entries[MANIFEST])) as Manifest; }
  catch { throw new ArchiveError("archive manifest missing or invalid"); }
  if (!manifest || manifest.version !== 1 || !["game", "folder"].includes(manifest.kind) ||
    typeof manifest.name !== "string" || !validName(manifest.name)) {
    throw new ArchiveError("archive manifest missing or invalid");
  }
  if (manifest.kind === "game" && game !== undefined) throw new ArchiveError("game archives cannot target an existing game");
  if (manifest.kind === "folder" && (!game || !validName(game))) throw new ArchiveError("choose a destination game");
  const destination = manifest.kind === "game" ? manifest.name : `${game}/${manifest.name}`;
  const target = resolveModelPath(modelsRoot, destination);
  if (!target) throw new ArchiveError("invalid destination");
  const parent = dirname(target);
  if (manifest.kind === "folder" && !lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ArchiveError("destination game not found", 404);
  }
  if (realpathSync(parent) !== (manifest.kind === "game" ? realpathSync(modelsRoot) : realpathSync(join(modelsRoot, game!)))) {
    throw new ArchiveError("invalid destination");
  }
  if (lstatSync(target, { throwIfNoEntry: false })) throw new ArchiveError("destination already exists", 409);
  const staged = mkdtempSync(join(modelsRoot, ".archive-import-"));
  try {
    for (const [name, value] of Object.entries(entries)) {
      if (name === MANIFEST) continue;
      const subpath = name.slice("content/".length).replace(/\/$/, "");
      const abs = join(staged, ...subpath.split("/"));
      if (name.endsWith("/")) mkdirSync(abs, { recursive: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, value, { flag: "wx" });
      }
    }
    try { mkdirSync(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ArchiveError("destination already exists", 409);
      throw error;
    }
    try { renameSync(staged, target); }
    catch (error) {
      try { rmdirSync(target); } catch { /* another writer used the destination; preserve its files */ }
      throw error;
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  return destination;
}
