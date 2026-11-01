import { describe, expect, it } from "vitest";
import type { Model } from "../../src/model/types.js";
import { Budget } from "../../src/search/budget.js";
import { evaluateCandidate, oriented, type EvaluateOptions } from "../../src/search/evaluate.js";
import { monteCarlo } from "../../src/sim/montecarlo.js";

/** Gold grows by `pay` a step, plus a d6 when the interactive `luck` fires. */
function model(): Model {
  return {
    version: 1,
    name: "Eval",
    properties: [],
    subsystems: [],
    nodes: [
      { id: "mine", kind: "source", name: "Mine", rate: 1 },
      { id: "gold", kind: "pool", name: "Gold", start: 0, activation: "passive" },
      { id: "luck", kind: "source", name: "Luck", rate: 1, activation: "interactive" },
    ],
    edges: [
      { id: "dig", kind: "flow", from: "mine", to: "gold", rate: "pay" },
      { id: "roll", kind: "flow", from: "luck", to: "gold", rate: "dice(1, 6)" },
    ],
    noInteraction: [],
    invariants: [],
    endConditions: [{ id: "rich", description: "Gold reaches 20", expr: "gold >= 20" }],
    parameters: [{ id: "pay", description: "Gold per step.", value: 2, min: 0, max: 5 }],
    objectives: [
      {
        id: "wealth",
        description: "Gold at the end.",
        expr: "gold",
        measure: "final",
        sense: "max",
      },
      { id: "average", description: "Mean gold.", expr: "gold", measure: "mean", sense: "max" },
      { id: "fast", description: "Win quickly.", expr: "0", measure: "endStep", sense: "min" },
    ],
    strategies: [{ id: "lucky", description: "Always roll.", rules: [{ fire: "luck" }] }],
  };
}

const base: Omit<EvaluateOptions, "objective"> = { seed: 7, steps: 5, runs: 10 };

function score(objective: EvaluateOptions["objective"], candidate = {}): number[] {
  const result = evaluateCandidate(model(), candidate, { ...base, objective });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.evaluation.perRun;
}

describe("evaluateCandidate", () => {
  it("scores the final value, the mean over steps, and the end step", () => {
    // pay 2: gold is 2, 4, 6, 8, 10 in every run.
    expect(score("wealth")).toEqual(Array(10).fill(10));
    expect(score("average")).toEqual(Array(10).fill(6));
    // Never reaches 20 in 5 steps, so every run scores steps + 1.
    expect(score("fast")).toEqual(Array(10).fill(6));
    expect(score("fast", { parameters: { pay: 5 } })).toEqual(Array(10).fill(4));
  });

  it("holds an early-ended run's last values for the final and mean measures", () => {
    // pay 5 ends at step 4 with 20 gold; step 5 holds 20.
    expect(score("wealth", { parameters: { pay: 5 } })).toEqual(Array(10).fill(20));
    expect(score("average", { parameters: { pay: 5 } })).toEqual(
      Array(10).fill((5 + 10 + 15 + 20 + 20) / 5),
    );
  });

  it("reports the spread and the batch, and matches monteCarlo's seeds", () => {
    const result = evaluateCandidate(
      model(),
      { strategy: "lucky" },
      { ...base, objective: "wealth" },
    );
    if (!result.ok) throw new Error("eval");
    const { evaluation } = result;
    expect(evaluation.score).toBeCloseTo(evaluation.perRun.reduce((a, b) => a + b) / 10);
    expect(evaluation.p5).toBeLessThanOrEqual(evaluation.p50);
    expect(evaluation.p50).toBeLessThanOrEqual(evaluation.p95);
    const batch = monteCarlo(model(), { seed: 7, runs: 10, steps: 5, strategy: "lucky" });
    if (!batch.ok) throw new Error("batch");
    expect([...evaluation.perRun].sort((a, b) => a - b)).toEqual(batch.result.finals.gold!.values);
    expect(evaluation.batch.traces).toHaveLength(10);
  });

  it("gives the same score to the same candidate every time", () => {
    expect(score("wealth", { strategy: "lucky" })).toEqual(score("wealth", { strategy: "lucky" }));
  });

  it("reads parameter values, overridden or not, in the objective", () => {
    const inline = {
      id: "pay",
      description: "Pay.",
      expr: "pay * 10",
      measure: "final" as const,
      sense: "max" as const,
    };
    expect(score(inline)).toEqual(Array(10).fill(20));
    expect(score(inline, { parameters: { pay: 3 } })).toEqual(Array(10).fill(30));
  });

  it("returns errors for unknown or broken objectives and bad candidates", () => {
    const errors = (objective: EvaluateOptions["objective"], candidate = {}) => {
      const result = evaluateCandidate(model(), candidate, { ...base, objective });
      return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
    };
    expect(errors("nope")).toEqual(['options.objective: unknown objective "nope"']);
    expect(
      errors({ id: "x", description: "X.", expr: "silver", measure: "final", sense: "max" }),
    ).toEqual(['options.objective.expr: formula references unknown node "silver"']);
    expect(errors("wealth", { strategy: "ghost" })).toEqual([
      'options.strategy: unknown strategy "ghost"',
    ]);
  });
});

describe("oriented", () => {
  it("negates scores of min objectives so higher is always better", () => {
    expect(oriented(3, model().objectives![0]!)).toBe(3);
    expect(oriented(3, model().objectives![2]!)).toBe(-3);
  });
});

describe("Budget", () => {
  it("counts evaluations and refuses what does not fit", () => {
    const budget = new Budget(3);
    expect(budget.take()).toBe(true);
    expect(budget.fits(2)).toBe(true);
    expect(budget.take(3)).toBe(false);
    expect(budget.used).toBe(1);
    expect(budget.take(2)).toBe(true);
    expect(budget.remaining).toBe(0);
  });
});
