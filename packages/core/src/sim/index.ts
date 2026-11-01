export { simulate, createRun, MAX_STEPS, OVERRIDE_PATH } from "./run.js";
export type { RunOptions, Run, SimulateResult, CreateRunResult } from "./run.js";
export { monteCarlo, MAX_RUNS } from "./montecarlo.js";
export type {
  MonteCarloOptions,
  MonteCarloResult,
  MonteCarloResultOrErrors,
  MonteCarloRun,
  Spread,
} from "./montecarlo.js";
export { createEngine } from "./engine.js";
export type { Engine, CreateEngineResult } from "./engine.js";
export { createRng, deriveSeed } from "./rng.js";
export type { Rng } from "./rng.js";
export type * from "./types.js";
export {
  simulationChecks,
  inflationCheck,
  starvationCheck,
  snowballingCheck,
  cascadingFailureCheck,
  TRACE_CHECK_DEFAULTS,
  batchChecks,
  varianceCheck,
  streaksCheck,
  BATCH_CHECK_DEFAULTS,
} from "./checks/index.js";
export type { TraceCheckOptions, BatchCheckOptions } from "./checks/index.js";
