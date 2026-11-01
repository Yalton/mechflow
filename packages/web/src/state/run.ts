import { useMemo } from "react";
import { create } from "zustand";
import {
  batchChecks,
  createRun,
  simulationChecks,
  type Finding,
  monteCarlo,
  type Model,
  type MonteCarloResult,
  type Run,
  type RunEnd,
  type RunOptions,
  type StepRecord,
  type Strategy,
} from "@mechflow/core";

/** The largest "run N steps" request the controls accept in one go. */
export const MAX_BATCH = 10_000;

/** Runs × steps above this would freeze the page, so a batch refuses it. */
export const MAX_BATCH_WORK = 500_000;

/** Pools charted when nothing has been toggled: the first ones by id. */
export const DEFAULT_CHART_POOLS = 4;

/**
 * Simulation check findings for `model`: the single-trace checks over the
 * stepped run and the batch checks over the latest Monte Carlo batch. They
 * join the static analysis findings in the findings panel.
 */
export function useSimulationFindings(model: Model | null): Finding[] {
  const run = useRunStore((s) => (s.model === model ? s.run : null));
  const record = useRunStore((s) => s.record);
  const batch = useRunStore((s) => (s.model === model ? s.batch : null));
  return useMemo(() => {
    if (!model) return [];
    const findings: Finding[] = [];
    // `record` changes with every step, so the memo re-runs as the trace grows.
    if (run && record) findings.push(...simulationChecks(run.trace, model));
    if (batch) findings.push(...batchChecks(batch, model));
    return findings;
  }, [model, run, record, batch]);
}

export interface BatchOptions {
  seed: number;
  runs: number;
  steps: number;
}

/**
 * A simulation run in the browser (docs/simulation-semantics.md), driven by the
 * run controls. The run belongs to one model object: any edit produces a new
 * model object, and the next {@link RunState.sync} with it discards the run.
 * Runs are created lazily, on the first step.
 */
export interface RunState {
  seed: number;
  /** The model the current run was built from, or null when there is none. */
  model: Model | null;
  run: Run | null;
  /** The latest step's record; null before the first step. */
  record: StepRecord | null;
  /** Pool amounts to show: after the latest step, or the initial amounts. */
  amounts: Record<string, number> | null;
  end: RunEnd | null;
  /** Why a run could not start (the model cannot be simulated). */
  error: string | null;
  playing: boolean;
  /** The latest Monte Carlo batch for `model`, with the traces kept. */
  batch: MonteCarloResult | null;
  batchError: string | null;
  /** Pools the charts show; null means the default (the first few by id). */
  chartPools: string[] | null;
  /**
   * The strategy the stepped run plays, a model strategy id or a strategy a
   * search found; null plays by hand. It outlives edits, so an edited model
   * can be replayed with the same strategy.
   */
  strategy: Strategy | string | null;
  /**
   * Parameter values the runs use instead of the model's, by parameter id.
   * Like the seed they outlive edits; values for parameters the model no
   * longer has are dropped when a run starts.
   */
  parameters: Record<string, number>;
  /** Field overrides (`nodes.<id>.start` and so on) the runs use; see RunOptions. */
  overrides: Record<string, number>;

  setSeed: (seed: number) => void;
  /** Discard the run if it was built from another model. */
  sync: (model: Model | null) => void;
  /** Take `count` steps (default 1), stopping early if the run ends. */
  step: (model: Model, count?: number) => void;
  /** Fire an interactive node in the next step. */
  fire: (model: Model, nodeId: string) => void;
  setPlaying: (playing: boolean) => void;
  /** Discard the stepped run (not the batch); the next step starts from step 0. */
  reset: () => void;
  /** Run a Monte Carlo batch of `model` in the browser. */
  runBatch: (model: Model, options: BatchOptions) => void;
  /** Show or hide a pool's series in the charts. */
  togglePool: (pool: string, allPools: string[]) => void;
  /** Play `strategy` in the stepped run (null for none), starting it over. */
  loadStrategy: (strategy: Strategy | string | null) => void;
  /** Set one parameter's value (undefined for the model's), starting the run over. */
  setParameter: (id: string, value: number | undefined) => void;
  /** Drop every field override, starting the run over. */
  clearOverrides: () => void;
  /** Play a boundary setting: its strategy, parameter values and overrides together. */
  loadSetting: (setting: {
    strategy: Strategy | string | null;
    parameters: Record<string, number>;
    overrides: Record<string, number>;
  }) => void;
}

/** The run options for the current settings, keeping only `model`'s parameters. */
function settingsFor(
  model: Model,
  state: Pick<RunState, "strategy" | "parameters" | "overrides">,
): Pick<RunOptions, "strategy" | "parameters" | "overrides"> {
  const known = new Set((model.parameters ?? []).map((p) => p.id));
  const parameters = Object.fromEntries(
    Object.entries(state.parameters).filter(([id]) => known.has(id)),
  );
  return {
    ...(state.strategy !== null ? { strategy: state.strategy } : {}),
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    ...(Object.keys(state.overrides).length > 0 ? { overrides: state.overrides } : {}),
  };
}

/** A strategy's display name. */
export function strategyLabel(strategy: Strategy | string): string {
  return typeof strategy === "string" ? strategy : strategy.id;
}

/** The pools the charts show, given the toggled list and every pool id. */
export function chartedPools(chartPools: string[] | null, allPools: string[]): string[] {
  const sorted = [...allPools].sort();
  if (chartPools === null) return sorted.slice(0, DEFAULT_CHART_POOLS);
  return sorted.filter((id) => chartPools.includes(id));
}

const IDLE = {
  model: null,
  run: null,
  record: null,
  amounts: null,
  end: null,
  error: null,
  playing: false,
  batch: null,
  batchError: null,
} as const;

export const useRunStore = create<RunState>((set, get) => {
  /** The run for `model`, creating it if needed; null if it cannot start. */
  const ensure = (model: Model): Run | null => {
    const current = get();
    if (current.run && current.model === model) return current.run;
    const created = createRun(model, { seed: current.seed, ...settingsFor(model, current) });
    if (!created.ok) {
      set({
        ...IDLE,
        model,
        error: created.errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
      });
      return null;
    }
    // Keep playing: pressing Play before the first step starts the run.
    set({
      ...IDLE,
      model,
      run: created.run,
      amounts: created.run.trace.initial.amounts,
      playing: current.playing,
      batch: current.batch,
    });
    return created.run;
  };

  return {
    seed: 1,
    ...IDLE,
    chartPools: null,
    strategy: null,
    parameters: {},
    overrides: {},

    // The strategy, parameters and overrides apply to the stepped run and the
    // Monte Carlo batch alike, so changing them drops both.
    loadStrategy: (strategy) => {
      set({ ...IDLE, strategy });
    },

    setParameter: (id, value) => {
      const { parameters } = get();
      const next = { ...parameters };
      if (value === undefined) delete next[id];
      else next[id] = value;
      set({ ...IDLE, parameters: next });
    },

    clearOverrides: () => {
      set({ ...IDLE, overrides: {} });
    },

    loadSetting: ({ strategy, parameters, overrides }) => {
      set({
        ...IDLE,
        strategy,
        parameters: { ...parameters },
        overrides: { ...overrides },
      });
    },

    setSeed: (seed) => {
      set({ seed, ...IDLE });
    },

    sync: (model) => {
      if (get().model !== null && get().model !== model) set({ ...IDLE });
    },

    runBatch: (model, options) => {
      const { seed, runs, steps } = options;
      if (runs * steps > MAX_BATCH_WORK) {
        set({
          batch: null,
          batchError: `${runs} runs of ${steps} steps is too much to run in the browser; keep runs × steps at or below ${MAX_BATCH_WORK}`,
        });
        return;
      }
      // A batch belongs to the model like a run does: start from a clean run.
      if (get().model !== model) set({ ...IDLE, model });
      const result = monteCarlo(model, {
        seed,
        runs,
        steps,
        keepTraces: true,
        ...settingsFor(model, get()),
      });
      if (!result.ok) {
        set({
          batch: null,
          batchError: result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
        });
        return;
      }
      set({ batch: result.result, batchError: null });
    },

    togglePool: (pool, allPools) => {
      const shown = chartedPools(get().chartPools, allPools);
      set({
        chartPools: shown.includes(pool) ? shown.filter((id) => id !== pool) : [...shown, pool],
      });
    },

    step: (model, count = 1) => {
      const run = ensure(model);
      if (!run) return;
      let record: StepRecord | null = get().record;
      for (let i = 0; i < Math.min(count, MAX_BATCH); i++) {
        const next = run.step();
        if (!next) break;
        record = next;
      }
      const end = run.trace.end ?? null;
      set({
        record,
        amounts: record?.amounts ?? run.trace.initial.amounts,
        end,
        playing: end ? false : get().playing,
      });
    },

    fire: (model, nodeId) => {
      const run = ensure(model);
      if (!run) return;
      const problem = run.fire(nodeId);
      if (problem) set({ error: problem.message });
      else get().step(model);
    },

    setPlaying: (playing) => {
      set({ playing: playing && !get().end && !get().error });
    },

    reset: () => {
      // The Monte Carlo batch is separate from the stepped run and survives.
      const { batch, model } = get();
      set({ ...IDLE, batch, model: batch ? model : null });
    },
  };
});
