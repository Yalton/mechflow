import { describe, expect, it } from "vitest";
import { parseModelYaml } from "@mechflow/core";
import type { Model } from "@mechflow/core";
import { readFileSync } from "node:fs";
import { CARD_SIZE, labelWidth, runLayout } from "../src/layout/forceLayout.js";

/**
 * The example model (fixtures/examples/elements.yaml), embedded so the
 * quality-bar test is self-contained and does not depend on the filesystem or
 * the jsdom `import.meta.url` resolution.
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

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("runLayout", () => {
  it("returns a position for every node", () => {
    const model = loadExample();
    const positions = runLayout(model);
    for (const node of model.nodes) {
      expect(positions.get(node.id)).toBeDefined();
    }
  });

  it("clusters fire and water closer than fire to an unrelated node", () => {
    const model = loadExample();
    const positions = runLayout(model, { seed: 1234 });
    const fire = positions.get("fire")!;
    const water = positions.get("water")!;
    const wood = positions.get("wood")!;
    const door = positions.get("metal_door")!;

    const fireWater = distance(fire, water);
    const fireWood = distance(fire, wood);
    const fireDoor = distance(fire, door);

    // fire and water share `temperature` (score 5); wood/door share nothing
    // with fire. They must end up visibly closer than fire is to either.
    expect(fireWater).toBeLessThan(fireWood);
    expect(fireWater).toBeLessThan(fireDoor);
    // "visibly" closer: fire-water well under half the fire-unrelated distance.
    expect(fireWater).toBeLessThan(fireWood * 0.7);
    expect(fireWater).toBeLessThan(fireDoor * 0.7);
  });

  it("is deterministic for a fixed seed", () => {
    const model = loadExample();
    const a = runLayout(model, { seed: 42 });
    const b = runLayout(model, { seed: 42 });
    expect(a).toEqual(b);
  });

  it("keeps user-pinned nodes at their stored position", () => {
    const model: Model = {
      version: 1,
      name: "Pinned",
      properties: [{ id: "p", kind: "number" }],
      subsystems: [],
      nodes: [
        { id: "a", kind: "mechanic", name: "A", reads: ["p"], writes: ["p"], position: { x: 10, y: 20 } },
        { id: "b", kind: "mechanic", name: "B", reads: ["p"], writes: ["p"] },
      ],
      edges: [],
      noInteraction: [],
      invariants: [],
    };
    const positions = runLayout(model, { seed: 1 });
    expect(positions.get("a")).toEqual({ x: 10, y: 20 });
  });
});

describe("runLayout card spacing", () => {
  it("keeps every pair of node cards apart", () => {
    const model = loadExample();
    const positions = runLayout(model);
    const nodes = model.nodes;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const pa = positions.get(a.id)!;
        const pb = positions.get(b.id)!;
        const sa = CARD_SIZE[a.kind];
        const sb = CARD_SIZE[b.kind];
        const apartX = pa.x + sa.width <= pb.x || pb.x + sb.width <= pa.x;
        const apartY = pa.y + sa.height <= pb.y || pb.y + sb.height <= pa.y;
        expect(apartX || apartY, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("does not move pinned nodes to make room", () => {
    const model = loadExample();
    model.nodes.find((n) => n.id === "fire")!.position = { x: 0, y: 0, pinned: true };
    model.nodes.find((n) => n.id === "water")!.position = { x: 10, y: 10, pinned: true };
    const positions = runLayout(model);
    expect(positions.get("fire")).toEqual({ x: 0, y: 0 });
    expect(positions.get("water")).toEqual({ x: 10, y: 10 });
  });
});

describe("runLayout label room", () => {
  for (const name of ["economy", "inflation", "starvation", "boundary", "combo"]) {
    it(`leaves each labelled edge of ${name}.yaml room for its label`, () => {
      const parsed = parseModelYaml(
        readFileSync(`${process.cwd()}/../../fixtures/examples/${name}.yaml`, "utf8"),
      );
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const model = parsed.model;
      const positions = runLayout(model);
      const kind = new Map(model.nodes.map((n) => [n.id, n.kind]));
      const nodes = new Map(model.nodes.map((n) => [n.id, n]));
      for (const edge of model.edges) {
        const width = labelWidth(edge, nodes);
        if (width === 0 || edge.from === edge.to) continue;
        const a = positions.get(edge.from)!;
        const b = positions.get(edge.to)!;
        const [left, right] = a.x <= b.x ? [edge.from, edge.to] : [edge.to, edge.from];
        const gap = positions.get(right)!.x - (positions.get(left)!.x + CARD_SIZE[kind.get(left)!].width);
        expect(gap, `${edge.id}`).toBeGreaterThanOrEqual(width);
      }
    });
  }
});
