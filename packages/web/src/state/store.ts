import { create } from "zustand";
import type { Model, Report, SchemaError } from "@mechflow/core";
import { fetchModel, fetchModels, fetchReport } from "../api/models.js";

/** Everything the server returns for an opened model. */
export interface LoadedModel {
  model: Model | null;
  /** Validation errors, or null when the model parsed. */
  errors: (string | SchemaError)[] | null;
  /** Content hash the server reported (used as If-Match on the next save). */
  hash: string | null;
  yaml: string;
}

/**
 * Application state for the viewer/editor shell.
 *
 * Kept framework-lean (zustand): the sidebar reads `models`, opening a model
 * populates `selectedPath` + `loaded` + `report`, and live `/ws` updates call
 * {@link handleModelChanged} to reload the open model.
 */
export interface AppState {
  /** Repo-relative model paths from `GET /api/models`. */
  models: string[];
  /** Every folder under the models root, empty ones too (see folders.ts). */
  folders: string[];
  loadingModels: boolean;
  /** Top-level failure message (listing or opening), or null. */
  loadError: string | null;

  selectedPath: string | null;
  loaded: LoadedModel | null;
  report: Report | null;
  loadingSelected: boolean;

  /** Fetch and populate the model list. */
  loadModels: () => Promise<void>;
  /** Open a model: parse it, fetch its report, clear prior state. */
  selectModel: (path: string) => Promise<void>;
  /** Replace the current analysis report (used by the editor's re-analyze). */
  setReport: (report: Report) => void;
  /** Re-open the currently selected model (used on live reload). */
  reload: () => Promise<void>;
  clearSelection: () => void;
  /** Called on a `model-changed` /ws event. */
  handleModelChanged: (path: string) => void;
  /** Called on a `model-removed` /ws event. */
  handleModelRemoved: (path: string) => void;
  /** Clear all state (tests). */
  reset: () => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const useAppStore = create<AppState>((set, get) => ({
  models: [],
  folders: [],
  loadingModels: false,
  loadError: null,
  selectedPath: null,
  loaded: null,
  report: null,
  loadingSelected: false,

  loadModels: async () => {
    set({ loadingModels: true, loadError: null });
    try {
      const { models, folders = [] } = await fetchModels();
      set({ models, folders, loadingModels: false });
    } catch (error) {
      set({ loadingModels: false, loadError: errorMessage(error) });
    }
  },

  selectModel: async (path) => {
    const samePath = get().selectedPath === path && get().loaded !== null;
    set({
      selectedPath: path,
      loadingSelected: !samePath,
      loadError: null,
      loaded: samePath ? get().loaded : null,
      report: samePath ? get().report : null,
    });
    try {
      const opened = await fetchModel(path);
      const report = opened.model ? await fetchReport(path) : null;
      if (get().selectedPath !== path) return;
      set({
        loaded: { model: opened.model as Model | null, errors: opened.errors, hash: opened.hash, yaml: opened.yaml },
        report,
        loadingSelected: false,
      });
    } catch (error) {
      set({ loadingSelected: false, loadError: errorMessage(error) });
    }
  },

  setReport: (report) => {
    set({ report });
  },

  reload: async () => {
    const path = get().selectedPath;
    if (path) await get().selectModel(path);
  },

  clearSelection: () => {
    set({ selectedPath: null, loaded: null, report: null, loadingSelected: false, loadError: null });
  },

  handleModelChanged: (path) => {
    void get().loadModels();
    if (get().selectedPath === path) void get().reload();
  },

  handleModelRemoved: (path) => {
    void get().loadModels();
    if (get().selectedPath === path) {
      set({ selectedPath: null, loaded: null, report: null });
    }
  },

  reset: () => {
    set({
      models: [],
      folders: [],
      loadingModels: false,
      loadError: null,
      selectedPath: null,
      loaded: null,
      report: null,
      loadingSelected: false,
    });
  },
}));
