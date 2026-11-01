import { describe, expect, it } from "vitest";
import { analyzeModel, parseModelYaml, type GhostEdge, type Model } from "@mechflow/core";
import {
  filterGhostEdges,
  ghostEdgeId,
  ghostEdgesToDescriptors,
  reasonLabel,
  shortLabel,
  topReason,
} from "../src/graph/ghostEdges.js";

/**
 * The example model (fixtures/examples/elements.yaml), embedded so the
 * ghost-edge conversion test is self-contained and does not depend on the
 * filesystem or the jsdom `import.meta.url` resolution.
 */
function loadExample(): Model {
  const text = `
version: 1
name: Elements
description: A small mechanic map used as an example model for analysis.
properties:
  - id: temperature
    kind: number
  - id: wetness
    kind: number
  - id: flammable
    kind: flag
  - id: conductive
    kind: flag
subsystems:
  - id: combustion
    name: Combustion
    tier: core
  - id: weather
    name: Weather
    tier: core
  - id: power
    name: Power
    tier: support
  - id: nature
    name: Nature
    tier: flavor
  - id: technology
    name: Technology
    tier: flavor
nodes:
  - id: fire
    kind: mechanic
    name: Fire
    subsystem: combustion
    reads: []
    writes:
      - temperature
  - id: water
    kind: mechanic
    name: Water
    subsystem: weather
    reads:
      - temperature
    writes:
      - wetness
      - temperature
  - id: ice
    kind: mechanic
    name: Ice
    subsystem: weather
    reads:
      - temperature
    writes: []
  - id: electricity
    kind: mechanic
    name: Electricity
    subsystem: power
    reads:
      - conductive
      - wetness
    writes: []
  - id: wood
    kind: entity
    name: Wood
    subsystem: nature
    has:
      - flammable
  - id: metal_door
    kind: entity
    name: Metal Door
    subsystem: technology
    has:
      - conductive
edges:
  - id: fire_to_wood
    kind: interaction
    from: fire
    to: wood
    label: ignites
noInteraction:
  - a: ice
    b: metal_door
    reason: Ice and a metal door are unrelated in this model.
invariants: []
`;
  const result = parseModelYaml(text);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("example model failed to parse");
  return result.model;
}

/** The core ghost edge between two ids, or undefined if they are not ghosts. */
function coreGhost(model: Model, a: string, b: string): GhostEdge | undefined {
  return analyzeModel(model).ghostEdges.find(
    (g) => ghostEdgeId(g.a, g.b) === ghostEdgeId(a, b),
  );
}

describe("ghostEdgesToDescriptors", () => {
  it("maps every report ghost edge to exactly one descriptor", () => {
    const model = loadExample();
    const report = analyzeModel(model);
    const descs = ghostEdgesToDescriptors(report);
    expect(descs.length).toBe(report.ghostEdges.length);
  });

  it("labels fire/water with the top (highest-weight) reason and matching score", () => {
    const model = loadExample();
    const report = analyzeModel(model);
    const g = coreGhost(model, "fire", "water")!;
    const desc = ghostEdgesToDescriptors(report).find(
      (d) => ghostEdgeId(d.a, d.b) === ghostEdgeId("fire", "water"),
    )!;

    // fire writes, water reads temperature => readWrite (weight 3) beats
    // sharedWrite (weight 2). The descriptor must carry that reason.
    expect(desc.reason).toBe(reasonLabel(topReason(g)!));
    expect(desc.reason).toBe("temperature is written by one and read by the other");
    // The score is carried verbatim from the core edge.
    expect(desc.score).toBe(g.score);
  });

  it("is deterministic and sorted by score descending", () => {
    const model = loadExample();
    const a = ghostEdgesToDescriptors(analyzeModel(model));
    const b = ghostEdgesToDescriptors(analyzeModel(model));
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) {
      expect(a[i - 1]!.score).toBeGreaterThanOrEqual(a[i]!.score);
    }
  });

  it("keeps the score-desc, id-asc ordering stable", () => {
    // Two pairs with the same score order by their sorted id string.
    const model: Model = {
      version: 1,
      name: "Tie",
      properties: [{ id: "p", kind: "number" }],
      subsystems: [],
      nodes: [
        { id: "aa", kind: "mechanic", name: "AA", reads: ["p"], writes: ["p"] },
        { id: "bb", kind: "mechanic", name: "BB", reads: ["p"], writes: ["p"] },
        { id: "cc", kind: "mechanic", name: "CC", reads: ["p"], writes: ["p"] },
        { id: "dd", kind: "mechanic", name: "DD", reads: ["p"], writes: ["p"] },
      ],
      edges: [],
      noInteraction: [],
      invariants: [],
    };
    const descs = ghostEdgesToDescriptors(analyzeModel(model));
    // aa/bb (id "ghost-edge:aa_bb") sorts before aa/cc ("ghost-edge:aa_cc").
    expect(descs[0]).toMatchObject({ a: "aa", b: "bb" });
    expect(ghostEdgeId(descs[1]!.a, descs[1]!.b)).toBe(ghostEdgeId("aa", "cc"));
  });

  it("labels a pair related only by a shared neighbour (no reasons)", () => {
    // Two mechanics that feed the same pool but share no property: the core
    // reports the pair with an empty reasons list.
    const model: Model = {
      version: 1,
      name: "Neighbour",
      properties: [
        { id: "p", kind: "number" },
        { id: "q", kind: "number" },
      ],
      subsystems: [],
      nodes: [
        { id: "m1", kind: "mechanic", name: "M1", reads: [], writes: ["p"] },
        { id: "m2", kind: "mechanic", name: "M2", reads: [], writes: ["q"] },
        { id: "pool", kind: "pool", name: "Pool", start: 0 },
      ],
      edges: [
        { id: "e1", kind: "flow", from: "m1", to: "pool" },
        { id: "e2", kind: "flow", from: "m2", to: "pool" },
      ],
      noInteraction: [],
      invariants: [],
    } as Model;
    const report = analyzeModel(model);
    expect(report.ghostEdges).toEqual([{ a: "m1", b: "m2", reasons: [], score: 1 }]);
    expect(ghostEdgesToDescriptors(report)).toEqual([
      {
        id: "ghost-edge:m1_m2",
        a: "m1",
        b: "m2",
        reason: "share a neighbour",
        short: "neighbour",
        reasons: ["share a neighbour"],
        score: 1,
      },
    ]);
  });
});

describe("filterGhostEdges", () => {
  it("hides pairs at or below the threshold, keeping order", () => {
    const model = loadExample();
    const report = analyzeModel(model);
    const all = ghostEdgesToDescriptors(report);
    // fire/water scores highest (readWrite + sharedWrite + sharedRead).
    const fireWater = all.find((d) => ghostEdgeId(d.a, d.b) === ghostEdgeId("fire", "water"))!;

    const kept = filterGhostEdges(all, fireWater.score);
    expect(kept).toEqual([fireWater]);

    const keptLower = filterGhostEdges(all, 2);
    // score >= 2 survives; the ordering is preserved.
    expect(keptLower[0]).toMatchObject({ a: fireWater.a, b: fireWater.b });
    expect(keptLower.every((d) => d.score >= 2)).toBe(true);
  });
});

describe("ghostEdgeId", () => {
  it("is order-independent between the two node ids", () => {
    expect(ghostEdgeId("fire", "water")).toBe(ghostEdgeId("water", "fire"));
    expect(ghostEdgeId("fire", "water")).not.toBe(ghostEdgeId("water", "fire") + "x");
  });
});

describe("shortLabel", () => {
  it("names the property, or the shared target", () => {
    expect(shortLabel({ kind: "readWrite", property: "temperature" })).toBe("temperature");
    expect(shortLabel({ kind: "sharedTarget", target: "wood" })).toBe("→ wood");
  });
});
