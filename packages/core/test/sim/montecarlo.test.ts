import { describe, expect, it } from "vitest";
import { deriveSeed, monteCarlo, simulate } from "../../src/index.js";
import type { Model } from "../../src/model/types.js";
import { loadExample } from "../helpers.js";

/** A pool fed by a die roll each step, so runs differ. */
const dice: Model = {
  version: 1,
  name: "Dice",
  properties: [],
  subsystems: [],
  nodes: [
    { id: "s", kind: "source", name: "s", rate: 1 },
    { id: "pot", kind: "pool", name: "pot", start: 0 },
  ],
  edges: [{ id: "roll", kind: "flow", from: "s", to: "pot", rate: "dice(1, 6)" }],
  noInteraction: [],
  invariants: [],
};

function batch(model: Model, seed = 1, runs = 30, steps = 10) {
  const result = monteCarlo(model, { seed, runs, steps });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.result;
}

describe("monteCarlo", () => {
  it("gives identical results for the same seed", () => {
    expect(batch(dice, 4)).toEqual(batch(dice, 4));
    expect(batch(dice, 4)).not.toEqual(batch(dice, 5));
  });

  it("orders its quantiles at every step", () => {
    const { pools } = batch(dice);
    expect(pools.pot).toHaveLength(11);
    for (const s of pools.pot!) {
      expect(s.p5).toBeLessThanOrEqual(s.p25);
      expect(s.p25).toBeLessThanOrEqual(s.p50);
      expect(s.p50).toBeLessThanOrEqual(s.p75);
      expect(s.p75).toBeLessThanOrEqual(s.p95);
      expect(s.mean).toBeGreaterThanOrEqual(s.p5);
      expect(s.mean).toBeLessThanOrEqual(s.p95);
    }
    expect(pools.pot![0]).toEqual({ mean: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0 });
    // Ten rolls of a d6 average 35.
    expect(pools.pot![10]!.mean).toBeGreaterThan(28);
    expect(pools.pot![10]!.mean).toBeLessThan(42);
  });

  it("lets any run be replayed alone with its seed", () => {
    const result = monteCarlo(dice, { seed: 3, runs: 12, steps: 10, keepTraces: true });
    if (!result.ok) throw new Error("batch");
    const k = 7;
    const run = result.result.runs[k]!;
    expect(run.seed).toBe(deriveSeed(3, k));
    const replay = simulate(dice, { seed: run.seed, steps: 10 });
    if (!replay.ok) throw new Error("replay");
    expect(replay.trace).toEqual(result.result.traces![k]);
    expect(result.result.finals.pot!.values).toContain(replay.trace.steps.at(-1)!.amounts.pot);
  });

  it("has zero spread for a deterministic model", () => {
    const { pools, finals } = batch(loadExample("economy"), 1, 8, 15);
    for (const series of Object.values(pools)) {
      for (const s of series) {
        expect(s.p5).toBe(s.p95);
        expect(s.mean).toBe(s.p50);
      }
    }
    for (const f of Object.values(finals)) expect(f.min).toBe(f.max);
  });

  it("holds the last values of runs that end early", () => {
    const m: Model = {
      ...dice,
      endConditions: [{ id: "full", description: "Pot is full", expr: "pot >= 20" }],
    };
    const result = batch(m, 2, 20, 30);
    for (const run of result.runs) {
      expect(run.end.reason).toBe("endCondition");
      expect(run.stepsRun).toBeLessThan(30);
    }
    expect(result.pools.pot).toHaveLength(31);
    expect(result.pools.pot![30]!.p5).toBeGreaterThanOrEqual(20);
    expect(result.finals.pot!.values).toHaveLength(20);
  });

  it("returns errors as data", () => {
    expect(monteCarlo(dice, { seed: 1, runs: 0, steps: 5 })).toMatchObject({
      ok: false,
      errors: [{ path: "options.runs" }],
    });
    expect(monteCarlo(dice, { seed: 1, runs: 2, steps: 0 })).toMatchObject({
      ok: false,
      errors: [{ path: "options.steps" }],
    });
  });
});
