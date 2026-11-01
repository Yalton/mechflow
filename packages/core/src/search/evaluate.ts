/**
 * Scores one candidate against an objective (docs/search-design.md,
 * "Objectives" and "Evaluations and budgets"). An evaluation is a Monte Carlo
 * batch; every candidate scored with the same seed and run count sees the same
 * derived seeds, so differences between candidates come from the candidate,
 * not from luck.
 */

import { evaluate, parseFormula, references, type Expr } from "../formula/index.js";
import type { Model, Objective } from "../model/types.js";
import { monteCarlo, spread, valuesAt, type MonteCarloResult } from "../sim/montecarlo.js";
import { createRng } from "../sim/rng.js";
import type { SimError, Trace } from "../sim/types.js";
import { DEFAULT_RUNS, type Candidate } from "./types.js";

export interface EvaluateOptions {
  objective: string | Objective;
  seed: number;
  steps: number;
  runs?: number;
}

export interface Evaluation {
  /** The mean of the objective's measure over the batch's runs. */
  score: number;
  p5: number;
  p50: number;
  p95: number;
  /** The measure of every run, by run index. */
  perRun: number[];
  /** The batch, with its traces, for checks that read them. */
  batch: MonteCarloResult;
}

export type EvaluateResult =
  { ok: true; evaluation: Evaluation } | { ok: false; errors: SimError[] };

/** An objective, resolved and with its expression parsed. */
export interface ResolvedObjective {
  objective: Objective;
  expr: Expr | null;
}

/** Look up and parse `objective`; an unknown id or a bad expression is an error. */
export function resolveObjective(
  model: Model,
  objective: string | Objective,
): { ok: true; resolved: ResolvedObjective } | { ok: false; errors: SimError[] } {
  const path = "options.objective";
  const found =
    typeof objective === "string" ? model.objectives?.find((o) => o.id === objective) : objective;
  if (!found) {
    return { ok: false, errors: [{ path, message: `unknown objective "${String(objective)}"` }] };
  }
  if (found.measure === "endStep") return { ok: true, resolved: { objective: found, expr: null } };
  const parsed = parseFormula(found.expr);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [{ path: `${path}.expr`, message: `invalid formula: ${parsed.error.message}` }],
    };
  }
  const known = new Set([
    ...model.nodes.map((n) => n.id),
    ...(model.parameters ?? []).map((p) => p.id),
  ]);
  const unknown = references(parsed.ast).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: unknown.map((id) => ({
        path: `${path}.expr`,
        message: `formula references unknown node "${id}"`,
      })),
    };
  }
  return { ok: true, resolved: { objective: found, expr: parsed.ast } };
}

/**
 * Orient a score so that higher is always better: scores of a `min`
 * objective are negated.
 */
export function oriented(score: number, objective: Objective): number {
  return objective.sense === "max" ? score : -score;
}

/** Score `candidate` on `model` over a Monte Carlo batch. */
export function evaluateCandidate(
  model: Model,
  candidate: Candidate,
  options: EvaluateOptions,
): EvaluateResult {
  const resolved = resolveObjective(model, options.objective);
  if (!resolved.ok) return resolved;
  const batch = monteCarlo(model, {
    seed: options.seed,
    runs: options.runs ?? DEFAULT_RUNS,
    steps: options.steps,
    keepTraces: true,
    ...(candidate.strategy !== undefined ? { strategy: candidate.strategy } : {}),
    ...(candidate.parameters ? { parameters: candidate.parameters } : {}),
    ...(candidate.overrides ? { overrides: candidate.overrides } : {}),
  });
  if (!batch.ok) return batch;
  const parameters: Record<string, number> = {};
  for (const p of model.parameters ?? [])
    parameters[p.id] = candidate.parameters?.[p.id] ?? p.value;
  const perRun = batch.result.traces!.map((trace) =>
    measureTrace(trace, resolved.resolved, options.steps, parameters),
  );
  const { mean, p5, p50, p95 } = spread(perRun);
  return { ok: true, evaluation: { score: mean, p5, p50, p95, perRun, batch: batch.result } };
}

/**
 * One run's value of the objective's measure over `steps` steps. A run that
 * ended early holds its last values; `endStep` scores `steps + 1` for a run
 * that never ended.
 */
export function measureTrace(
  trace: Trace,
  { objective, expr }: ResolvedObjective,
  steps: number,
  parameters: Record<string, number>,
): number {
  if (objective.measure === "endStep") {
    return trace.end?.reason === "endCondition" ? trace.end.step : steps + 1;
  }
  // A dice roll in an objective is drawn from the run's own seed, so the
  // score stays reproducible.
  const rng = createRng(trace.seed);
  const at = (step: number): number => {
    const { amounts, registers } = valuesAt(trace, step);
    return evaluate(expr!, {
      lookup: (id) => amounts[id] ?? registers[id] ?? parameters[id] ?? 0,
      rng: () => rng.next(),
    });
  };
  if (objective.measure === "final") return at(steps);
  let total = 0;
  for (let step = 1; step <= steps; step++) total += at(step);
  return total / steps;
}
