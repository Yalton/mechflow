import { describe, expect, it } from "vitest";
import type { Model } from "../../src/model/types.js";
import { monteCarlo } from "../../src/sim/montecarlo.js";
import { createRun, simulate, type RunOptions } from "../../src/sim/run.js";

/**
 * A mine pays 2 gold a step. Two interactive buttons: `buy` turns 5 gold into
 * a tool, `gift` adds 1 gold. A condition blocks `gift` once gold reaches 10.
 */
function shop(): Model {
  return {
    version: 1,
    name: "Shop",
    properties: [],
    subsystems: [],
    nodes: [
      { id: "mine", kind: "source", name: "Mine", rate: 2 },
      { id: "gold", kind: "pool", name: "Gold", start: 0, activation: "passive" },
      { id: "tools", kind: "pool", name: "Tools", start: 0, activation: "passive", capacity: 50 },
      {
        id: "buy",
        kind: "converter",
        name: "Buy",
        activation: "interactive",
        inputs: [{ resource: "gold", amount: 5 }],
        outputs: [{ resource: "tools", amount: 1 }],
      },
      { id: "gift", kind: "source", name: "Gift", rate: 1, activation: "interactive" },
    ],
    edges: [
      { id: "dig", kind: "flow", from: "mine", to: "gold", rate: "pay" },
      { id: "spend", kind: "flow", from: "gold", to: "buy" },
      { id: "make", kind: "flow", from: "buy", to: "tools" },
      { id: "give", kind: "flow", from: "gift", to: "gold" },
      { id: "cap", kind: "state", from: "gold", to: "gift", strength: "gate", rate: "self < 10" },
    ],
    noInteraction: [],
    invariants: [],
    parameters: [
      { id: "pay", description: "Gold per step.", value: 2, min: 0, max: 6, integer: true },
    ],
    strategies: [
      {
        id: "saver",
        description: "Buy a tool when gold allows, otherwise take the gift.",
        rules: [{ fire: "buy", when: "gold >= 5" }, { fire: "gift" }],
      },
    ],
  };
}

function run(options: Omit<RunOptions, "seed">) {
  const result = simulate(shop(), { seed: 1, steps: 6, ...options });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.trace;
}

function errors(options: Omit<RunOptions, "seed">): string[] {
  const result = simulate(shop(), { seed: 1, steps: 6, ...options });
  return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
}

describe("strategies", () => {
  it("fires the first eligible rule each step, in rule order", () => {
    const trace = run({ strategy: "saver" });
    expect(trace.steps.map((s) => s.firedByStrategy)).toEqual([
      ["gift"],
      ["gift"],
      ["buy"],
      ["gift"],
      ["buy"],
      ["gift"],
    ]);
    expect(trace.steps.map((s) => s.fired)).toEqual(trace.steps.map((s) => s.firedByStrategy));
  });

  it("fires up to actionsPerStep rules and skips nodes a condition blocks", () => {
    const trace = run({
      strategy: {
        id: "both",
        description: "Everything at once.",
        actionsPerStep: 2,
        rules: [{ fire: "gift" }, { fire: "gift" }, { fire: "buy" }],
      },
      overrides: { "nodes.gold.start": 12 },
    });
    // Gold starts at 12, so the condition blocks the gift; buy is eligible.
    expect(trace.steps[0]!.firedByStrategy).toEqual(["buy"]);
    const later = trace.steps.find((s) => s.firedByStrategy.length === 2);
    expect(later?.firedByStrategy).toEqual(["gift", "buy"]);
  });

  it("records no strategy fires without a strategy", () => {
    expect(run({}).steps.every((s) => s.firedByStrategy.length === 0)).toBe(true);
  });

  it("works in stepped runs and Monte Carlo batches", () => {
    const created = createRun(shop(), { seed: 1, strategy: "saver" });
    if (!created.ok) throw new Error("run");
    expect(created.run.step()!.firedByStrategy).toEqual(["gift"]);
    const batch = monteCarlo(shop(), { seed: 1, runs: 3, steps: 6, strategy: "saver" });
    if (!batch.ok) throw new Error("batch");
    expect(batch.result.finals.tools!.values).toEqual([2, 2, 2]);
  });

  it("rejects bad strategies before the run starts", () => {
    expect(errors({ strategy: "nope" })).toEqual(['options.strategy: unknown strategy "nope"']);
    expect(errors({ strategy: "saver", interactive: { gift: "always" } })).toEqual([
      "options.strategy: a run takes interactive schedules or a strategy, not both",
    ]);
    expect(
      errors({
        strategy: {
          id: "bad",
          description: "Bad.",
          actionsPerStep: 0,
          rules: [
            { fire: "mine" },
            { fire: "gift", when: "silver > 1" },
            { fire: "buy", when: "(" },
          ],
        },
      }),
    ).toEqual([
      'options.strategy.rules.0.fire: "mine" is not an interactive node',
      'options.strategy.rules.1.when: formula references unknown node "silver"',
      expect.stringMatching(/^options\.strategy\.rules\.2\.when: invalid formula/),
      "options.strategy.actionsPerStep: actionsPerStep must be a whole number of at least 1",
    ]);
  });
});

describe("parameter and field overrides", () => {
  it("runs with overridden parameter values without changing the model", () => {
    const model = shop();
    const result = simulate(model, { seed: 1, steps: 3, parameters: { pay: 5 } });
    if (!result.ok) throw new Error("run");
    expect(result.trace.steps.map((s) => s.amounts.gold)).toEqual([5, 10, 15]);
    expect(model.parameters![0]!.value).toBe(2);
  });

  it("overrides pool start and capacity and source rates", () => {
    const trace = run({
      overrides: { "nodes.gold.start": 100, "nodes.gold.capacity": 101, "nodes.mine.rate": 9 },
      parameters: { pay: 0 },
    });
    expect(trace.initial.amounts.gold).toBe(100);
    // `dig` reads its rate from `pay`, which is 0; the capacity still caps gold.
    expect(Math.max(...trace.steps.map((s) => s.amounts.gold!))).toBeLessThanOrEqual(101);
  });

  it("rejects unknown, out-of-range and fractional parameters and bad override paths", () => {
    expect(
      errors({
        parameters: { pay: 7, ghost: 1 },
        overrides: { "nodes.mine.start": 1, "edges.dig.rate": 1, "nodes.gold.start": -1 },
      }),
    ).toEqual([
      'options.parameters.ghost: unknown parameter "ghost"',
      'options.parameters.pay: 7 is outside the range of "pay" [0, 6]',
      "options.overrides.edges.dig.rate: override paths are nodes.<id>.start, .capacity or .rate",
      "options.overrides.nodes.gold.start: an override must be a non-negative number",
      'options.overrides.nodes.mine.start: node "mine" has no start to override',
    ]);
    expect(errors({ parameters: { pay: 2.5 } })).toEqual([
      'options.parameters.pay: "pay" takes whole numbers only',
    ]);
  });
});
