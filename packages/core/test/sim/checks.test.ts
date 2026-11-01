import { describe, expect, it } from "vitest";
import { simulate, simulationChecks, type TraceCheckOptions } from "../../src/index.js";
import type { Model } from "../../src/model/types.js";
import { loadExample } from "../helpers.js";

function findings(model: Model, steps = 50, options: TraceCheckOptions = {}) {
  const result = simulate(model, { seed: 1, steps });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return simulationChecks(result.trace, model, options);
}
const ids = (model: Model, steps = 50, options: TraceCheckOptions = {}): string[] =>
  findings(model, steps, options).map((f) => f.id);

describe("simulation checks on the examples", () => {
  it("inflation.yaml grows without bound", () => {
    const [finding, ...rest] = findings(loadExample("inflation"));
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      id: "sim-inflation:wallet",
      check: "sim-inflation",
      severity: "warning",
      nodes: ["wallet"],
      data: { start: 50, end: 400, lateGrowthPerStep: 7 },
    });
  });

  it("starvation.yaml starves the forge once the stockpile is gone", () => {
    const [finding, ...rest] = findings(loadExample("starvation"));
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      id: "sim-starvation:forge",
      nodes: ["forge", "stockpile"],
      edges: ["smelting"],
      data: { start: 10, end: 50, longestStreak: 41, pools: ["stockpile"], episodes: 1 },
    });
  });

  it("snowballing.yaml snowballs through its reinforcing loop", () => {
    expect(ids(loadExample("snowballing"))).toEqual([
      "sim-inflation:savings",
      "sim-snowballing:savings",
    ]);
    const snowball = findings(loadExample("snowballing")).find(
      (f) => f.check === "sim-snowballing",
    )!;
    expect(snowball.nodes).toEqual(["savings", "interest"]);
    expect(snowball.data!.loops).toEqual(["feedback-loops:interest,savings"]);
    expect(snowball.data!.correlation).toBeGreaterThan(0.99);
  });

  it("cascade.yaml cascades from the mill down the chain", () => {
    const cascade = findings(loadExample("cascade")).filter(
      (f) => f.check === "sim-cascading-failure",
    );
    expect(cascade).toHaveLength(1);
    expect(cascade[0]).toMatchObject({
      id: "sim-cascading-failure:mill",
      nodes: ["mill", "bakery", "shop"],
      data: {
        origin: "mill",
        step: 4,
        chain: [
          { node: "bakery", step: 6 },
          { node: "shop", step: 9 },
        ],
      },
    });
  });

  it("economy.yaml only reports the starvation its rates cause", () => {
    // The treasury pulls 50 a step from a market that receives 10, and runs
    // dry at step 10, after which the workshop and the reserve go short.
    expect(ids(loadExample("economy"))).toEqual([
      "sim-starvation:reserve",
      "sim-starvation:treasury",
      "sim-starvation:workshop",
    ]);
  });

  it("finds nothing in the static-only examples", () => {
    for (const name of ["dag", "elements", "hub-spoke"])
      expect(ids(loadExample(name)), name).toEqual([]);
  });
});

describe("thresholds", () => {
  it("can be raised in the options", () => {
    expect(ids(loadExample("inflation"), 50, { inflation: { factor: 10 } })).toEqual([]);
    expect(ids(loadExample("starvation"), 50, { starvation: { minStreak: 42 } })).toEqual([]);
    expect(ids(loadExample("snowballing"), 50, { snowballing: { minCorrelation: 1.01 } })).toEqual([
      "sim-inflation:savings",
    ]);
    expect(
      ids(loadExample("cascade"), 50, { cascadingFailure: { window: 1 } }).filter((id) =>
        id.startsWith("sim-cascading"),
      ),
    ).toEqual([]);
  });

  it("does not judge growth on runs that are too short", () => {
    expect(ids(loadExample("inflation"), 7)).toEqual([]);
  });

  it("never reports inflation for a pool with a capacity", () => {
    const m = loadExample("inflation");
    const capped: Model = {
      ...m,
      nodes: m.nodes.map((n) => (n.id === "wallet" ? { ...n, capacity: 10_000 } : n)),
    };
    expect(ids(capped)).toEqual([]);
  });

  it("counts a converter whose input pool is too low as starved", () => {
    const m: Model = {
      version: 1,
      name: "Smelter",
      properties: [],
      subsystems: [],
      nodes: [
        { id: "ore", kind: "pool", name: "Ore", start: 4 },
        { id: "bars", kind: "pool", name: "Bars", start: 0 },
        {
          id: "smelt",
          kind: "converter",
          name: "Smelt",
          inputs: [{ resource: "ore", amount: 2 }],
          outputs: [{ resource: "bars", amount: 1 }],
        },
      ],
      edges: [],
      noInteraction: [],
      invariants: [],
    };
    expect(findings(m, 10)).toMatchObject([
      { id: "sim-starvation:smelt", nodes: ["smelt", "ore"], data: { start: 3, end: 10 } },
    ]);
  });
});
