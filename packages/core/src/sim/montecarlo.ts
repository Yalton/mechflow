/**
 * Monte Carlo batches (docs/simulation-semantics.md, "Randomness"): run i of a
 * batch is a plain `simulate` run seeded with `deriveSeed(seed, i)`, so any run
 * can be replayed alone. Synchronous and pure; spreading a batch over workers
 * is the caller's concern.
 */

import type { Model } from "../model/types.js";
import { deriveSeed } from "./rng.js";
import { simulate, type RunOptions } from "./run.js";
import type { RunEnd, SimError, Trace } from "./types.js";

/** The most runs one batch may take. */
export const MAX_RUNS = 10_000;

export interface MonteCarloOptions
  extends Pick<RunOptions, "interactive" | "strategy" | "parameters" | "overrides"> {
  seed: number;
  runs: number;
  steps: number;
  /** Also return every run's full trace (for the batch checks). */
  keepTraces?: boolean;
}

/** Spread of one value across the runs of a batch. */
export interface Spread {
  mean: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface MonteCarloRun {
  index: number;
  /** Pass this to `simulate` to replay the run. */
  seed: number;
  stepsRun: number;
  end: RunEnd;
}

export interface MonteCarloResult {
  seed: number;
  steps: number;
  runs: MonteCarloRun[];
  /** Per pool, the spread at step 0 (initial) through `steps`. */
  pools: Record<string, Spread[]>;
  /** Per register, the spread at step 0 through `steps`. */
  registers: Record<string, Spread[]>;
  /** Per pool, each run's final amount (sorted) and their spread. */
  finals: Record<string, Spread & { min: number; max: number; values: number[] }>;
  traces?: Trace[];
}

export type MonteCarloResultOrErrors =
  { ok: true; result: MonteCarloResult } | { ok: false; errors: SimError[] };

export function monteCarlo(model: Model, options: MonteCarloOptions): MonteCarloResultOrErrors {
  const { seed, runs, steps } = options;
  if (!(Number.isInteger(runs) && runs >= 1 && runs <= MAX_RUNS)) {
    return {
      ok: false,
      errors: [
        { path: "options.runs", message: `runs must be a whole number from 1 to ${MAX_RUNS}` },
      ],
    };
  }
  if (!Number.isSafeInteger(seed)) {
    return {
      ok: false,
      errors: [{ path: "options.seed", message: "seed must be a whole number" }],
    };
  }

  const traces: Trace[] = [];
  for (let i = 0; i < runs; i++) {
    const result = simulate(model, {
      seed: deriveSeed(seed, i),
      steps,
      ...(options.interactive ? { interactive: options.interactive } : {}),
      ...(options.strategy ? { strategy: options.strategy } : {}),
      ...(options.parameters ? { parameters: options.parameters } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    });
    // Model and option problems are the same for every run.
    if (!result.ok) return { ok: false, errors: result.errors };
    traces.push(result.trace);
  }

  const first = traces[0]!;
  const series = (
    ids: string[],
    at: (trace: Trace, step: number) => Record<string, number>,
  ): Record<string, Spread[]> =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        Array.from({ length: steps + 1 }, (_, step) =>
          spread(traces.map((trace) => at(trace, step)[id]!)),
        ),
      ]),
    );
  const result: MonteCarloResult = {
    seed,
    steps,
    runs: traces.map((trace, index) => ({
      index,
      seed: trace.seed,
      stepsRun: trace.steps.length,
      end: trace.end!,
    })),
    pools: series(Object.keys(first.initial.amounts), (t, s) => valuesAt(t, s).amounts),
    registers: series(Object.keys(first.initial.registers), (t, s) => valuesAt(t, s).registers),
    finals: Object.fromEntries(
      Object.keys(first.initial.amounts).map((id) => {
        const values = traces
          .map((t) => valuesAt(t, t.steps.length).amounts[id]!)
          .sort((a, b) => a - b);
        return [id, { ...spread(values), min: values[0]!, max: values.at(-1)!, values }];
      }),
    ),
  };
  if (options.keepTraces) result.traces = traces;
  return { ok: true, result };
}

/**
 * A run's pools and registers after `step`. A run that ended early keeps its
 * last values for the remaining steps, so every step has one value per run.
 */
export function valuesAt(
  trace: Trace,
  step: number,
): { amounts: Record<string, number>; registers: Record<string, number> } {
  if (step === 0 || trace.steps.length === 0) return trace.initial;
  return trace.steps[Math.min(step, trace.steps.length) - 1]!;
}

/** Mean and quantiles, interpolating linearly between order statistics. */
export function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number): number => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  };
  return {
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    p5: quantile(0.05),
    p25: quantile(0.25),
    p50: quantile(0.5),
    p75: quantile(0.75),
    p95: quantile(0.95),
  };
}
