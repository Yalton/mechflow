import {
  boundarySweep,
  compareSystems,
  dominantCombinations,
  optimizePlayer,
  possibilitySpace,
  type BoundaryReport,
  type DominantReport,
  type Finding,
  type Model,
  type Objective,
  type OptimizerReport,
  type SearchOptions,
  type SpaceReport,
  type SystemsReport,
} from "@mechflow/core";

/** The five search analyses (docs/search-design.md), in tab order. */
export const ANALYSES = ["dominant", "systems", "optimizer", "space", "boundary"] as const;
export type Analysis = (typeof ANALYSES)[number];

export const ANALYSIS_LABELS: Record<Analysis, string> = {
  dominant: "Dominant combinations",
  systems: "System dominance",
  optimizer: "Optimiser player",
  space: "Possibility space",
  boundary: "Boundaries",
};

export interface SearchRequest {
  analysis: Analysis;
  objective: string | Objective;
  seed: number;
  steps: number;
  runs: number;
  maxEvaluations: number;
}

/** Each analysis's report, tagged with the analysis that made it. */
export type SearchReport =
  | { analysis: "boundary"; report: BoundaryReport }
  | { analysis: "dominant"; report: DominantReport }
  | { analysis: "systems"; report: SystemsReport }
  | { analysis: "optimizer"; report: OptimizerReport }
  | { analysis: "space"; report: SpaceReport };

export type SearchResponse =
  | ({ ok: true; findings: Finding[]; evaluationsUsed: number } & SearchReport)
  | { ok: false; error: string };

/**
 * Run one search analysis on `model`. The worker calls this off the main
 * thread; tests and browsers without workers call it directly. Problems come
 * back as an error message, never as an exception.
 */
export function runSearch(model: Model, request: SearchRequest): SearchResponse {
  const options: SearchOptions = {
    objective: request.objective,
    seed: request.seed,
    steps: request.steps,
    runs: request.runs,
    maxEvaluations: request.maxEvaluations,
  };
  try {
    const tagged = <A extends Analysis, R>(
      analysis: A,
      result:
        | { ok: true; result: { findings: Finding[]; report: R; evaluationsUsed: number } }
        | { ok: false; errors: { path: string; message: string }[] },
    ): SearchResponse => {
      if (!result.ok) {
        return { ok: false, error: result.errors.map((e) => `${e.path}: ${e.message}`).join("\n") };
      }
      const { findings, report, evaluationsUsed } = result.result;
      return { ok: true, findings, evaluationsUsed, analysis, report } as SearchResponse;
    };
    switch (request.analysis) {
      case "boundary":
        return tagged("boundary", boundarySweep(model, options));
      case "dominant":
        return tagged("dominant", dominantCombinations(model, options));
      case "systems":
        return tagged("systems", compareSystems(model, options));
      case "optimizer":
        return tagged("optimizer", optimizePlayer(model, options));
      case "space":
        return tagged("space", possibilitySpace(model, options));
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
