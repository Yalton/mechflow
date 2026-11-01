/**
 * System dominance (docs/search-design.md, "System dominance
 * (search-system-dominance)"): search each subsystem's interactive nodes on
 * their own and together, and flag a subsystem that makes the others obsolete.
 */

import type { Finding } from "../analysis/types.js";
import type { Model, Objective } from "../model/types.js";
import type { SimError } from "../sim/types.js";
import {
  dominantCombinations,
  focusStrategy,
  type DominantOptions,
  type RankedSet,
} from "./dominant.js";
import { evaluateCandidate, oriented, resolveObjective } from "./evaluate.js";
import { DEFAULT_MAX_EVALUATIONS, type SearchResult } from "./types.js";

export interface SystemsOptions extends Omit<
  DominantOptions,
  "nodes" | "minSynergy" | "minMargin"
> {
  /** Flag a subsystem whose best reaches this share of the overall best gain; default 0.95. */
  dominance?: number;
  /** ...when adding any other subsystem's best set gains less than this fraction; default 0.05. */
  minMargin?: number;
}

export const SYSTEMS_DEFAULTS = { dominance: 0.95, minMargin: 0.05 } as const;

/** Interactive nodes with no subsystem are grouped under this id. */
export const NO_SUBSYSTEM = "(none)";

/** How many of the overall best sets the fire shares are taken from. */
const TOP = 10;

export interface SubsystemSummary {
  subsystem: string;
  nodes: string[];
  /** The best set using only this subsystem's nodes; null if none was scored. */
  best: RankedSet | null;
  /** Its gain as a share of the overall best gain; null when that gain is not positive. */
  share: number | null;
  /** This subsystem's share of the nodes in the overall top 10 sets. */
  topShare: number;
}

export interface SystemsReport {
  objective: Objective;
  overall: RankedSet | null;
  subsystems: SubsystemSummary[];
}

export type SystemsResult =
  { ok: true; result: SearchResult<SystemsReport> } | { ok: false; errors: SimError[] };

export function compareSystems(model: Model, options: SystemsOptions): SystemsResult {
  const resolved = resolveObjective(model, options.objective);
  if (!resolved.ok) return resolved;
  const objective = resolved.resolved.objective;
  const { dominance, minMargin } = { ...SYSTEMS_DEFAULTS, ...options };

  const groups = new Map<string, string[]>();
  for (const node of model.nodes) {
    if (!("activation" in node) || node.activation !== "interactive") continue;
    const key = node.subsystem ?? NO_SUBSYSTEM;
    groups.set(key, [...(groups.get(key) ?? []), node.id].sort());
  }
  const keys = [...groups.keys()].sort();

  // The budget is split evenly between the unrestricted search and one per
  // subsystem, keeping a few evaluations for the "add another subsystem" checks.
  const total = options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS;
  const reserve = Math.max(0, keys.length - 1);
  const share = Math.max(1, Math.floor((total - reserve) / (keys.length + 1)));
  let used = 0;
  const run = (nodes?: string[]) => {
    // Only the shared search options pass through: `minMargin` means
    // something else to the dominant-combination search.
    const result = dominantCombinations(model, {
      objective: options.objective,
      seed: options.seed,
      steps: options.steps,
      maxEvaluations: share,
      ...(options.runs !== undefined ? { runs: options.runs } : {}),
      ...(options.k !== undefined ? { k: options.k } : {}),
      ...(nodes ? { nodes } : {}),
    });
    if (result.ok) used += result.result.evaluationsUsed;
    return result;
  };

  const overallSearch = run();
  if (!overallSearch.ok) return overallSearch;
  const baseline = overallSearch.result.report.baseline.score;
  const gainOf = (score: number): number =>
    oriented(score, objective) - oriented(baseline, objective);
  const bests = new Map<string, RankedSet | null>();
  for (const key of keys) {
    const search = run(groups.get(key)!);
    if (!search.ok) return search;
    bests.set(key, search.result.report.ranked[0] ?? null);
  }
  const candidates = [overallSearch.result.report.ranked[0], ...bests.values()].filter(
    (r): r is RankedSet => Boolean(r),
  );
  const overall =
    candidates.sort((a, b) => oriented(b.score, objective) - oriented(a.score, objective))[0] ??
    null;
  const overallGain = overall ? gainOf(overall.score) : 0;

  const top = overallSearch.result.report.ranked.slice(0, TOP).flatMap((r) => r.nodes);
  const subsystemOf = new Map<string, string>();
  for (const [key, nodes] of groups) for (const id of nodes) subsystemOf.set(id, key);
  const subsystems: SubsystemSummary[] = keys.map((key) => {
    const best = bests.get(key) ?? null;
    return {
      subsystem: key,
      nodes: groups.get(key)!,
      best,
      share: best && overallGain > 0 ? gainOf(best.score) / overallGain : null,
      topShare:
        top.length > 0 ? top.filter((id) => subsystemOf.get(id) === key).length / top.length : 0,
    };
  });

  const findings: Finding[] = [];
  if (keys.length > 1) {
    for (const summary of subsystems) {
      if (!summary.best || summary.share === null || summary.share < dominance) continue;
      const own = gainOf(summary.best.score);
      // Does adding the best set from any other subsystem still pay?
      const additions: { subsystem: string; gain: number }[] = [];
      let obsolete = true;
      for (const other of subsystems) {
        if (other === summary || !other.best) continue;
        if (used >= total) {
          obsolete = false;
          break;
        }
        used++;
        const together = evaluateCandidate(
          model,
          { strategy: focusStrategy([...summary.best.nodes, ...other.best.nodes]) },
          options,
        );
        if (!together.ok) return together;
        const extra = gainOf(together.evaluation.score) - own;
        additions.push({ subsystem: other.subsystem, gain: extra });
        if (extra >= minMargin * Math.abs(own)) obsolete = false;
      }
      if (!obsolete || additions.length === 0) continue;
      const others = additions.map((a) => a.subsystem);
      findings.push({
        id: `search-system-dominance:${summary.subsystem}`,
        check: "search-system-dominance",
        severity: "warning",
        title: `${summary.subsystem} makes ${others.join(", ")} obsolete`,
        detail:
          `Using only ${summary.subsystem} (${summary.best.nodes.join(", ")}) reaches ` +
          `${Math.round(summary.share * 100)}% of the best gain on ${objective.id}, and adding the best ` +
          `choices from ${others.join(", ")} gains less than ${Math.round(minMargin * 100)}% more.`,
        nodes: summary.best.nodes,
        edges: [],
        data: {
          objective: objective.id,
          subsystem: summary.subsystem,
          share: summary.share,
          additions,
          strategy: focusStrategy(summary.best.nodes),
          seed: options.seed,
        },
      });
    }
  }

  return {
    ok: true,
    result: { findings, report: { objective, overall, subsystems }, evaluationsUsed: used },
  };
}
