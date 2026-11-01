import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useAppStore, type LoadedModel } from "./state/store.js";
import { useEditorStore } from "./state/editor.js";
import {
  ConflictError, createFolder, createModel, deleteFolder, deleteModel, exportArchive, fetchModel, importArchive, renameFolder, renameModel, saveModel,
} from "./api/models.js";
import {
  allFolders, cleanFolderName, gameFromHash, gamesOf, hashForGame, parentOf, treeOf, type FolderNode,
} from "./folders.js";
import { GraphView } from "./graph/index.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { FindingsPanel } from "./panels/FindingsPanel.js";
import { Inspector } from "./panels/Inspector.js";
import { MatrixView } from "./panels/MatrixView.js";
import { ChartPanel } from "./panels/ChartPanel.js";
import { SearchPanel } from "./panels/SearchPanel.js";
import { useSearchFindings } from "./state/search.js";
import { useSimulationFindings } from "./state/run.js";
import { parseModelYaml, serializeModelYaml, type Model, type ReportSummary } from "@mechflow/core";
import type { ModelWatchEvent } from "./types.js";
import { useTheme } from "./theme.js";

/**
 * App shell: a sidebar showing one game's folders and models (see folders.ts),
 * picked from the games at its top and kept in the URL hash, and a workspace with
 * a top bar, the graph canvas, a tabbed analysis dock and the inspector. Opening a model fetches its parsed form + analysis
 * report; the `/ws` socket reloads the open model when the file changes on disk.
 * The graph itself is rendered by {@link GraphView} (kj1.2).
 */
export function App(): JSX.Element {
  const [newName, setNewName] = useState("");
  const [managementError, setManagementError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [yamlDraftDirty, setYamlDraftDirty] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const [hashGame, setHashGame] = useState(() => gameFromHash(window.location.hash));
  // The folder new models and folders go into; null means the game's own folder.
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [adding, setAdding] = useState<"game" | "folder" | null>(null);
  const [addName, setAddName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [importGame, setImportGame] = useState("");
  // Drag and drop in the sidebar: what is being dragged, and the folder under it.
  const [dragging, setDragging] = useState<{ kind: "model" | "folder"; path: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const models = useAppStore((s) => s.models);
  const folders = useAppStore((s) => s.folders);
  const games = useMemo(() => gamesOf(models, folders), [models, folders]);
  const game = hashGame !== null && games.includes(hashGame) ? hashGame : games[0] ?? "";
  const inGame = (path: string): boolean => (game === "" ? path === "" : path === game || path.startsWith(`${game}/`));
  const folder = chosenFolder !== null && inGame(chosenFolder) ? chosenFolder : game;
  const tree = useMemo(() => treeOf(game, models, folders), [game, models, folders]);
  const loadingModels = useAppStore((s) => s.loadingModels);
  const loadError = useAppStore((s) => s.loadError);
  const selectedPath = useAppStore((s) => s.selectedPath);
  const loadingSelected = useAppStore((s) => s.loadingSelected);
  const loaded = useAppStore((s) => s.loaded);
  const report = useAppStore((s) => s.report);
  useEffect(() => {
    if (selectedPath === null) setYamlDraftDirty(false);
  }, [selectedPath]);

  const create = async (): Promise<void> => {
    if (yamlDraftDirty) { setManagementError("Save or discard YAML changes before creating another model."); return; }
    const name = newName.trim();
    const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!stem) { setManagementError("Enter a model name with letters or numbers."); return; }
    const path = folder ? `${folder}/${stem}.yaml` : `${stem}.yaml`;
    const model: Model = { version: 1, name, properties: [], subsystems: [], nodes: [], edges: [], noInteraction: [], invariants: [] };
    setBusy(true); setManagementError(null);
    try {
      await createModel(path, serializeModelYaml(model));
      await useAppStore.getState().loadModels();
      await useAppStore.getState().selectModel(path);
      setNewName("");
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const switchGame = (next: string): void => {
    window.location.hash = hashForGame(next);
    setHashGame(next);
    setChosenFolder(null);
  };

  const downloadArchive = async (path: string, kind: "game" | "folder"): Promise<void> => {
    setBusy(true); setManagementError(null);
    try {
      const blob = await exportArchive(path, kind);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${path.split("/").pop()}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const uploadArchive = async (): Promise<void> => {
    if (!archiveFile) return;
    setBusy(true); setManagementError(null);
    try {
      const path = await importArchive(archiveFile, importGame || undefined);
      await useAppStore.getState().loadModels();
      switchGame(importGame || path);
      setChosenFolder(path);
      setShowImport(false);
      setArchiveFile(null);
      setImportGame("");
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const addFolder = async (): Promise<void> => {
    const name = cleanFolderName(addName);
    if (name === null) { setManagementError("Enter a folder name without slashes or a leading dot."); return; }
    const path = adding === "game" || !folder ? name : `${folder}/${name}`;
    setBusy(true); setManagementError(null);
    try {
      await createFolder(path);
      await useAppStore.getState().loadModels();
      if (adding === "game") switchGame(path);
      setChosenFolder(path);
      setAdding(null);
      setAddName("");
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const rename = async (path: string): Promise<void> => {
    const name = renameName.trim();
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      setManagementError("Enter a valid file name."); return;
    }
    if (path === selectedPath && (useEditorStore.getState().dirty || yamlDraftDirty)) {
      setManagementError("Save your model edits before renaming it."); return;
    }
    const destination = `${path.slice(0, path.lastIndexOf("/") + 1)}${name.replace(/\.ya?ml$/i, "")}.yaml`;
    setBusy(true); setManagementError(null);
    try {
      const current = await fetchModel(path);
      await renameModel(path, destination, current.hash);
      await useAppStore.getState().loadModels();
      if (path === selectedPath) await useAppStore.getState().selectModel(destination);
      setRenamingPath(null);
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  // The open model's unsaved edits would be lost if its file moved under it.
  const blocksMove = (path: string): boolean =>
    selectedPath !== null && (selectedPath === path || selectedPath.startsWith(`${path}/`)) &&
    (useEditorStore.getState().dirty || yamlDraftDirty);

  // Move a model into `target` (a folder path, "" for the top level).
  const move = async (path: string, target: string): Promise<void> => {
    if (blocksMove(path)) { setManagementError("Save your model edits before moving it."); return; }
    const destination = `${target ? `${target}/` : ""}${path.split("/").pop()!}`;
    if (destination === path) { setMovingPath(null); return; }
    setBusy(true); setManagementError(null);
    try {
      const current = await fetchModel(path);
      await renameModel(path, destination, current.hash);
      await useAppStore.getState().loadModels();
      if (path === selectedPath) await useAppStore.getState().selectModel(destination);
      setChosenFolder(target);
      setMovingPath(null);
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const renameFolderTo = async (path: string): Promise<void> => {
    const name = cleanFolderName(folderName);
    if (name === null) { setManagementError("Enter a folder name without slashes or a leading dot."); return; }
    if (blocksMove(path)) { setManagementError("Save your model edits before renaming its folder."); return; }
    const parent = parentOf(path);
    await relocateFolder(path, parent ? `${parent}/${name}` : name);
  };

  // Rename or move a folder; the open model and the current game follow it.
  const relocateFolder = async (path: string, destination: string): Promise<void> => {
    if (blocksMove(path)) { setManagementError("Save your model edits before moving its folder."); return; }
    if (destination === path) { setRenamingFolder(null); return; }
    setBusy(true); setManagementError(null);
    try {
      await renameFolder(path, destination);
      await useAppStore.getState().loadModels();
      const moved = (p: string): string => `${destination}${p.slice(path.length)}`;
      if (selectedPath !== null && selectedPath.startsWith(`${path}/`)) {
        await useAppStore.getState().selectModel(moved(selectedPath));
      }
      if (path === game) switchGame(destination);
      setChosenFolder(destination);
      setRenamingFolder(null);
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  // Whether what is being dragged may land in `target` ("" is the top level):
  // somewhere new, and never a folder into itself.
  const canDrop = (target: string): boolean => {
    if (!dragging || parentOf(dragging.path) === target) return false;
    return dragging.kind === "model" || (target !== dragging.path && !target.startsWith(`${dragging.path}/`));
  };

  const endDrag = (): void => { setDragging(null); setDropTarget(null); };

  const dragProps = (kind: "model" | "folder", path: string) => ({
    draggable: !busy,
    onDragStart: (event: DragEvent) => {
      event.stopPropagation();
      event.dataTransfer?.setData("text/plain", path);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      setDragging({ kind, path });
    },
    onDragEnd: endDrag,
  });

  const dropProps = (target: string) => ({
    "data-drop": dropTarget === target || undefined,
    onDragOver: (event: DragEvent) => {
      if (!canDrop(target)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((current) => (current === target ? null : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const dragged = dragging;
      endDrag();
      if (!dragged || !canDrop(target)) return;
      const name = dragged.path.slice(dragged.path.lastIndexOf("/") + 1);
      if (dragged.kind === "model") void move(dragged.path, target);
      else void relocateFolder(dragged.path, target ? `${target}/${name}` : name);
    },
  });

  const removeFolder = async (path: string): Promise<void> => {
    if (!window.confirm(`Delete the folder ${path}? Only empty folders can be deleted.`)) return;
    setBusy(true); setManagementError(null);
    try {
      await deleteFolder(path);
      await useAppStore.getState().loadModels();
      if (path === game) {
        window.location.hash = "";
        setHashGame(null);
      }
      setChosenFolder(parentOf(path));
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const remove = async (path: string): Promise<void> => {
    if (path === selectedPath && (useEditorStore.getState().dirty || yamlDraftDirty)) {
      setManagementError("Save your model edits before deleting it."); return;
    }
    if (!window.confirm(`Delete ${path}? This removes the model file.`)) return;
    setBusy(true); setManagementError(null);
    try {
      const current = await fetchModel(path);
      await deleteModel(path, current.hash);
      if (path === selectedPath) useAppStore.getState().clearSelection();
      await useAppStore.getState().loadModels();
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    void useAppStore.getState().loadModels();
    const onHash = (): void => setHashGame(gameFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const ws = new WebSocket("/ws");
    const onMessage = (event: MessageEvent): void => {
      const message = JSON.parse(event.data) as ModelWatchEvent;
      useAppStore.getState()[
        message.type === "model-changed" ? "handleModelChanged" : "handleModelRemoved"
      ](message.path);
    };
    ws.addEventListener("message", onMessage);
    return () => {
      ws.removeEventListener("message", onMessage);
      ws.close();
    };
  }, []);

  const openModel = (path: string): void => {
    if (yamlDraftDirty && path !== selectedPath) {
      setManagementError("Save or discard YAML changes before switching models.");
      return;
    }
    setChosenFolder(parentOf(path));
    void useAppStore.getState().selectModel(path);
  };

  const modelRow = (path: string): JSX.Element => (
    <li key={path} className="model-row" data-active={selectedPath === path}
      data-dragging={dragging?.path === path || undefined} {...dragProps("model", path)}>
      {movingPath === path ? (
        <form className="rename-form move-form" onSubmit={(event) => { event.preventDefault(); void move(path, moveTarget); }}>
          <select aria-label={`Move ${path} to`} data-testid="move-target" value={moveTarget} autoFocus
            onChange={(event) => setMoveTarget(event.target.value)}>
            {games.map((g) => g === "" ? <option key="" value="">Top level (no game)</option> : (
              <optgroup key={g} label={g}>
                <option value={g}>{g} (top)</option>
                {allFolders(models, folders).filter((f) => f.startsWith(`${g}/`)).map((f) => (
                  <option key={f} value={f}>{f.slice(g.length + 1)}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button type="submit" className="btn-primary" data-testid="move-confirm" disabled={busy}>Move</button>
          <button type="button" className="btn-ghost" onClick={() => setMovingPath(null)}>Cancel</button>
        </form>
      ) : renamingPath === path ? (
        <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void rename(path); }}>
          <input aria-label={`New name for ${path}`} value={renameName} autoFocus
            onChange={(event) => setRenameName(event.target.value)} />
          <button type="submit" className="btn-primary" disabled={busy}>Save name</button>
          <button type="button" className="btn-ghost" onClick={() => setRenamingPath(null)}>Cancel</button>
        </form>
      ) : <>
        <button type="button" data-testid="model-item" className="model-open"
          aria-label={path} title={path} onClick={() => openModel(path)}>
          {fileStem(path)}
        </button>
        <span className="model-actions">
          <button type="button" className="btn-ghost btn-icon" aria-label={`Rename ${path}`}
            title="Rename" disabled={busy}
            onClick={() => { setRenamingPath(path); setRenameName(fileStem(path)); }}>✎</button>
          <button type="button" className="btn-ghost btn-icon" aria-label={`Move ${path}`}
            title="Move to another folder" disabled={busy}
            onClick={() => { setMovingPath(path); setMoveTarget(parentOf(path)); }}>⇄</button>
          <button type="button" className="btn-ghost btn-icon btn-danger" aria-label={`Delete ${path}`}
            title="Delete" disabled={busy} onClick={() => void remove(path)}>🗑</button>
        </span>
      </>}
    </li>
  );

  // Rename and delete, for a folder row or the current game. Clicks stay off
  // the <summary>, which would otherwise fold the folder.
  const folderActions = (path: string): JSX.Element => (
    <span className="model-actions folder-actions" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      {path !== game && <button type="button" className="btn-ghost btn-icon" aria-label={`Export folder ${path}`}
        title="Export folder ZIP" disabled={busy}
        onClick={() => void downloadArchive(path, "folder")}>⇩</button>}
      <button type="button" className="btn-ghost btn-icon" aria-label={`Rename folder ${path}`}
        title="Rename" disabled={busy}
        onClick={() => { setRenamingFolder(path); setFolderName(path.slice(path.lastIndexOf("/") + 1)); }}>✎</button>
      <button type="button" className="btn-ghost btn-icon btn-danger" aria-label={`Delete folder ${path}`}
        title="Delete (only when empty)" disabled={busy} onClick={() => void removeFolder(path)}>🗑</button>
    </span>
  );

  const folderRenameForm = (path: string): JSX.Element => (
    <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void renameFolderTo(path); }}>
      <input aria-label={`New name for folder ${path}`} value={folderName} autoFocus
        onChange={(event) => setFolderName(event.target.value)} />
      <button type="submit" className="btn-primary" disabled={busy}>Save name</button>
      <button type="button" className="btn-ghost" onClick={() => setRenamingFolder(null)}>Cancel</button>
    </form>
  );

  // A folder's subfolders (collapsible, open by default) and then its models.
  const folderContents = (node: FolderNode): JSX.Element => (
    <>
      {node.folders.map((child) => (
        // Anywhere over a folder, its models included, drops into that folder.
        <details key={child.path} open className="folder" data-testid="folder" data-path={child.path}
          {...dropProps(child.path)}>
          <summary className="folder-row" data-active={folder === child.path}
            {...dragProps("folder", child.path)}
            title={`New models go into ${child.path} when selected`}
            onClick={() => setChosenFolder(child.path)}>
            <span className="folder-name">{child.name}</span>
            {renamingFolder !== child.path && folderActions(child.path)}
          </summary>
          {/* Outside the <summary>, where a typed space would fold the folder. */}
          {renamingFolder === child.path && folderRenameForm(child.path)}
          <div className="folder-body">{folderContents(child)}</div>
        </details>
      ))}
      {node.models.length > 0 && <ul className="model-list">{node.models.map(modelRow)}</ul>}
    </>
  );
  return (
    <div data-testid="app" className="shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1 className="brand">mechflow</h1>
          <button type="button" className="btn-ghost btn-icon theme-toggle" data-testid="theme-toggle"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}>{theme === "dark" ? "☀" : "☾"}</button>
        </div>
        <div className="sidebar-body">
          <div className="game-bar">
            <select data-testid="game-picker" aria-label="Game" value={game} disabled={busy || games.length === 0}
              onChange={(event) => switchGame(event.target.value)}>
              {games.length === 0 && <option value="">No games yet</option>}
              {games.map((g) => <option key={g} value={g}>{g === "" ? "Top level" : g}</option>)}
            </select>
            {game !== "" && renamingFolder !== game && folderActions(game)}
            <button type="button" className="btn-ghost" data-testid="new-game" disabled={busy}
              title="Add a game: a new top-level folder" onClick={() => { setAdding("game"); setAddName(""); }}>+ Game</button>
            <button type="button" className="btn-ghost" data-testid="new-folder" disabled={busy}
              title={`Add a folder in ${folder || "the top level"}`}
              onClick={() => { setAdding("folder"); setAddName(""); }}>+ Folder</button>
          </div>
          <div className="archive-bar">
            {game !== "" && <button type="button" className="btn-ghost" disabled={busy}
              aria-label={`Export game ${game}`} onClick={() => void downloadArchive(game, "game")}>Export game ZIP</button>}
            <button type="button" className="btn-ghost" disabled={busy}
              onClick={() => setShowImport((shown) => !shown)}>Import ZIP</button>
          </div>
          {showImport && <form className="archive-import" onSubmit={(event) => { event.preventDefault(); void uploadArchive(); }}>
            <input type="file" accept=".zip,application/zip" aria-label="Choose ZIP archive" disabled={busy}
              onChange={(event) => setArchiveFile(event.target.files?.[0] ?? null)} />
            <select aria-label="Import destination" value={importGame} disabled={busy}
              onChange={(event) => setImportGame(event.target.value)}>
              <option value="">New game (game ZIP)</option>
              {games.filter(Boolean).map((g) => <option key={g} value={g}>{g} (folder ZIP)</option>)}
            </select>
            <button type="submit" className="btn-primary" disabled={busy || !archiveFile}>Import</button>
          </form>}
          {game !== "" && renamingFolder === game && folderRenameForm(game)}
          {adding && (
            <form className="new-model" onSubmit={(event) => { event.preventDefault(); void addFolder(); }}>
              <input data-testid="new-folder-name" value={addName} autoFocus disabled={busy}
                aria-label={adding === "game" ? "New game name" : "New folder name"}
                placeholder={adding === "game" ? "Game name" : "Folder name"}
                title={adding === "game" ? "A new top-level folder" : `A new folder in ${folder || "the top level"}`}
                onChange={(event) => setAddName(event.target.value)} />
              <button type="submit" className="btn-primary" data-testid="add-folder"
                disabled={busy || addName.trim() === ""}>Add</button>
              <button type="button" className="btn-ghost" onClick={() => setAdding(null)}>Cancel</button>
            </form>
          )}
          <form className="new-model" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <input id="new-model-name" data-testid="new-model-name" value={newName}
              aria-label="New model name" placeholder="New model name" title={`New models go into ${folder || "the top level"}`}
              onChange={(event) => setNewName(event.target.value)} disabled={busy} />
            <button type="submit" data-testid="create-model" className="btn-primary"
              disabled={busy || newName.trim() === ""}>Create</button>
          </form>
          {managementError && <p role="alert" data-testid="management-error" className="alert">{managementError}</p>}
          {loadingModels && <p data-testid="loading-models" className="muted">Listing…</p>}
          {loadError && <p data-testid="list-error" className="alert">{loadError}</p>}
          {dragging && games.some((g) => g !== game && canDrop(g)) && (
            <div className="game-drop" data-testid="game-drop">
              <span className="muted">Drop into another game</span>
              {games.filter((g) => g !== game && canDrop(g)).map((g) => (
                <div key={g} className="game-drop-target" data-testid={`game-drop-${g || "top"}`} {...dropProps(g)}>
                  {g || "Top level"}
                </div>
              ))}
            </div>
          )}
          <div data-testid="model-list" data-game={game} className="model-tree" {...dropProps(game)}>
            {folderContents(tree)}
            {!loadingModels && tree.folders.length === 0 && tree.models.length === 0 && games.length > 0 && (
              <p className="muted folder-empty" data-testid="game-empty">No models here yet.</p>
            )}
            {dragging && canDrop(game) && (
              <p className="muted folder-empty" data-testid="game-top-drop">Drop here for the top of {game || "the top level"}</p>
            )}
          </div>
        </div>
      </aside>
      <main className="workspace">
        {selectedPath === null && <div className="empty-state" data-testid="no-model">Select a model to open.</div>}
        {loadingSelected && <div className="empty-state" data-testid="loading-model">Loading…</div>}
        {loadError && selectedPath !== null && (
          <p data-testid="load-error" className="alert">{loadError}</p>
        )}
        {selectedPath !== null && !loadingSelected && loaded !== null && (
          <OpenModel path={selectedPath} loaded={loaded} report={report} onDraftDirtyChange={setYamlDraftDirty} />
        )}
      </main>
    </div>
  );
}

/** File name without folder or `.yaml` extension. */
function fileStem(path: string): string {
  return path.split("/").pop()!.replace(/\.ya?ml$/i, "");
}

interface OpenModelProps {
  path: string;
  loaded: LoadedModel;
  report: ReturnType<typeof useAppStore.getState>["report"];
  onDraftDirtyChange: (dirty: boolean) => void;
}

function OpenModel({ path, loaded, report, onDraftDirtyChange }: OpenModelProps): JSX.Element {
  const [tab, setTab] = useState<"graph" | "yaml">("graph");
  const [yamlDraft, setYamlDraft] = useState(loaded.yaml ?? "");
  const [yamlBaseline, setYamlBaseline] = useState(loaded.yaml ?? "");
  const [yamlEntry, setYamlEntry] = useState(loaded.yaml ?? "");
  const [yamlHash, setYamlHash] = useState(loaded.hash);
  const [yamlErrors, setYamlErrors] = useState<string[]>([]);
  const [yamlConflict, setYamlConflict] = useState(false);
  const [yamlSaving, setYamlSaving] = useState(false);
  const lastPath = useRef(path);
  const yamlDirty = tab === "yaml" && yamlDraft !== yamlBaseline;
  useEffect(() => onDraftDirtyChange(yamlDirty), [yamlDirty, onDraftDirtyChange]);
  useEffect(() => {
    const pathChanged = lastPath.current !== path;
    lastPath.current = path;
    if (!pathChanged && yamlDirty) return;
    setYamlDraft(loaded.yaml ?? "");
    setYamlBaseline(loaded.yaml ?? "");
    setYamlEntry(loaded.yaml ?? "");
    setYamlHash(loaded.hash);
    setYamlErrors([]);
    setYamlConflict(false);
    setTab("graph");
  }, [path, loaded]);
  const [selection, setSelection] = useState<{ nodeId?: string; edgeId?: string }>({});
  const handleSelectionChange = (next: { nodeId?: string; edgeId?: string }): void => {
    setSelection((current) => current.nodeId === next.nodeId && current.edgeId === next.edgeId
      ? current : next);
  };
  useEffect(() => setSelection({}), [path]);
  const editedModel = useEditorStore((s) => s.model);
  const model = editedModel && useEditorStore.getState().path === path
    ? editedModel
    : loaded.model;
  const showYaml = (): void => {
    if (tab === "yaml") return;
    const source = useEditorStore.getState().dirty && model ? serializeModelYaml(model) : loaded.yaml ?? "";
    setYamlDraft(source);
    setYamlEntry(source);
    setYamlBaseline(loaded.yaml ?? "");
    setYamlHash(useEditorStore.getState().dirty && model
      ? useEditorStore.getState().hash : loaded.hash);
    setTab("yaml");
  };
  const showGraph = (): void => {
    if (yamlDraft !== yamlEntry && !window.confirm("Discard unsaved YAML changes?")) return;
    setTab("graph");
  };
  const saveYaml = async (): Promise<void> => {
    const parsed = parseModelYaml(yamlDraft);
    if (!parsed.ok) {
      setYamlErrors(parsed.errors.map((error) => `${error.path}: ${error.message}`));
      return;
    }
    setYamlSaving(true);
    setYamlErrors([]);
    setYamlConflict(false);
    try {
      await saveModel(path, yamlDraft, yamlHash ?? undefined);
      setTab("graph");
      await useAppStore.getState().selectModel(path);
    } catch (error) {
      if (error instanceof ConflictError) {
        if (!yamlDirty) { setTab("graph"); await useAppStore.getState().selectModel(path); }
        else setYamlConflict(true);
      } else setYamlErrors([error instanceof Error ? error.message : String(error)]);
    } finally { setYamlSaving(false); }
  };
  const overwriteYaml = async (): Promise<void> => {
    setYamlSaving(true);
    try {
      await saveModel(path, yamlDraft);
      setTab("graph");
      await useAppStore.getState().selectModel(path);
    } catch (error) {
      setYamlErrors([error instanceof Error ? error.message : String(error)]);
    } finally { setYamlSaving(false); }
  };
  // The selected finding's id is lifted here so both the panel (which sets it)
  // and the graph (which dims everything but it) can react. Reset it whenever
  // the report changes so ids from a previous model cannot linger.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  useEffect(() => {
    setHighlightedId(null);
  }, [report]);

  // Load the opened model into the editable editor store. Re-run when the path
  // or the loaded model identity changes (a new model opened), but not when the
  // report is replaced by a re-analysis (that keeps the same `loaded`).
  //
  // A watch reload of this model while the graph has unsaved edits must not
  // replace them (AGENTS.md, model editing protocol): keep the local model and
  // its If-Match hash, and offer Reload/Overwrite instead. A reload whose hash
  // matches ours is our own save echoing back, so the local edits just stay.
  const [graphConflict, setGraphConflict] = useState<LoadedModel | null>(null);
  useEffect(() => {
    if (!path || !loaded.model || yamlDirty) return;
    const editor = useEditorStore.getState();
    if (editor.path === path && editor.dirty) {
      if (loaded.hash !== editor.hash) setGraphConflict(loaded);
      // The fetched report describes the file, not the local edits.
      editor.scheduleAnalyze();
      return;
    }
    setGraphConflict(null);
    editor.load(path, loaded.model, loaded.hash as string);
  }, [path, loaded]);
  const reloadRemote = (): void => {
    if (!graphConflict?.model) return;
    useEditorStore.getState().load(path, graphConflict.model, graphConflict.hash as string);
    setGraphConflict(null);
  };
  const overwriteRemote = async (): Promise<void> => {
    if (!graphConflict) return;
    // Save against the remote hash, so a further remote change still 409s.
    useEditorStore.setState({ hash: graphConflict.hash });
    try {
      await useEditorStore.getState().save();
      setGraphConflict(null);
    } catch (error) {
      if (error instanceof ConflictError) await useAppStore.getState().reload();
      else throw error;
    }
  };

  // Arm the re-analysis sink once: after edits, the editor re-runs analyzeModel
  // (debounced) and delivers the report here to replace the fetched one.
  useEffect(() => {
    useEditorStore.getState().setReportSink((report) => {
      useAppStore.getState().setReport(report);
    });
  }, []);

  // Keyboard shortcuts for the editor: undo / redo / save. Ignored while typing
  // in a field so they do not hijack text input.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        const { path: openPath, model } = useEditorStore.getState();
        if (!openPath || !model) return;
        event.preventDefault();
        void useEditorStore.getState().save();
      } else if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) useEditorStore.getState().redo();
        else useEditorStore.getState().undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Simulation check findings (the active run and Monte Carlo batch) and
  // search findings join the static analysis findings in one list.
  const simulationFindings = useSimulationFindings(model ?? null);
  const searchFindings = useSearchFindings(model ?? null);
  const findings = useMemo(
    () => [...(report?.findings ?? []), ...simulationFindings, ...searchFindings],
    [report, simulationFindings, searchFindings],
  );
  const highlighted = findings.find((f) => f.id === highlightedId) ?? undefined;
  const highlightedNodeIds = useMemo(
    () => (highlighted ? new Set(highlighted.nodes) : new Set<string>()),
    [highlighted],
  );
  const highlightedEdgeIds = useMemo(
    () => (highlighted ? new Set(highlighted.edges) : new Set<string>()),
    [highlighted],
  );

  const validationErrors = loaded.errors ?? [];
  const [dockTab, setDockTab] = useState<DockTab>("findings");
  // Collapsed to its tab strip at first, so the canvas gets the room; the
  // tabs still show the finding count.
  const [dockOpen, setDockOpen] = useState(false);
  // A summary badge opens the findings filtered to its severity; the count
  // remounts the panel so the filter applies on every click.
  const [findingsFocus, setFindingsFocus] = useState({ severity: "all", count: 0 });
  const showFindings = (severity: string): void => {
    setFindingsFocus((f) => ({ severity, count: f.count + 1 }));
    setDockTab("findings");
    setDockOpen(true);
  };
  const selectDockTab = (next: DockTab): void => {
    if (next === dockTab) setDockOpen(!dockOpen);
    else { setDockTab(next); setDockOpen(true); }
  };
  const graphReady = model !== null && model !== undefined && Array.isArray(model.nodes);
  const dockTabs: Array<{ id: DockTab; label: string; count?: number }> = [
    { id: "findings", label: "Findings", count: findings.length },
    { id: "interaction", label: "Interaction" },
    { id: "simulate", label: "Simulate" },
    { id: "search", label: "Search" },
  ];
  return (
    <article data-testid="open-model" className="workspace" style={{ flex: 1 }}>
      <header className="topbar">
        <div className="topbar-title">
          <h2 data-testid="model-name">{loaded.model?.name ?? path}</h2>
          <span data-testid="model-path" className="path">{path}</span>
        </div>
        <nav aria-label="Model view" className="segmented">
          <button type="button" data-testid="graph-tab" aria-current={tab === "graph" ? "page" : undefined}
            onClick={showGraph}>Graph</button>
          <button type="button" data-testid="yaml-tab" aria-current={tab === "yaml" ? "page" : undefined}
            onClick={showYaml}>YAML</button>
        </nav>
        <div className="topbar-spacer" />
        {validationErrors.length === 0 &&
          <span data-testid="no-validation-errors" className="badge badge-ok">✓ Valid</span>}
        {report && <ReportSummary summary={report.summary} onShow={showFindings} />}
      </header>

      {tab === "yaml" ? (
        <section data-testid="yaml-editor" className="yaml-view">
          <label htmlFor="yaml-source" className="muted">Model YAML</label>
          <textarea id="yaml-source" data-testid="yaml-source" value={yamlDraft} spellCheck={false}
            onChange={(event) => { setYamlDraft(event.target.value); setYamlErrors([]); setYamlConflict(false); }}
            rows={24} />
          {yamlConflict && <div role="alert" data-testid="yaml-conflict" className="alert">
            This model changed on disk. Reload to take the remote version, or overwrite it with your YAML.
            <button type="button" onClick={() => { setTab("graph"); void useAppStore.getState().selectModel(path); }}>Reload</button>
            <button type="button" onClick={() => void overwriteYaml()} disabled={yamlSaving}>Overwrite</button>
          </div>}
          {yamlErrors.length > 0 && <ul role="alert" data-testid="yaml-errors" className="alert" style={{ margin: 0, paddingLeft: 28, display: "block" }}>
            {yamlErrors.map((error, index) => <li key={index}>{error}</li>)}
          </ul>}
          <div className="yaml-actions">
            <button type="button" data-testid="save-yaml" className="btn-primary" onClick={() => void saveYaml()}
              disabled={yamlSaving}>Save YAML</button>
          </div>
        </section>
      ) : (
      <div className="editor">
        <div className="center">
          {(graphConflict || validationErrors.length > 0) && <div className="banners">
            {graphConflict && <div role="alert" data-testid="graph-conflict" className="alert">
              This model changed on disk while you have unsaved graph edits. Reload to take the
              remote version, or overwrite it with your edits.
              <button type="button" data-testid="graph-conflict-reload" onClick={reloadRemote}>Reload</button>
              <button type="button" data-testid="graph-conflict-overwrite"
                onClick={() => void overwriteRemote()}>Overwrite</button>
            </div>}
            {validationErrors.length > 0 && (
              <section data-testid="validation-errors" className="alert" style={{ display: "block" }}>
                <strong>Validation errors ({validationErrors.length})</strong>
                <ul data-testid="validation-error-list" style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {validationErrors.map((err, i) => (
                    <li key={i} data-testid="validation-error">
                      {typeof err === "string" ? err : `${err.path || "YAML"}: ${err.message}`}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>}

          <div className="canvas">
            {model && (
              <ErrorBoundary area="The graph view" hint="Pick another model, or edit this one in the YAML view." resetKey={path}>
                <GraphView
                  model={model}
                  report={report}
                  highlightedNodeIds={highlightedNodeIds}
                  highlightedEdgeIds={highlightedEdgeIds}
                  onSelectionChange={handleSelectionChange}
                />
              </ErrorBoundary>
            )}
          </div>

          <section className="dock" data-open={dockOpen} data-testid="dock">
            <div className="dock-tabs" role="tablist" aria-label="Analysis panels">
              {dockTabs.map((t) => (
                <button key={t.id} type="button" role="tab" data-testid={`dock-tab-${t.id}`}
                  aria-selected={dockOpen && dockTab === t.id} onClick={() => selectDockTab(t.id)}>
                  {t.label}
                  {t.count !== undefined && <span className="count">{t.count}</span>}
                </button>
              ))}
              <div className="topbar-spacer" />
              <button type="button" className="btn-ghost btn-icon" data-testid="dock-toggle"
                aria-label={dockOpen ? "Collapse panel" : "Expand panel"}
                title={dockOpen ? "Collapse panel" : "Expand panel"}
                onClick={() => setDockOpen(!dockOpen)}>{dockOpen ? "▾" : "▴"}</button>
            </div>
            {/* Panels stay mounted while hidden so runs, searches and chart
                state survive switching tabs. */}
            <div className="dock-body" hidden={!dockOpen}>
              <div role="tabpanel" hidden={dockTab !== "findings"}>
                {findings.length > 0 ? (
                  <FindingsPanel
                    key={findingsFocus.count}
                    initialSeverity={findingsFocus.severity}
                    findings={findings}
                    highlightedId={highlightedId}
                    onSelect={setHighlightedId}
                  />
                ) : (
                  <p data-testid="no-findings" className="muted">No findings.</p>
                )}
              </div>
              <div role="tabpanel" hidden={dockTab !== "interaction"}>
                {!report ? <p className="muted">No analysis yet.</p>
                  : report.matrix.ids.length === 0
                    ? <p data-testid="matrix-empty" className="muted">
                        The interaction matrix compares mechanics and entities; this model has none.</p>
                    : <MatrixView report={report} />}
              </div>
              <div role="tabpanel" hidden={dockTab !== "simulate"}>
                {graphReady && <ChartPanel model={model} />}
              </div>
              <div role="tabpanel" hidden={dockTab !== "search"}>
                {graphReady && <SearchPanel model={model} />}
              </div>
            </div>
          </section>
        </div>
        <aside className="inspector-col">
          {model && Array.isArray(model.properties) && Array.isArray(model.subsystems) &&
            <Inspector model={model} selection={selection} />}
        </aside>
      </div>
      )}
    </article>
  );
}

type DockTab = "findings" | "interaction" | "simulate" | "search";

/** Finding counts by severity; each opens the Findings panel filtered to it. */
function ReportSummary({ summary, onShow }: {
  summary: ReportSummary;
  onShow: (severity: string) => void;
}): JSX.Element {
  return (
    <div data-testid="report-summary" className="summary">
      <button type="button" data-testid="summary-errors" className={`badge ${summary.errors ? "badge-error" : ""}`}
        title="Show errors" onClick={() => onShow("error")}>✕ {summary.errors}</button>
      <button type="button" data-testid="summary-warnings"
        className={`badge ${summary.warnings ? "badge-warning" : ""}`}
        title="Show warnings" onClick={() => onShow("warning")}>! {summary.warnings}</button>
      <button type="button" data-testid="summary-infos" className="badge" title="Show info"
        onClick={() => onShow("info")}>i {summary.infos}</button>
    </div>
  );
}
