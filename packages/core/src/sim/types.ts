/**
 * Simulation state and trace types (docs/simulation-semantics.md, "State" and
 * "Trace").
 *
 * Everything here is plain JSON data: the MCP tool returns it, the web charts
 * plot it and the simulation-based checks read it. Records are keyed by node
 * or edge id, with keys inserted in id order so serialisations are stable.
 */

import type { Strategy } from "../model/types.js";

/** Resources on their way to a node: on a delayed edge, or a converter's output. */
export interface Transit {
  /** The delayed edge or the converter they came from. */
  via: string;
  /** The node they will arrive at. */
  to: string;
  arrivesAtStep: number;
  amount: number;
}

/**
 * When an interactive node fires: never (the default), every step, with a
 * probability drawn each step, or on the listed steps.
 */
export type InteractiveSchedule = "never" | "always" | number | number[];

/** Options fixed for a whole run. */
export interface EngineOptions {
  /** Schedules for interactive nodes, by node id. */
  interactive?: Record<string, InteractiveSchedule>;
  /** A player policy that picks interactive fires each step (docs/search-design.md). */
  strategy?: Strategy;
}

/** What a person does during one step. */
export interface StepInput {
  /** Interactive nodes fired by hand in this step. */
  fire?: string[];
}

/** The full state of a run between steps. */
export interface SimState {
  /** Number of completed steps; 0 is the initial state. */
  step: number;
  /** Amount in every pool (non-negative integers). */
  amounts: Record<string, number>;
  /** Value of every register, as computed for the latest step. */
  registers: Record<string, number>;
  /** Fractional remainder of every flow edge's rate. */
  carry: Record<string, number>;
  inTransit: Transit[];
  /** Nodes a trigger activates in the next step. */
  triggered: string[];
  /** Deterministic-gate counters. */
  gateCursor: Record<string, number[]>;
  /** Warning keys already reported, so each is reported once per run. */
  warned: string[];
}

export interface SimWarning {
  code: "negative-rate" | "invalid-rate" | "negative-multiplier" | "invalid-multiplier";
  message: string;
  edge?: string;
  node?: string;
}

/** What happened in one step. */
export interface StepRecord {
  /** The step number (1 for the first step). */
  step: number;
  /** Pool amounts after the step. */
  amounts: Record<string, number>;
  /** Register values the step used (computed at its start). */
  registers: Record<string, number>;
  /** Whole resources each driven flow edge asked for this step. */
  wanted: Record<string, number>;
  /** Resources taken from each driven flow edge's source. */
  moved: Record<string, number>;
  /** Resources each driven flow edge delivered (after multiplier and capacity). */
  arrived: Record<string, number>;
  /** Nodes and converters whose all-mode activation failed, in id order. */
  failed: string[];
  /** How many times each active converter activated. */
  activations: Record<string, number>;
  /** Resources delivered to each pool in phase 1 (delays and converter outputs). */
  arrivals: Record<string, number>;
  /** Resources lost to a full pool (or a source, which has no room), by node. */
  capacityLoss: Record<string, number>;
  /** Interactive nodes that fired this step, by schedule or by hand. */
  fired: string[];
  /** Interactive nodes fired by hand this step (replay them with `StepInput.fire`). */
  firedByHand: string[];
  /** Interactive nodes the run's strategy fired this step, in rule order. */
  firedByStrategy: string[];
  /** Net change node modifiers made to each pool in phase 6. */
  modified: Record<string, number>;
  /** Nodes triggered to act in the next step. */
  triggered: string[];
  /** Resources a gate could not route, by gate. */
  gateLoss: Record<string, number>;
  /** Total resources on delayed edges after the step. */
  inTransit: number;
  /** Ids of invariants whose expr is false after the step. */
  invariantViolations: string[];
  /** Ids of end conditions that hold after the step; any one ends the run. */
  ended: string[];
  warnings: SimWarning[];
}

/** A problem that stops a model from being simulated at all. */
export interface SimError {
  path: string;
  message: string;
}

/** Why a run stopped. */
export type RunEnd =
  | { reason: "steps"; step: number }
  | { reason: "endCondition"; step: number; conditions: string[] }
  | { reason: "error"; step: number; message: string };

/** A whole run (docs/simulation-semantics.md, "Trace"). */
export interface Trace {
  seed: number;
  /** Pool amounts and register values before the first step. */
  initial: { amounts: Record<string, number>; registers: Record<string, number> };
  steps: StepRecord[];
  /** Every invariant violation, in step order. */
  invariantViolations: { invariant: string; step: number }[];
  /** Unset while a stepped run is still going. */
  end?: RunEnd;
}
