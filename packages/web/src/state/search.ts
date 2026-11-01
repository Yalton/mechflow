import { useMemo } from "react";
import { create } from "zustand";
import type { Finding, Model } from "@mechflow/core";
import type { Analysis, SearchRequest, SearchResponse } from "../search/analyses.js";
import { startSearch, type SearchJob } from "../search/client.js";

type Result = Extract<SearchResponse, { ok: true }>;

/**
 * Search results for one model object, as the run store keeps its batch: an
 * edit makes a new model object, and results for the old one stop showing.
 */
export interface SearchState {
  model: Model | null;
  /** The latest result of each analysis for `model`. */
  results: Partial<Record<Analysis, Result>>;
  /** The analysis running now, or null. */
  running: Analysis | null;
  error: string | null;
  job: SearchJob | null;

  run: (model: Model, request: SearchRequest) => Promise<void>;
  cancel: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  model: null,
  results: {},
  running: null,
  error: null,
  job: null,

  run: async (model, request) => {
    get().job?.cancel();
    const job = startSearch(model, request);
    const results = get().model === model ? get().results : {};
    set({ model, results, running: request.analysis, error: null, job });
    const response = await job.result;
    // A cancelled job, or one a newer search replaced, changes nothing.
    if (response === null || get().job !== job) return;
    if (!response.ok) {
      set({ running: null, error: response.error, job: null });
      return;
    }
    set({
      running: null,
      job: null,
      results: { ...get().results, [request.analysis]: response },
    });
  },

  cancel: () => {
    get().job?.cancel();
    set({ running: null, job: null });
  },
}));

/** The search findings for `model`; they join the findings panel. */
export function useSearchFindings(model: Model | null): Finding[] {
  const results = useSearchStore((s) => (s.model === model ? s.results : null));
  return useMemo(
    () => (results ? Object.values(results).flatMap((r) => r.findings) : []),
    [results],
  );
}
