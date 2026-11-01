/**
 * Simulation-based checks over one trace (docs/simulation-semantics.md,
 * "Simulation-based checks"). Each returns standard findings with stable ids
 * so they can sit next to the static analysis findings.
 */

import type { Finding } from "../../analysis/types.js";
import type { Model } from "../../model/types.js";
import type { Trace } from "../types.js";
import { cascadingFailureCheck } from "./cascading-failure.js";
import { inflationCheck } from "./inflation.js";
import type { TraceCheckOptions } from "./shared.js";
import { snowballingCheck } from "./snowballing.js";
import { starvationCheck } from "./starvation.js";
import type { MonteCarloResult } from "../montecarlo.js";
import type { BatchCheckOptions } from "./batch.js";
import { streaksCheck } from "./streaks.js";
import { varianceCheck } from "./variance.js";

export {
  cascadingFailureCheck,
  inflationCheck,
  snowballingCheck,
  starvationCheck,
  streaksCheck,
  varianceCheck,
};
export { BATCH_DEFAULTS as BATCH_CHECK_DEFAULTS, type BatchCheckOptions } from "./batch.js";
export { DEFAULTS as TRACE_CHECK_DEFAULTS, type TraceCheckOptions } from "./shared.js";

/** Run every single-trace check; findings are sorted by id. */
export function simulationChecks(
  trace: Trace,
  model: Model,
  options: TraceCheckOptions = {},
): Finding[] {
  return [
    ...inflationCheck(trace, model, options),
    ...starvationCheck(trace, model, options),
    ...snowballingCheck(trace, model, options),
    ...cascadingFailureCheck(trace, model, options),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Run every batch check over a Monte Carlo result, which must keep its traces
 * (`keepTraces: true`); findings are sorted by id.
 */
export function batchChecks(
  result: MonteCarloResult,
  model: Model,
  options: BatchCheckOptions = {},
): Finding[] {
  return [...varianceCheck(result, options), ...streaksCheck(result, model, options)].sort(
    (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
