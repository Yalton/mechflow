import { describe, expect, it } from "vitest";
import { parseModelYaml, serializeModelYaml } from "../../src/model/io.js";
import { validateModel } from "../../src/model/schema.js";
import type { Model } from "../../src/model/types.js";

/** A model using every simulation field from docs/simulation-semantics.md. */
function simModel(): Model {
  return {
    version: 1,
    name: "Sim",
    properties: [],
    subsystems: [],
    nodes: [
      { id: "mine", kind: "source", name: "Mine", rate: 2, activation: "automatic", act: "push", flowMode: "all" },
      { id: "ore", kind: "pool", name: "Ore", start: 0, activation: "passive", act: "push", flowMode: "all" },
      { id: "bank", kind: "pool", name: "Bank", start: 0, activation: "interactive" },
      { id: "sink", kind: "drain", name: "Sink", rate: 1, act: "pull", flowMode: "any" },
      {
        id: "smelter",
        kind: "converter",
        name: "Smelter",
        inputs: [{ resource: "ore", amount: 2 }],
        outputs: [{ resource: "bank", amount: 1 }],
        activation: "onStart",
        act: "pull",
        flowMode: "all",
      },
    ],
    edges: [
      { id: "mine_ore", kind: "flow", from: "mine", to: "ore", delay: 3 },
      { id: "ore_bank", kind: "flow", from: "ore", to: "bank", delay: 0 },
      { id: "ore_trig", kind: "state", from: "ore", to: "smelter", strength: "trigger" },
    ],
    noInteraction: [],
    invariants: [],
    endConditions: [{ id: "rich", description: "Bank reaches 100", expr: "bank >= 100" }],
  };
}

function errorsFor(model: unknown): string[] {
  const r = validateModel(model);
  if (r.ok) throw new Error("expected validation to fail");
  return r.errors.map((e) => `${e.path}: ${e.message}`);
}

describe("simulation fields", () => {
  it("accepts every simulation field and keeps them", () => {
    const r = validateModel(simModel());
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.model).toEqual(simModel());
  });

  it("leaves a model without simulation fields unchanged", () => {
    const plain: Model = {
      version: 1,
      name: "Plain",
      properties: [],
      subsystems: [],
      nodes: [{ id: "p", kind: "pool", name: "P", start: 1 }],
      edges: [],
      noInteraction: [],
      invariants: [],
    };
    const r = validateModel(plain);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.model).toEqual(plain);
    expect("endConditions" in r.model).toBe(false);
  });

  it("rejects an unknown activation", () => {
    const m = simModel();
    (m.nodes[1] as unknown as Record<string, unknown>).activation = "sometimes";
    expect(errorsFor(m).some((e) => e.startsWith("nodes.1.activation"))).toBe(true);
  });

  it.each([
    [0, "act", "pull", "a source always pushes"],
    [0, "flowMode", "any", "a source always moves its full rate"],
    [3, "act", "push", "a drain can only pull"],
    [4, "act", "push", "a converter always pulls"],
    [4, "flowMode", "any", "a converter always needs all its inputs"],
  ])("rejects a contradicting fixed value (node %i %s: %s)", (index, field, value, message) => {
    const m = simModel();
    (m.nodes[index] as unknown as Record<string, unknown>)[field] = value;
    expect(errorsFor(m)).toContain(`nodes.${index}.${field}: ${message}`);
  });

  it("rejects a negative or fractional delay", () => {
    for (const delay of [-1, 1.5]) {
      const m = simModel();
      m.edges[0]!.delay = delay;
      expect(errorsFor(m).some((e) => e.startsWith("edges.0.delay"))).toBe(true);
    }
  });

  it("rejects a delay on a state edge", () => {
    const m = simModel();
    m.edges[2]!.delay = 1;
    expect(errorsFor(m)).toContain(
      'edges.2.delay: edge "ore_trig" has a delay but only flow edges can be delayed',
    );
  });

  it("rejects duplicate end condition ids and bad end condition formulas", () => {
    const m = simModel();
    m.endConditions!.push({ id: "rich", description: "Again", expr: "missing > 1" });
    const errors = errorsFor(m);
    expect(errors).toContain('endConditions.1.id: duplicate end condition id "rich"');
    expect(errors).toContain('endConditions.1.expr: formula references unknown node "missing"');
  });

  it("round-trips through YAML with endConditions last", () => {
    const yaml = serializeModelYaml(simModel());
    expect(yaml.trimEnd().split("\n").slice(-4)[0]).toBe("endConditions:");
    const parsed = parseModelYaml(yaml);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.model).toEqual(simModel());
  });

  it("omits an empty endConditions list", () => {
    expect(serializeModelYaml({ ...simModel(), endConditions: [] })).not.toContain("endConditions");
  });
});
