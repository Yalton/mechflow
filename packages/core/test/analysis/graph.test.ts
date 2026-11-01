import { describe, expect, it } from "vitest";
import {
  buildGraphIndex,
  adjacencyFor,
  simpleCycles,
  stronglyConnectedComponents,
  subsystemOf,
} from "../../src/analysis/graph.js";
import { loadExample } from "../helpers.js";

describe("buildGraphIndex", () => {
  const index = buildGraphIndex(loadExample("elements"));

  it("indexes every node, edge, subsystem, and property", () => {
    // The elements example has 6 nodes (all subsystemed), 1 interaction edge,
    // and 4 properties.
    expect(index.nodeById.size).toBe(6);
    expect(index.edgeById.size).toBe(1);
    expect(index.nodeToSubsystem.size).toBe(6);
    expect(index.properties.size).toBe(4);
  });

  it("looks up a node by id", () => {
    expect(index.nodeById.get("fire")?.name).toBe("Fire");
    expect(index.nodeById.get("missing")).toBeUndefined();
  });

  it("maps a node to its subsystem", () => {
    expect(subsystemOf(index, "fire")).toBe("combustion");
  });
});

describe("adjacencyFor", () => {
  const index = buildGraphIndex(loadExample("elements"));

  it("restricts successors to the requested edge kinds", () => {
    // The elements example has a single interaction edge (fire -> wood) and no
    // flow/state edges, so filtering by kind changes the successor sets.
    const interactions = adjacencyFor(index, ["interaction"]);
    const flows = adjacencyFor(index, ["flow"]);
    expect(interactions.get("fire")).toEqual(["wood"]);
    expect(flows.get("fire") ?? []).toEqual([]);
  });
});

describe("simpleCycles", () => {
  it("finds the single ring in the ring example", () => {
    const adj = adjacencyFor(buildGraphIndex(loadExample("ring")), [
      "flow",
      "state",
      "interaction",
    ]);
    const cycles = simpleCycles(adj);
    expect(cycles.length).toBe(1);
    // Canonical rotation starts at the lexicographically smallest node id.
    expect(cycles[0]?.[0]).toBe("p1");
    expect(cycles[0]?.length).toBe(5);
  });

  it("finds no cycles in a DAG", () => {
    const adj = adjacencyFor(buildGraphIndex(loadExample("dag")), [
      "flow",
      "state",
      "interaction",
    ]);
    expect(simpleCycles(adj)).toEqual([]);
  });
});

describe("stronglyConnectedComponents", () => {
  it("returns the ring as a single non-trivial SCC", () => {
    const adj = adjacencyFor(buildGraphIndex(loadExample("ring")), [
      "flow",
      "state",
      "interaction",
    ]);
    const sccs = stronglyConnectedComponents(adj).filter((c) => c.length > 1);
    expect(sccs.length).toBe(1);
    expect(sccs[0]?.length).toBe(5);
  });
});
