/**
 * Viable possibility space (docs/search-design.md, "Viable possibility space
 * (search-narrow-space)"): how many strategies come close to the best, and
 * which of the best are robust and which are specialists.
 */

import type { Finding } from "../analysis/types.js";
import type { Model, Objective, Strategy } from "../model/types.js";
import { spread } from "../sim/montecarlo.js";
import type { SimError } from "../sim/types.js";
import { knobsOf, settingsFor, type FieldKnob } from "./boundary.js";
import { dominantCombinations, focusStrategy, type DominantOptions } from "./dominant.js";
import { evaluateCandidate, oriented, resolveObjective } from "./evaluate.js";
import { DEFAULT_MAX_EVALUATIONS, type SearchResult } from "./types.js";

export interface SpaceOptions extends Omit<DominantOptions, "minSynergy" | "minMargin"> {
  /** A candidate is viable within this fraction of the best; default 0.1. */
  viable?: number;
  /** Flag fewer viable candidates than this; default 3. */
  minViable?: number;
  /** ...or a viable share under this; default 0.05. */
  minViableShare?: number;
  /** How many of the best are re-scored for robustness; default 10. */
  top?: number;
  /** Field overrides to vary for robustness, alongside the parameters. */
  fields?: FieldKnob[];
}

export const SPACE_DEFAULTS = { viable: 0.1, minViable: 3, minViableShare: 0.05, top: 10 } as const;

export interface SpaceCandidate {
  /** "focus:a+b" for a found set, or "strategy:<id>" for a model strategy. */
  label: string;
  strategy: Strategy | string;
  score: number;
  viable: boolean;
}

export interface RobustnessEntry {
  label: string;
  strategy: Strategy | string;
  /** Score at each setting, by setting label. */
  scores: Record<string, number>;
  /** p5 and p95 of the oriented scores across settings, oriented back. */
  worstCase: number;
  bestCase: number;
  /** For a specialist: the setting it scores best at. */
  dependsOn?: string;
}

export interface SpaceReport {
  objective: Objective;
  candidates: SpaceCandidate[];
  viableCount: number;
  /** Setting labels the robustness pass used. */
  settings: string[];
  robust: RobustnessEntry[];
  specialists: RobustnessEntry[];
}

export type SpaceResult =
  { ok: true; result: SearchResult<SpaceReport> } | { ok: false; errors: SimError[] };

export function possibilitySpace(model: Model, options: SpaceOptions): SpaceResult {
  const resolved = resolveObjective(model, options.objective);
  if (!resolved.ok) return resolved;
  const objective = resolved.resolved.objective;
  const { viable, minViable, minViableShare, top } = { ...SPACE_DEFAULTS, ...options };
  const better = (a: number, b: number): number => oriented(b, objective) - oriented(a, objective);
  const total = options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS;

  // The robustness pass needs `top` candidates times the settings; the
  // candidate search and the model strategies get the rest.
  const settings = settingsFor(knobsOf(model, options.fields), true);
  const strategies = model.strategies ?? [];
  const robustCost =
    settings.length > 1
      ? Math.min(top, Math.floor(total / 2 / settings.length)) * settings.length
      : 0;
  const searchBudget = Math.max(1, total - robustCost - strategies.length);
  const search = dominantCombinations(model, {
    objective: options.objective,
    seed: options.seed,
    steps: options.steps,
    maxEvaluations: searchBudget,
    ...(options.runs !== undefined ? { runs: options.runs } : {}),
    ...(options.k !== undefined ? { k: options.k } : {}),
    ...(options.nodes ? { nodes: options.nodes } : {}),
  });
  if (!search.ok) return search;
  let used = search.result.evaluationsUsed;

  const evaluate = (strategy: Strategy | string, setting = settings[0]!) => {
    used++;
    return evaluateCandidate(model, { strategy, ...setting.candidate }, options);
  };
  const scored: Omit<SpaceCandidate, "viable">[] = search.result.report.ranked.map((r) => ({
    label: `focus:${r.nodes.join("+")}`,
    strategy: focusStrategy(r.nodes),
    score: r.score,
  }));
  for (const s of strategies) {
    const result = evaluate(s.id);
    if (!result.ok) return result;
    scored.push({ label: `strategy:${s.id}`, strategy: s.id, score: result.evaluation.score });
  }
  scored.sort((a, b) => better(a.score, b.score) || (a.label < b.label ? -1 : 1));

  const best = scored[0];
  const isViable = (score: number): boolean =>
    best !== undefined &&
    oriented(best.score, objective) - oriented(score, objective) <= viable * Math.abs(best.score);
  const candidates: SpaceCandidate[] = scored.map((c) => ({ ...c, viable: isViable(c.score) }));
  const viableCount = candidates.filter((c) => c.viable).length;

  const findings: Finding[] = [];
  const share = candidates.length > 0 ? viableCount / candidates.length : 1;
  if (candidates.length > minViable && (viableCount < minViable || share < minViableShare)) {
    const viableOnes = candidates.filter((c) => c.viable);
    findings.push({
      id: "search-narrow-space:space",
      check: "search-narrow-space",
      severity: "warning",
      title: `Only ${viableCount} of ${candidates.length} strategies are viable`,
      detail:
        `Within ${Math.round(viable * 100)}% of the best score on ${objective.id}: ` +
        `${viableOnes.map((c) => c.label).join(", ")}. Every other strategy found trails further behind.`,
      nodes: [
        ...new Set(
          viableOnes.flatMap((c) =>
            typeof c.strategy === "string"
              ? (strategies.find((s) => s.id === c.strategy)?.rules.map((r) => r.fire) ?? [])
              : c.strategy.rules.map((r) => r.fire),
          ),
        ),
      ].sort(),
      edges: [],
      data: {
        objective: objective.id,
        viable: viableOnes.map((c) => ({ label: c.label, score: c.score })),
        candidates: candidates.length,
        seed: options.seed,
      },
    });
  }

  // Robustness: re-score the best under each single-knob setting.
  const robustness: RobustnessEntry[] = [];
  const topCount = settings.length > 1 ? robustCost / settings.length : 0;
  for (const candidate of candidates.slice(0, topCount)) {
    const scores: Record<string, number> = {};
    for (const setting of settings) {
      const result = evaluate(candidate.strategy, setting);
      if (!result.ok) return result;
      scores[setting.label] = result.evaluation.score;
    }
    const across = spread(Object.values(scores).map((v) => oriented(v, objective)));
    const back = (v: number): number => (objective.sense === "max" ? v : -v);
    robustness.push({
      label: candidate.label,
      strategy: candidate.strategy,
      scores,
      worstCase: back(across.p5),
      bestCase: back(across.p95),
    });
  }
  const byWorst = [...robustness].sort((a, b) => better(a.worstCase, b.worstCase));
  const byBest = [...robustness].sort((a, b) => better(a.bestCase, b.bestCase));
  const bottomHalf = new Set(byWorst.slice(Math.ceil(byWorst.length / 2)).map((r) => r.label));
  const specialists = byBest
    .slice(0, 3)
    .filter((r) => bottomHalf.has(r.label))
    .map((r) => ({
      ...r,
      dependsOn: Object.entries(r.scores).sort(([, a], [, b]) => better(a, b))[0]![0],
    }));
  const specialistLabels = new Set(specialists.map((r) => r.label));
  const robust = byWorst.filter((r) => !specialistLabels.has(r.label)).slice(0, 3);

  return {
    ok: true,
    result: {
      findings,
      report: {
        objective,
        candidates,
        viableCount,
        settings: settings.map((s) => s.label),
        robust,
        specialists,
      },
      evaluationsUsed: used,
    },
  };
}
