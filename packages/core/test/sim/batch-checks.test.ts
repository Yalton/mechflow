import { describe, expect, it } from "vitest";
import {
  batchChecks,
  monteCarlo,
  simulate,
  simulationChecks,
  streaksCheck,
  varianceCheck,
  type MonteCarloResult,
} from "../../src/index.js";
import type { Model } from "../../src/model/types.js";
import { loadExample } from "../helpers.js";

function batch(model: Model, runs = 50, steps = 50, seed = 1): MonteCarloResult {
  const result = monteCarlo(model, { seed, runs, steps, keepTraces: true });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.result;
}

/** A forge pulling 4 ore a step from a mine that rolls 1d6: short now and then. */
const lumpy: Model = {
  version: 1,
  name: "Lumpy",
  properties: [],
  subsystems: [],
  nodes: [
    { id: "mine", kind: "source", name: "Mine", rate: 1 },
    { id: "ore", kind: "pool", name: "Ore", start: 0, activation: "passive" },
    { id: "forge", kind: "drain", name: "Forge", rate: 4 },
  ],
  edges: [
    { id: "dig", kind: "flow", from: "mine", to: "ore", rate: "dice(1, 6)" },
    { id: "burn", kind: "flow", from: "ore", to: "forge" },
  ],
  noInteraction: [],
  invariants: [],
};

describe("variance", () => {
  it("flags the jackpot in variance.yaml and not the steady wages", () => {
    const findings = varianceCheck(batch(loadExample("variance")));
    expect(findings.map((f) => f.id)).toEqual(["sim-variance:jackpot"]);
    const data = findings[0]!.data!;
    expect(data.cv).toBeGreaterThan(0.5);
    expect(data.p5).toBeLessThanOrEqual(data.p50 as number);
    expect(data.p50).toBeLessThanOrEqual(data.p95 as number);
    expect(data.runs).toBe(50);
  });

  it("respects its thresholds", () => {
    const result = batch(loadExample("variance"));
    expect(varianceCheck(result, { variance: { maxCv: 2 } })).toEqual([]);
    expect(varianceCheck(batch(loadExample("variance"), 9))).toEqual([]);
  });

  it("finds nothing in a deterministic model", () => {
    expect(varianceCheck(batch(loadExample("economy"), 12, 20))).toEqual([]);
  });
});

describe("worst-case streaks", () => {
  it("names the worst run's seed, which replays to the same streak", () => {
    const result = batch(lumpy, 40, 40);
    const [finding, ...rest] = streaksCheck(result, lumpy, { streaks: { minStreak: 2 } });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ id: "sim-streaks:forge", nodes: ["forge"] });
    const { seed, worstStreak, start, run } = finding!.data as Record<string, number>;
    expect(seed).toBe(result.runs[run]!.seed);

    const replay = simulate(lumpy, { seed, steps: 40 });
    if (!replay.ok) throw new Error("replay");
    const starvation = simulationChecks(replay.trace, lumpy, { starvation: { minStreak: 1 } }).find(
      (f) => f.id === "sim-starvation:forge",
    )!;
    expect(starvation.data).toMatchObject({ longestStreak: worstStreak, start });
  });

  it("reports how many runs had a long streak", () => {
    const result = batch(loadExample("starvation"), 10, 50);
    expect(streaksCheck(result, loadExample("starvation"))).toMatchObject([
      { id: "sim-streaks:forge", data: { worstStreak: 41, start: 10, runsAffected: 10, runs: 10 } },
    ]);
  });

  it("counts failed all-mode activations as short", () => {
    const m: Model = {
      ...lumpy,
      nodes: [
        { id: "mine", kind: "source", name: "Mine", rate: 1 },
        { id: "ore", kind: "pool", name: "Ore", start: 0, activation: "passive" },
        { id: "vault", kind: "pool", name: "Vault", start: 0, flowMode: "all" },
      ],
      edges: [
        { id: "dig", kind: "flow", from: "mine", to: "ore", rate: "dice(1, 2)" },
        { id: "haul", kind: "flow", from: "ore", to: "vault", rate: "5" },
      ],
    };
    // The vault asks for 5 at once and gets nothing until the ore has piled up.
    const findings = streaksCheck(batch(m, 10, 30), m, { streaks: { minStreak: 2 } });
    expect(findings.map((f) => f.id)).toEqual(["sim-streaks:vault"]);
  });

  it("needs the batch's traces", () => {
    const result = monteCarlo(lumpy, { seed: 1, runs: 3, steps: 5 });
    if (!result.ok) throw new Error("batch");
    expect(() => streaksCheck(result.result, lumpy)).toThrow(/keepTraces/);
  });
});

it("batchChecks runs both and sorts by id", () => {
  const m = loadExample("variance");
  expect(batchChecks(batch(m), m).map((f) => f.id)).toEqual(["sim-variance:jackpot"]);
  const s = loadExample("starvation");
  expect(batchChecks(batch(s, 10), s).map((f) => f.id)).toEqual(["sim-streaks:forge"]);
});
