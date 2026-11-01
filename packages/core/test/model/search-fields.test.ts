import { describe, expect, it } from "vitest";
import { parseModelYaml, serializeModelYaml } from "../../src/model/io.js";
import { validateModel } from "../../src/model/schema.js";
import type { Model } from "../../src/model/types.js";
import { simulate } from "../../src/sim/run.js";

/** A model using every search field from docs/search-design.md. */
function searchModel(): Model {
  return {
    version: 1,
    name: "Search",
    properties: [],
    subsystems: [],
    nodes: [
      { id: "mine", kind: "source", name: "Mine", rate: 100 },
      { id: "gold", kind: "pool", name: "Gold", start: 0, activation: "passive" },
      { id: "bonus", kind: "source", name: "Bonus", rate: 5, activation: "interactive" },
    ],
    edges: [
      { id: "dig", kind: "flow", from: "mine", to: "gold", rate: "dig_rate" },
      { id: "gift", kind: "flow", from: "bonus", to: "gold" },
    ],
    noInteraction: [],
    invariants: [],
    parameters: [
      {
        id: "dig_rate",
        description: "Gold dug per step.",
        value: 3,
        min: 0,
        max: 10,
        integer: true,
      },
    ],
    objectives: [
      {
        id: "wealth",
        description: "Gold at the end.",
        expr: "gold",
        measure: "final",
        sense: "max",
      },
      { id: "fast", description: "Steps to win.", expr: "0", measure: "endStep", sense: "min" },
    ],
    strategies: [
      {
        id: "greedy",
        description: "Take the bonus while poor.",
        intended: true,
        actionsPerStep: 1,
        rules: [{ fire: "bonus", when: "gold < dig_rate * 10" }],
      },
    ],
  };
}

function errorsFor(model: unknown): string[] {
  const result = validateModel(model);
  return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
}

describe("search model fields", () => {
  it("accepts parameters, objectives and strategies", () => {
    expect(errorsFor(searchModel())).toEqual([]);
  });

  it("round-trips them through YAML", () => {
    const parsed = parseModelYaml(serializeModelYaml(searchModel()));
    expect(parsed.ok && parsed.model).toEqual(searchModel());
  });

  it("leaves them out of the YAML when unused", () => {
    const plain: Model = { ...searchModel(), parameters: [], objectives: undefined };
    delete plain.strategies;
    const yaml = serializeModelYaml(plain);
    expect(yaml).not.toMatch(/parameters|objectives|strategies/);
  });

  it("rejects duplicate ids in each list", () => {
    const model = searchModel();
    model.parameters!.push({ ...model.parameters![0]! });
    model.objectives!.push({ ...model.objectives![0]! });
    model.strategies!.push({ ...model.strategies![0]! });
    expect(errorsFor(model)).toEqual(
      expect.arrayContaining([
        'parameters.1.id: duplicate parameter id "dig_rate"',
        'objectives.2.id: duplicate objective id "wealth"',
        'strategies.1.id: duplicate strategy id "greedy"',
      ]),
    );
  });

  it("rejects a parameter id that is also a node id, or a value out of range", () => {
    const model = searchModel();
    model.parameters!.push({ id: "gold", description: "Clash.", value: 20, min: 0, max: 10 });
    expect(errorsFor(model)).toEqual(
      expect.arrayContaining([
        'parameters.1.id: parameter id "gold" is also a node id',
        'parameters.1.value: parameter "gold" value 20 is outside [0, 10]',
      ]),
    );
  });

  it("rejects rules that fire a node that is not interactive", () => {
    const model = searchModel();
    model.strategies![0]!.rules.push({ fire: "mine" }, { fire: "ghost" });
    expect(errorsFor(model)).toEqual([
      'strategies.0.rules.1.fire: strategy "greedy" fires "mine", which is not an interactive node',
      'strategies.0.rules.2.fire: strategy "greedy" fires "ghost", which is not an interactive node',
    ]);
  });

  it("checks rule and objective formulas, except an endStep objective's", () => {
    const model = searchModel();
    model.strategies![0]!.rules[0]!.when = "silver > 1";
    model.objectives![0]!.expr = "gold +";
    model.objectives![1]!.expr = "anything at all";
    const errors = errorsFor(model);
    expect(errors).toContain('strategies.0.rules.0.when: formula references unknown node "silver"');
    expect(errors.some((e) => e.startsWith("objectives.0.expr: invalid formula"))).toBe(true);
    expect(errors.some((e) => e.startsWith("objectives.1"))).toBe(false);
  });

  it("requires actionsPerStep to be a whole number of at least 1", () => {
    const model = searchModel();
    model.strategies![0]!.actionsPerStep = 0;
    expect(errorsFor(model).some((e) => e.startsWith("strategies.0.actionsPerStep"))).toBe(true);
  });

  it("lets formulas read parameter values", () => {
    const result = simulate(searchModel(), { seed: 1, steps: 2 });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.trace.steps.map((s) => s.amounts.gold)).toEqual([3, 6]);
  });
});
