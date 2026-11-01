/**
 * The optimiser player (docs/search-design.md, "Optimiser player
 * (search-unintended-optimum)"): a greedy player that picks its fires each
 * step by rollout, to show what the design actually rewards.
 */

import type { Finding } from "../analysis/types.js";
import type { Model, Objective, Strategy } from "../model/types.js";
import { createEngine, type Engine } from "../sim/engine.js";
import { spread } from "../sim/montecarlo.js";
import { deriveSeed, createRng } from "../sim/rng.js";
import { createRun, prepareModel } from "../sim/run.js";
import type { SimError, SimState, StepRecord, Trace } from "../sim/types.js";
import { validateModel } from "../model/schema.js";
import {
  evaluateCandidate,
  measureTrace,
  oriented,
  resolveObjective,
  type ResolvedObjective,
} from "./evaluate.js";
import {
  DEFAULT_MAX_EVALUATIONS,
  DEFAULT_RUNS,
  type SearchOptions,
  type SearchResult,
} from "./types.js";

export interface OptimizerOptions extends SearchOptions {
  /** Steps each rollout plays ahead; default 10. */
  horizon?: number;
  /** Rollouts per action; default 4. */
  rollouts?: number;
  /** Fires the player may make per step; default 1. */
  actionsPerStep?: number;
  /** Flag when the player beats every intended strategy by this fraction; default 0.2. */
  minMargin?: number;
  parameters?: Record<string, number>;
  overrides?: Record<string, number>;
}

export const OPTIMIZER_DEFAULTS = {
  horizon: 10,
  rollouts: 4,
  actionsPerStep: 1,
  minMargin: 0.2,
} as const;

export interface OptimizerReport {
  objective: Objective;
  /** The mean of the objective's measure over the player's games. */
  score: number;
  p5: number;
  p50: number;
  p95: number;
  /** Fires per node over all games, most first. */
  fires: { node: string; count: number; perStep: number }[];
  /** A rule strategy built from the fires, to save into the model and replay. */
  strategy: Strategy | null;
  /** That strategy's own score, evaluated like any candidate. */
  strategyScore: number | null;
  /** Every intended model strategy's score. */
  intended: { id: string; score: number }[];
  /** The first game, for replay in the web app (its fires are `firedByHand`). */
  trace: Trace;
}

export type OptimizerResult =
  { ok: true; result: SearchResult<OptimizerReport> } | { ok: false; errors: SimError[] };

export function optimizePlayer(model: Model, options: OptimizerOptions): OptimizerResult {
  const resolved = resolveObjective(model, options.objective);
  if (!resolved.ok) return resolved;
  const objective = resolved.resolved.objective;
  const { horizon, rollouts, actionsPerStep, minMargin } = { ...OPTIMIZER_DEFAULTS, ...options };
  const runs = options.runs ?? DEFAULT_RUNS;
  const { steps, seed } = options;
  const maxEvaluations = options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS;
  for (const [key, value] of Object.entries({ horizon, rollouts, actionsPerStep })) {
    if (!(Number.isInteger(value) && value >= 1)) {
      return {
        ok: false,
        errors: [
          { path: `options.${key}`, message: `${key} must be a whole number of at least 1` },
        ],
      };
    }
  }

  const valid = validateModel(model);
  if (!valid.ok) return { ok: false, errors: valid.errors };
  const prepared = prepareModel(valid.model, {
    seed,
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  });
  if (!prepared.ok) return prepared;
  const created = createEngine(prepared.model);
  if (!created.ok) return created;
  const engine = created.engine;
  const parameters: Record<string, number> = {};
  for (const p of prepared.model.parameters ?? []) parameters[p.id] = p.value;

  const actions = prepared.model.nodes
    .filter((n) => "activation" in n && n.activation === "interactive")
    .map((n) => n.id)
    .sort();
  const intended = (model.strategies ?? []).filter((s) => s.intended);

  // The cost, in equivalent evaluations of runs × steps engine steps: each
  // step of each game plays every action and doing nothing, over every
  // rollout, for `horizon` steps, once per fire chosen. Then one evaluation
  // per intended strategy and one for the derived strategy.
  const rolloutCost = (actions.length + 1) * rollouts * horizon * actionsPerStep;
  const needed = 1 + rolloutCost + intended.length + 1;
  if (needed > maxEvaluations) {
    return {
      ok: false,
      errors: [
        {
          path: "options.maxEvaluations",
          message: `the optimiser needs ${needed} evaluations with these options; raise maxEvaluations or lower rollouts or horizon`,
        },
      ],
    };
  }

  const fires = new Map<string, number>(actions.map((id) => [id, 0]));
  const measures: number[] = [];
  let first: Trace | null = null;
  for (let game = 0; game < runs; game++) {
    const gameSeed = deriveSeed(seed, game);
    const run = createRun(prepared.model, { seed: gameSeed, steps });
    if (!run.ok) return run;
    while (!run.run.trace.end) {
      const chosen = choose(engine, run.run.state, actions, actionsPerStep, {
        resolved: resolved.resolved,
        horizon,
        rollouts,
        seed: deriveSeed(gameSeed, run.run.state.step + 1),
        parameters,
      });
      for (const id of chosen) {
        run.run.fire(id);
        fires.set(id, fires.get(id)! + 1);
      }
      if (run.run.step() === null) break;
    }
    measures.push(measureTrace(run.run.trace, resolved.resolved, steps, parameters));
    first ??= run.run.trace;
  }
  const { mean, p5, p50, p95 } = spread(measures);
  let used = 1 + rolloutCost;

  const fired = [...fires.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const totalSteps = runs * steps;
  const strategy: Strategy | null =
    fired.length > 0
      ? {
          id: "optimizer",
          description: `What the optimiser player fired on ${objective.id}, most often first.`,
          actionsPerStep,
          rules: fired.map(([fire]) => ({ fire })),
        }
      : null;
  const evaluate = (candidate: Strategy | string): number | SimError[] => {
    used++;
    const result = evaluateCandidate(
      model,
      {
        strategy: candidate,
        ...(options.parameters ? { parameters: options.parameters } : {}),
        ...(options.overrides ? { overrides: options.overrides } : {}),
      },
      { objective, seed, steps, runs },
    );
    return result.ok ? result.evaluation.score : result.errors;
  };
  let strategyScore: number | null = null;
  if (strategy) {
    const scored = evaluate(strategy);
    if (typeof scored !== "number") return { ok: false, errors: scored };
    strategyScore = scored;
  }
  const intendedScores: { id: string; score: number }[] = [];
  for (const s of intended) {
    const scored = evaluate(s.id);
    if (typeof scored !== "number") return { ok: false, errors: scored };
    intendedScores.push({ id: s.id, score: scored });
  }

  const findings: Finding[] = [];
  const bestIntended = intendedScores.sort(
    (a, b) => oriented(b.score, objective) - oriented(a.score, objective),
  )[0];
  if (bestIntended) {
    const lead = oriented(mean, objective) - oriented(bestIntended.score, objective);
    if (lead > 0 && lead >= minMargin * Math.abs(bestIntended.score)) {
      const top = fired.slice(0, 3).map(([id]) => id);
      findings.push({
        id: "search-unintended-optimum:optimizer",
        check: "search-unintended-optimum",
        severity: "warning",
        title: `A greedy player beats every intended strategy`,
        detail:
          `Choosing fires by lookahead scores ${round(mean)} on ${objective.id}, ahead of the best intended ` +
          `strategy (${bestIntended.id}, ${round(bestIntended.score)}). ` +
          (top.length > 0 ? `It mostly fires ${top.join(", ")}.` : "It fires nothing."),
        nodes: top,
        edges: [],
        data: {
          objective: objective.id,
          score: mean,
          intended: intendedScores,
          strategy,
          seed,
        },
      });
    }
  }

  return {
    ok: true,
    result: {
      findings,
      report: {
        objective,
        score: mean,
        p5,
        p50,
        p95,
        fires: fired.map(([node, count]) => ({ node, count, perStep: count / totalSteps })),
        strategy,
        strategyScore,
        intended: intendedScores,
        trace: first!,
      },
      evaluationsUsed: used,
    },
  };
}

interface Lookahead {
  resolved: ResolvedObjective;
  horizon: number;
  rollouts: number;
  /** Seeds every rollout of this step, so a choice is reproducible. */
  seed: number;
  parameters: Record<string, number>;
}

/**
 * Pick up to `count` fires for the next step, one at a time: each round tries
 * every remaining action and doing nothing, and stops when doing nothing is
 * best. Ties go to doing nothing, then to the lowest id.
 */
function choose(
  engine: Engine,
  state: SimState,
  actions: string[],
  count: number,
  look: Lookahead,
): string[] {
  const chosen: string[] = [];
  for (let round = 0; round < count; round++) {
    const value = (fire: string[]): number => {
      let total = 0;
      for (let r = 0; r < look.rollouts; r++) {
        total += rollout(engine, state, fire, deriveSeed(look.seed, r), look);
      }
      return oriented(total / look.rollouts, look.resolved.objective);
    };
    let best = value(chosen);
    let pick: string | null = null;
    for (const id of actions) {
      if (chosen.includes(id)) continue;
      const v = value([...chosen, id]);
      if (v > best) {
        best = v;
        pick = id;
      }
    }
    if (pick === null) break;
    chosen.push(pick);
  }
  return chosen;
}

/** Play `fire` now, then `horizon - 1` steps of doing nothing; score the result. */
function rollout(
  engine: Engine,
  start: SimState,
  fire: string[],
  seed: number,
  look: Lookahead,
): number {
  const rng = createRng(seed);
  const steps: StepRecord[] = [];
  let state = start;
  let end: Trace["end"];
  for (let i = 0; i < look.horizon; i++) {
    let next: { state: SimState; record: StepRecord };
    try {
      next = engine.step(state, rng, i === 0 && fire.length > 0 ? { fire } : {});
    } catch {
      // A formula that fails ahead ends the rollout where it is.
      break;
    }
    state = next.state;
    steps.push(next.record);
    if (next.record.ended.length > 0) {
      end = { reason: "endCondition", step: i + 1, conditions: next.record.ended };
      break;
    }
  }
  const trace: Trace = {
    seed,
    initial: { amounts: start.amounts, registers: start.registers },
    steps,
    invariantViolations: [],
    ...(end ? { end } : {}),
  };
  return measureTrace(trace, look.resolved, look.horizon, look.parameters);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
