/**
 * Models are organised in folders under the server's models root, and the
 * top-level folder is a game: `GameA/Economy/GraphA.yaml` and
 * `GameB/Economy/GraphA.yaml` are separate models in separate games. The
 * sidebar shows one game at a time, as a tree of its folders.
 *
 * Models at the root itself belong to the "top level" pseudo-game, `""`.
 */

/** One folder in a game's tree. `path` is relative to the models root. */
export interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  /** Model paths directly in this folder, sorted. */
  models: string[];
}

/** The folder a path sits in, `""` for the root. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The game (top-level folder) a model or folder path belongs to. */
export function gameOf(path: string): string {
  const slash = path.indexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Every folder: those the server listed (empty ones too) and every model's ancestors. */
export function allFolders(models: readonly string[], folders: readonly string[] = []): string[] {
  const seen = new Set(folders);
  for (const model of models) {
    for (let dir = parentOf(model); dir !== ""; dir = parentOf(dir)) seen.add(dir);
  }
  return [...seen].sort();
}

/** The games, sorted; the top level (`""`) first, only when models sit at the root. */
export function gamesOf(models: readonly string[], folders: readonly string[] = []): string[] {
  const games = allFolders(models, folders).filter((f) => !f.includes("/"));
  return models.some((m) => !m.includes("/")) ? ["", ...games] : games;
}

/** One game's folder tree. For the top level, only the models at the root. */
export function treeOf(game: string, models: readonly string[], folders: readonly string[] = []): FolderNode {
  const node = (path: string): FolderNode => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    folders: game === "" && path === ""
      ? []
      : allFolders(models, folders).filter((f) => parentOf(f) === path).map(node),
    models: models.filter((m) => parentOf(m) === path).sort(),
  });
  return node(game);
}

/** The game named in a location hash such as `#/GameA`, or null. */
export function gameFromHash(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  try {
    return decodeURIComponent(hash.slice(2));
  } catch {
    return null;
  }
}

/** The location hash for a game. */
export function hashForGame(game: string): string {
  return `#/${encodeURIComponent(game)}`;
}

/**
 * A folder or game name typed by the user, or null when it cannot be one:
 * empty, `.`-led (hidden on the server), or containing a slash.
 */
export function cleanFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith(".") || /[/\\]/.test(trimmed)) return null;
  return trimmed;
}
