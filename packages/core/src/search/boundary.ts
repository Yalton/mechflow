/**
 * Boundary sweep (docs/search-design.md, "Boundary sweep (search-boundary)"):
 * run the model at the edges of its knobs, with every interactive node fired
 * every step by default, and report problems that appear at a boundary but not
 * at the defaults.
 */

import type { Finding, Severity } from "../analysis/types.js";
import type { Model, Strategy } from "../model/types.js";
import { simulationChecks } from "../sim/checks/index.js";
import type { SimError } from "../sim/types.js";
import { Budget } from "./budget.js";
import { evaluateCandidate } from "./evaluate.js";
import {
  DEFAULT_MAX_EVALUATIONS,
  type Candidate,
  type SearchOptions,
  type SearchResult,
} from "./types.js";

/** A field override knob: `path` as in the run option `overrides`. */
export interface FieldKnob {
  path: string;
  min: number;
  max: number;
}

export interface BoundaryOptions extends SearchOptions {
  /** The strategy to run; default the stack-everything strategy. */
  strategy?: string | Strategy;
  /** Field overrides to sweep alongside the model's parameters. */
  fields?: FieldKnob[];
  /** A pool explodes past this; default 1e9. */
  explodeAt?: number;
  /** Or past this many times its largest default final; default 10. */
  explodeFactor?: number;
}

/** Pairs of knobs are tried at (max, max) only up to this many knobs. */
export const MAX_PAIR_KNOBS = 8;

/** One setting the sweep tried. */
export interface BoundarySetting {
  /** For example "defaults", "max(pay)", "max(pay, cost)", "all max". */
  label: string;
  parameters: Record<string, number>;
  overrides: Record<string, number>;
  score: number;
  p5: number;
  p50: number;
  p95: number;
  /** Problem keys seen at this setting (finding ids, `invariant:<id>`, `explosion:<pool>`). */
  problems: string[];
}

export interface BoundaryReport {
  strategy: string | Strategy | null;
  knobs: { id: string; kind: "parameter" | "field"; min: number; max: number }[];
  settings: BoundarySetting[];
  /** Settings the budget did not allow, by label. */
  skipped: string[];
}

export type BoundaryResult =
  { ok: true; result: SearchResult<BoundaryReport> } | { ok: false; errors: SimError[] };

/**
 * The strategy that fires every interactive node every step it can: "every
 * modifier stacked". Null when the model has no interactive nodes.
 */
export function stackEverything(model: Model): Strategy | null {
  const ids = model.nodes
    .filter((n) => "activation" in n && n.activation === "interactive")
    .map((n) => n.id)
    .sort();
  if (ids.length === 0) return null;
  return {
    id: "stack-everything",
    description: "Fire every interactive node every step it can.",
    actionsPerStep: ids.length,
    rules: ids.map((fire) => ({ fire })),
  };
}

export interface Knob {
  id: string;
  kind: "parameter" | "field";
  min: number;
  max: number;
}

export interface Setting {
  label: string;
  candidate: { parameters: Record<string, number>; overrides: Record<string, number> };
}

/** The model's parameters and the given field overrides, as knobs. */
export function knobsOf(model: Model, fields: readonly FieldKnob[] = []): Knob[] {
  return [
    ...(model.parameters ?? []).map((p) => ({
      id: p.id,
      kind: "parameter" as const,
      min: p.min,
      max: p.max,
    })),
    ...fields.map((f) => ({ id: f.path, kind: "field" as const, min: f.min, max: f.max })),
  ];
}

/**
 * The settings to try, defaults first, without duplicates. With `singles`,
 * only the defaults and each knob alone at its min and max.
 */
export function settingsFor(knobs: Knob[], singles = false): Setting[] {
  const settings: Setting[] = [];
  const seen = new Set<string>();
  const add = (label: string, values: [Knob, number][]): void => {
    const candidate = {
      parameters: {} as Record<string, number>,
      overrides: {} as Record<string, number>,
    };
    for (const [knob, value] of values) {
      (knob.kind === "parameter" ? candidate.parameters : candidate.overrides)[knob.id] = value;
    }
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    settings.push({ label, candidate });
  };
  add("defaults", []);
  for (const knob of knobs) {
    add(`min(${knob.id})`, [[knob, knob.min]]);
    add(`max(${knob.id})`, [[knob, knob.max]]);
  }
  if (singles) return settings;
  if (knobs.length > 1) {
    add(
      "all max",
      knobs.map((k) => [k, k.max]),
    );
    add(
      "all min",
      knobs.map((k) => [k, k.min]),
    );
  }
  if (knobs.length <= MAX_PAIR_KNOBS) {
    for (let i = 0; i < knobs.length; i++) {
      for (let j = i + 1; j < knobs.length; j++) {
        add(`max(${knobs[i]!.id}, ${knobs[j]!.id})`, [
          [knobs[i]!, knobs[i]!.max],
          [knobs[j]!, knobs[j]!.max],
        ]);
      }
    }
  }
  return settings;
}

interface Problem {
  key: string;
  severity: Severity;
  title: string;
  nodes: string[];
  edges: string[];
}

export function boundarySweep(model: Model, options: BoundaryOptions): BoundaryResult {
  const knobs = knobsOf(model, options.fields);
  const strategy = options.strategy ?? stackEverything(model);
  const budget = new Budget(options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS);
  const explodeAt = options.explodeAt ?? 1e9;
  const explodeFactor = options.explodeFactor ?? 10;

  const settings: BoundarySetting[] = [];
  const skipped: string[] = [];
  const problemsAt = new Map<string, Map<string, Problem>>();
  let defaultFinals: Record<string, number> = {};
  for (const setting of settingsFor(knobs)) {
    if (!budget.take()) {
      skipped.push(setting.label);
      continue;
    }
    const candidate: Candidate = { ...setting.candidate, ...(strategy ? { strategy } : {}) };
    const result = evaluateCandidate(model, candidate, options);
    if (!result.ok) return result;
    const { batch, score, p5, p50, p95 } = result.evaluation;

    const problems = new Map<string, Problem>();
    for (const trace of batch.traces!) {
      for (const finding of simulationChecks(trace, model)) {
        problems.set(finding.id, {
          key: finding.id,
          severity: finding.severity,
          title: finding.title,
          nodes: finding.nodes,
          edges: finding.edges,
        });
      }
      for (const { invariant } of trace.invariantViolations) {
        problems.set(`invariant:${invariant}`, {
          key: `invariant:${invariant}`,
          severity: "error",
          title: `invariant ${invariant} is violated`,
          nodes: [],
          edges: [],
        });
      }
    }
    const finals = Object.fromEntries(
      Object.entries(batch.finals).map(([pool, spread]) => [pool, spread.max]),
    );
    if (setting.label === "defaults") defaultFinals = finals;
    for (const [pool, final] of Object.entries(finals)) {
      const reference = Math.max(defaultFinals[pool] ?? 0, 1);
      const explodes =
        !Number.isFinite(final) ||
        final > explodeAt ||
        (setting.label !== "defaults" && final > explodeFactor * reference);
      if (explodes) {
        problems.set(`explosion:${pool}`, {
          key: `explosion:${pool}`,
          severity: "warning",
          title: `${pool} explodes`,
          nodes: [pool],
          edges: [],
        });
      }
    }
    problemsAt.set(setting.label, problems);
    settings.push({
      label: setting.label,
      ...setting.candidate,
      score,
      p5,
      p50,
      p95,
      problems: [...problems.keys()].sort(),
    });
  }

  // A problem counts when it shows up at some boundary but not at the defaults.
  const atDefaults = problemsAt.get("defaults") ?? new Map<string, Problem>();
  const boundaryProblems = new Map<string, { problem: Problem; settings: BoundarySetting[] }>();
  for (const setting of settings) {
    if (setting.label === "defaults") continue;
    for (const key of setting.problems) {
      if (atDefaults.has(key)) continue;
      const entry = boundaryProblems.get(key) ?? {
        problem: problemsAt.get(setting.label)!.get(key)!,
        settings: [],
      };
      entry.settings.push(setting);
      boundaryProblems.set(key, entry);
    }
  }
  const findings: Finding[] = [...boundaryProblems.values()].map(
    ({ problem, settings: where }) => ({
      id: `search-boundary:${problem.key}`,
      check: "search-boundary",
      severity: problem.severity,
      title: `At the boundaries: ${problem.title}`,
      detail:
        `${problem.title} at ${where.map((s) => s.label).join("; ")}, but not at the default values. ` +
        `Replay a setting with simulate, passing its parameters and overrides.`,
      nodes: problem.nodes,
      edges: problem.edges,
      data: {
        problem: problem.key,
        settings: where.map((s) => ({
          label: s.label,
          parameters: s.parameters,
          overrides: s.overrides,
        })),
        seed: options.seed,
      },
    }),
  );
  findings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    ok: true,
    result: {
      findings,
      report: { strategy: strategy ?? null, knobs, settings, skipped },
      evaluationsUsed: budget.used,
    },
  };
}
