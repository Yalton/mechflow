import { describe, expect, it } from "vitest";
import { parseModelYaml, validateModel, type Model } from "@mechflow/core";
import { applyOperations, PatchError, type PatchOperation } from "../src/patch.js";

const BASE_YAML = `version: 1
name: Test
properties:
  - id: gold
    kind: number
subsystems:
  - id: core
    name: Core
    tier: core
nodes:
  - id: shop
    kind: mechanic
    name: Shop
    reads: [gold]
    writes: [gold]
  - id: bank
    kind: mechanic
    name: Bank
    reads: [gold]
    writes: [gold]
edges:
  - id: e1
    kind: interaction
    from: shop
    to: bank
    label: pays
noInteraction: []
invariants: []
`;

function baseModel(): Model {
  const result = parseModelYaml(BASE_YAML);
  if (!result.ok) throw new Error(`base model failed to parse: ${JSON.stringify(result.errors)}`);
  return result.model;
}

/** Apply operations and assert the result is a valid model. */
function applyAndValidate(operations: PatchOperation[]): Model {
  const next = applyOperations(baseModel(), operations);
  const validated = validateModel(next);
  if (!validated.ok) throw new Error(`result invalid: ${JSON.stringify(validated.errors)}`);
  return validated.model;
}

describe("applyOperations", () => {
  it("does not mutate the input model", () => {
    const model = baseModel();
    applyOperations(model, [{ op: "add_property", property: { id: "silver", kind: "number" } }]);
    expect(model.properties).toHaveLength(1);
  });

  it("add_node inserts a node", () => {
    const model = applyAndValidate([
      { op: "add_node", node: { id: "temple", kind: "mechanic", name: "Temple", reads: ["gold"], writes: [] } },
    ]);
    expect(model.nodes.map((n) => n.id)).toContain("temple");
  });

  it("add_node rejects a duplicate id", () => {
    expect(() =>
      applyOperations(baseModel(), [{ op: "add_node", node: { id: "shop", kind: "mechanic", name: "Dup", reads: [], writes: [] } }]),
    ).toThrow(PatchError);
  });

  it("update_node replaces fields", () => {
    const model = applyAndValidate([{ op: "update_node", id: "shop", node: { name: "Boutique" } }]);
    const shop = model.nodes.find((n) => n.id === "shop");
    expect(shop).toMatchObject({ name: "Boutique" });
  });

  it("update_node throws for a missing id", () => {
    expect(() => applyOperations(baseModel(), [{ op: "update_node", id: "nope", node: { name: "x" } }])).toThrow(/no node with id "nope"/);
  });

  it("remove_node drops the node and its edges", () => {
    const model = applyAndValidate([{ op: "remove_node", id: "shop" }]);
    expect(model.nodes.some((n) => n.id === "shop")).toBe(false);
    // e1 ran from shop, so it must be removed too.
    expect(model.edges.some((e) => e.id === "e1")).toBe(false);
  });

  it("remove_node throws for a missing id", () => {
    expect(() => applyOperations(baseModel(), [{ op: "remove_node", id: "nope" }])).toThrow(/no node with id "nope"/);
  });

  it("add_edge inserts an edge between existing nodes", () => {
    const model = applyAndValidate([
      { op: "add_node", node: { id: "temple", kind: "mechanic", name: "Temple", reads: [], writes: [] } },
      { op: "add_edge", edge: { id: "e2", kind: "interaction", from: "temple", to: "bank", label: "tithes" } },
    ]);
    const edge = model.edges.find((e) => e.id === "e2");
    expect(edge).toBeDefined();
    expect(edge?.label).toBe("tithes");
  });

  it("add_edge rejects a duplicate edge id", () => {
    expect(() =>
      applyOperations(baseModel(), [
        { op: "add_edge", edge: { id: "e1", kind: "interaction", from: "shop", to: "bank" } },
      ]),
    ).toThrow(/edge "e1" already exists/);
  });

  it("add_edge rejects an unknown endpoint", () => {
    expect(() =>
      applyOperations(baseModel(), [
        { op: "add_edge", edge: { id: "e2", kind: "interaction", from: "shop", to: "ghost" } },
      ]),
    ).toThrow(/references unknown node "ghost"/);
  });

  it("update_edge replaces fields", () => {
    const model = applyAndValidate([{ op: "update_edge", id: "e1", edge: { label: "tips" } }]);
    expect(model.edges.find((e) => e.id === "e1")?.label).toBe("tips");
  });

  it("update_edge throws for a missing id", () => {
    expect(() => applyOperations(baseModel(), [{ op: "update_edge", id: "nope", edge: { label: "x" } }])).toThrow(/no edge with id "nope"/);
  });

  it("remove_edge drops the edge", () => {
    const model = applyAndValidate([{ op: "remove_edge", id: "e1" }]);
    expect(model.edges.some((e) => e.id === "e1")).toBe(false);
  });

  it("remove_edge throws for a missing id", () => {
    expect(() => applyOperations(baseModel(), [{ op: "remove_edge", id: "nope" }])).toThrow(/no edge with id "nope"/);
  });

  it("add_property inserts a property", () => {
    const model = applyAndValidate([{ op: "add_property", property: { id: "silver", kind: "number" } }]);
    expect(model.properties.map((p) => p.id)).toContain("silver");
  });

  it("add_property rejects a duplicate id", () => {
    expect(() =>
      applyOperations(baseModel(), [{ op: "add_property", property: { id: "gold", kind: "number" } }]),
    ).toThrow(/property "gold" already exists/);
  });

  it("add_subsystem inserts a subsystem", () => {
    const model = applyAndValidate([
      { op: "add_subsystem", subsystem: { id: "flavor", name: "Flavor", tier: "flavor" } },
    ]);
    expect(model.subsystems.map((s) => s.id)).toContain("flavor");
  });

  it("add_subsystem rejects a duplicate id", () => {
    expect(() =>
      applyOperations(baseModel(), [{ op: "add_subsystem", subsystem: { id: "core", name: "Core2", tier: "core" } }]),
    ).toThrow(/subsystem "core" already exists/);
  });

  it("applies a mixed sequence in order", () => {
    const model = applyAndValidate([
      { op: "add_property", property: { id: "wood", kind: "number" } },
      { op: "add_node", node: { id: "lumberyard", kind: "mechanic", name: "Lumberyard", reads: ["wood"], writes: [] } },
      { op: "add_edge", edge: { id: "e2", kind: "interaction", from: "lumberyard", to: "shop", label: "sells" } },
      { op: "update_node", id: "shop", node: { name: "Trade Post" } },
    ]);
    expect(model.properties.map((p) => p.id)).toEqual(expect.arrayContaining(["gold", "wood"]));
    expect(model.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["shop", "bank", "lumberyard"]));
    expect(model.edges.map((e) => e.id)).toEqual(expect.arrayContaining(["e1", "e2"]));
    expect(model.nodes.find((n) => n.id === "shop")).toMatchObject({ name: "Trade Post" });
  });
});
