/**
 * The run API over the step engine: `simulate` runs a model to its end and
 * returns the trace; `createRun` steps one at a time for the web controls.
 * Bad models and options come back as errors, never as exceptions.
 */

import { validateModel } from "../model/schema.js";
import type { Model, Strategy } from "../model/types.js";
import { createEngine, type Engine } from "./engine.js";
import { createRng, type Rng } from "./rng.js";
import type {
  InteractiveSchedule,
  SimError,
  SimState,
  StepInput,
  StepRecord,
  Trace,
} from "./types.js";

/** The most steps one run may take. */
export const MAX_STEPS = 100_000;

export interface RunOptions {
  /** Required: every run is seeded (see "Randomness"). */
  seed: number;
  /** Required by `simulate`; a stepped run without it never ends by count. */
  steps?: number;
  interactive?: Record<string, InteractiveSchedule>;
  /** A model strategy id, or an inline strategy. Not with `interactive`. */
  strategy?: string | Strategy;
  /** Parameter values for this run, by parameter id. */
  parameters?: Record<string, number>;
  /** Plain numeric fields for this run, by path (see {@link OVERRIDE_PATH}). */
  overrides?: Record<string, number>;
}

/** The fields a run may override: `nodes.<id>.start`, `.capacity` or `.rate`. */
export const OVERRIDE_PATH = /^nodes\.(.+)\.(start|capacity|rate)$/;

export type SimulateResult = { ok: true; trace: Trace } | { ok: false; errors: SimError[] };

export interface Run {
  /** The state after the latest step. */
  readonly state: SimState;
  /** Everything so far; `end` is set once the run is over. */
  readonly trace: Trace;
  /**
   * Take one step, including any nodes fired since the last one. Returns the
   * step's record, or null once the run has ended.
   */
  step(): StepRecord | null;
  /** Fire an interactive node by hand in the next step. */
  fire(nodeId: string): SimError | null;
}

export type CreateRunResult = { ok: true; run: Run } | { ok: false; errors: SimError[] };

/** Run `model` until `options.steps` steps or an end condition. */
export function simulate(model: Model, options: RunOptions): SimulateResult {
  const errors: SimError[] = [];
  if (options.steps === undefined) {
    errors.push({ path: "options.steps", message: "steps is required" });
  }
  const created = createRun(model, options);
  if (!created.ok) errors.push(...created.errors);
  if (errors.length > 0 || !created.ok) return { ok: false, errors };
  while (created.run.step() !== null);
  return { ok: true, trace: created.run.trace };
}

/** Prepare a run that advances one step per `step()` call. */
export function createRun(model: Model, options: RunOptions): CreateRunResult {
  const errors = checkOptions(options);
  const valid = validateModel(model);
  if (!valid.ok) {
    errors.push(...valid.errors.map(({ path, message }) => ({ path, message })));
    return { ok: false, errors };
  }
  const prepared = prepareModel(valid.model, options);
  if (!prepared.ok) return { ok: false, errors: [...errors, ...prepared.errors] };
  const created = createEngine(prepared.model, {
    ...(options.interactive ? { interactive: options.interactive } : {}),
    ...(prepared.strategy ? { strategy: prepared.strategy } : {}),
  });
  if (!created.ok) errors.push(...created.errors);
  if (errors.length > 0 || !created.ok) return { ok: false, errors };
  return { ok: true, run: new SteppedRun(valid.model, created.engine, options) };
}

/**
 * Apply a run's parameter values and field overrides to a copy of `model`, and
 * resolve its strategy. The model itself is never changed.
 */
export function prepareModel(
  model: Model,
  options: RunOptions,
): { ok: true; model: Model; strategy: Strategy | null } | { ok: false; errors: SimError[] } {
  const errors: SimError[] = [];
  let strategy: Strategy | null = null;
  if (options.strategy !== undefined) {
    if (options.interactive) {
      errors.push({
        path: "options.strategy",
        message: "a run takes interactive schedules or a strategy, not both",
      });
    }
    if (typeof options.strategy === "string") {
      const id = options.strategy;
      strategy = model.strategies?.find((s) => s.id === id) ?? null;
      if (!strategy) errors.push({ path: "options.strategy", message: `unknown strategy "${id}"` });
    } else {
      strategy = options.strategy;
    }
  }

  const parameters = (model.parameters ?? []).map((p) => ({ ...p }));
  for (const [id, value] of Object.entries(options.parameters ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const path = `options.parameters.${id}`;
    const parameter = parameters.find((p) => p.id === id);
    if (!parameter) {
      errors.push({ path, message: `unknown parameter "${id}"` });
    } else if (!Number.isFinite(value) || value < parameter.min || value > parameter.max) {
      errors.push({
        path,
        message: `${value} is outside the range of "${id}" [${parameter.min}, ${parameter.max}]`,
      });
    } else if (parameter.integer && !Number.isInteger(value)) {
      errors.push({ path, message: `"${id}" takes whole numbers only` });
    } else {
      parameter.value = value;
    }
  }

  const nodes = model.nodes.map((n) => ({ ...n }));
  for (const [key, value] of Object.entries(options.overrides ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const path = `options.overrides.${key}`;
    const match = OVERRIDE_PATH.exec(key);
    const node = match ? nodes.find((n) => n.id === match[1]) : undefined;
    const field = match?.[2];
    const fits =
      node &&
      (((field === "start" || field === "capacity") && node.kind === "pool") ||
        (field === "rate" && (node.kind === "source" || node.kind === "drain")));
    if (!match) {
      errors.push({ path, message: "override paths are nodes.<id>.start, .capacity or .rate" });
    } else if (!fits) {
      errors.push({ path, message: `node "${match[1]}" has no ${field} to override` });
    } else if (!Number.isFinite(value) || value < 0) {
      errors.push({ path, message: "an override must be a non-negative number" });
    } else {
      (node as unknown as Record<string, number>)[field!] = value;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    model: { ...model, nodes, ...(model.parameters ? { parameters } : {}) },
    strategy,
  };
}

function checkOptions(options: RunOptions): SimError[] {
  const errors: SimError[] = [];
  if (!Number.isSafeInteger(options.seed)) {
    errors.push({ path: "options.seed", message: "seed must be a whole number" });
  }
  const { steps } = options;
  if (steps !== undefined && !(Number.isInteger(steps) && steps >= 1 && steps <= MAX_STEPS)) {
    errors.push({
      path: "options.steps",
      message: `steps must be a whole number from 1 to ${MAX_STEPS}`,
    });
  }
  return errors;
}

class SteppedRun implements Run {
  private current: SimState;
  private readonly rng: Rng;
  private readonly interactiveIds: Set<string>;
  private pending = new Set<string>();
  readonly trace: Trace;

  constructor(
    model: Model,
    private readonly engine: Engine,
    private readonly options: RunOptions,
  ) {
    this.rng = createRng(options.seed);
    this.interactiveIds = new Set(
      model.nodes
        .filter((n) => "activation" in n && n.activation === "interactive")
        .map((n) => n.id),
    );
    this.current = engine.initialState(this.rng);
    this.trace = {
      seed: options.seed,
      initial: { amounts: this.current.amounts, registers: this.current.registers },
      steps: [],
      invariantViolations: [],
    };
  }

  get state(): SimState {
    return this.current;
  }

  fire(nodeId: string): SimError | null {
    if (!this.interactiveIds.has(nodeId)) {
      return { path: "fire", message: `cannot fire "${nodeId}": it is not an interactive node` };
    }
    this.pending.add(nodeId);
    return null;
  }

  step(): StepRecord | null {
    if (this.trace.end) return null;
    const step = this.current.step + 1;
    const input: StepInput = this.pending.size > 0 ? { fire: [...this.pending] } : {};
    this.pending = new Set();
    let record: StepRecord;
    try {
      const next = this.engine.step(this.current, this.rng, input);
      this.current = next.state;
      record = next.record;
    } catch (error) {
      // A formula that cannot be evaluated (say, a division the model allows
      // but the state makes impossible) ends the run with the reason.
      this.trace.end = { reason: "error", step, message: (error as Error).message };
      return null;
    }
    this.trace.steps.push(record);
    for (const invariant of record.invariantViolations) {
      this.trace.invariantViolations.push({ invariant, step });
    }
    if (record.ended.length > 0) {
      this.trace.end = { reason: "endCondition", step, conditions: record.ended };
    } else if (step === this.options.steps) {
      this.trace.end = { reason: "steps", step };
    }
    return record;
  }
}
