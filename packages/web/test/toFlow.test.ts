import { describe, expect, it } from "vitest";
import type { Model } from "@mechflow/core";
import { DIM_CLASS, FLOW_EDGE_TYPE, applyHighlight, toFlow } from "../src/graph/toFlow.js";

/** A small but complete model exercising every node kind and edge style. */
const model: Model = {
  version: 1,
  name: "Test",
  properties: [],
  subsystems: [
    { id: "core", name: "Core", tier: "core" },
    { id: "sup", name: "Support", tier: "support" },
  ],
  nodes: [
    { id: "p", kind: "pool", name: "Pool", subsystem: "core", position: { x: 10, y: 20 }, capacity: 100, start: 50 },
    { id: "s", kind: "source", name: "Src", subsystem: "core", rate: 5 },
    { id: "m", kind: "mechanic", name: "Mech", subsystem: "sup", reads: ["x"], writes: ["y"] },
    { id: "e", kind: "entity", name: "Ent", subsystem: "sup", has: ["x", "y"], position: { x: 500, y: 60 } },
  ],
  edges: [
    { id: "f", kind: "flow", from: "s", to: "p", rate: "5" },
    { id: "st", kind: "state", from: "p", to: "m" },
    { id: "i", kind: "interaction", from: "m", to: "e", label: "reads", polarity: "+", strength: "gate" },
    { id: "i2", kind: "interaction", from: "e", to: "m", polarity: "-", strength: "modifier" },
  ],
  noInteraction: [],
  invariants: [],
};

describe("toFlow", () => {
  it("maps every core node to a flow node keyed by kind", () => {
    const { nodes } = toFlow(model);
    expect(nodes.map((n) => n.type)).toEqual(["pool", "source", "mechanic", "entity"]);
    expect(nodes.map((n) => n.id)).toEqual(["p", "s", "m", "e"]);
  });

  it("attaches the core node and resolved subsystem data", () => {
    const { nodes } = toFlow(model);
    expect(nodes[0].data.node).toBe(model.nodes[0]);
    expect(nodes[0].data.subsystem).toBe("core");
    expect(nodes[0].data.tier).toBe("core");
    expect(nodes[2].data.tier).toBe("support");
  });

  it("uses stored positions when present and a deterministic fallback otherwise", () => {
    const { nodes } = toFlow(model);
    expect(nodes[0].position).toEqual({ x: 10, y: 20 });
    expect(nodes[3].position).toEqual({ x: 500, y: 60 });
    // positionless source falls into the "core" column (index 0), row 1.
    expect(nodes[1].position).toEqual({ x: 40, y: 170 });
    // positionless mechanic falls into the "sup" column (index 1), row 0.
    expect(nodes[2].position).toEqual({ x: 300, y: 40 });
  });

  it("marks every edge with the shared edge type and its style data", () => {
    const { edges } = toFlow(model);
    expect(edges.every((e) => e.type === FLOW_EDGE_TYPE)).toBe(true);
    expect(edges[0]).toEqual(
      expect.objectContaining({ source: "s", target: "p", data: expect.objectContaining({ kind: "flow" }) }),
    );
    expect(edges[1].data.kind).toBe("state");
    expect(edges[2].label).toBe("reads");
    expect(edges[2].data).toEqual(
      expect.objectContaining({ kind: "interaction", polarity: "+", strength: "gate" }),
    );
    expect(edges[3].data.polarity).toBe("-");
    expect(edges[3].data.strength).toBe("modifier");
  });

  it("is deterministic for the same model", () => {
    expect(toFlow(model)).toEqual(toFlow(model));
  });

  it("returns empty node/edge lists for a model with none", () => {
    const empty: Model = {
      version: 1,
      name: "Empty",
      properties: [],
      subsystems: [],
      nodes: [],
      edges: [],
      noInteraction: [],
      invariants: [],
    };
    const { nodes, edges } = toFlow(empty);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });
});

describe("applyHighlight", () => {
  it("returns the graph unchanged when no ids are supplied", () => {
    const graph = toFlow(model);
    expect(applyHighlight(graph, new Set(), new Set())).toBe(graph);
  });

  it("dims nodes outside the highlighted set", () => {
    const graph = toFlow(model);
    const { nodes } = applyHighlight(graph, new Set(["p"]), new Set());
    const dimmed = nodes.filter((n) => n.className === DIM_CLASS);
    const kept = nodes.filter((n) => n.className === undefined);
    expect(dimmed.map((n) => n.id)).toEqual(["s", "m", "e"]);
    expect(kept.map((n) => n.id)).toEqual(["p"]);
  });

  it("marks edges in the finding highlighted and others dimmed", () => {
    const graph = toFlow(model);
    const { edges } = applyHighlight(graph, new Set(), new Set(["f"]));
    const byId = Object.fromEntries(edges.map((e) => [e.id, e.data.highlighted]));
    expect(byId["f"]).toBe(true);
    expect(byId["st"]).toBe(false);
    expect(byId["i"]).toBe(false);
    expect(byId["i2"]).toBe(false);
  });

  it("does not create new node/edge references when inactive", () => {
    const graph = toFlow(model);
    const out = applyHighlight(graph, new Set(), new Set());
    expect(out.nodes).toBe(graph.nodes);
    expect(out.edges).toBe(graph.edges);
  });
});
