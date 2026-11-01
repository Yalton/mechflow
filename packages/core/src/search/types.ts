/**
 * Shared search types (docs/search-design.md, "Evaluations and budgets" and
 * "The analyses").
 */

import type { Finding } from "../analysis/types.js";
import type { Objective, Strategy } from "../model/types.js";

/** What search varies: a strategy plus parameter values and field overrides. */
export interface Candidate {
  /** A model strategy id or an inline strategy; none means no fires. */
  strategy?: string | Strategy;
  parameters?: Record<string, number>;
  overrides?: Record<string, number>;
}

/** Options every search takes. */
export interface SearchOptions {
  /** A model objective's id, or an inline objective. */
  objective: string | Objective;
  seed: number;
  steps: number;
  /** Runs per evaluation; default {@link DEFAULT_RUNS}. */
  runs?: number;
  /** Evaluations the search may use; default {@link DEFAULT_MAX_EVALUATIONS}. */
  maxEvaluations?: number;
}

export const DEFAULT_RUNS = 20;
export const DEFAULT_MAX_EVALUATIONS = 500;

/** What every analysis returns. */
export interface SearchResult<Report> {
  findings: Finding[];
  report: Report;
  evaluationsUsed: number;
}
