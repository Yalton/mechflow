import { describe, expect, it } from "vitest";
import type { Model } from "@mechflow/core";
import { layeredPositions, ROW_GAP } from "../src/layout/layered.js";
import { runLayout } from "../src/layout/forceLayout.js";

const base: Model = {
  version: 1,
  name: "Layered",
  properties: [],
  subsystems: [],
  nodes: [],
  edges: [],
  noInteraction: [],
  invariants: [],
};

// mine -> ore -> forge -> bars -> sink, with a loop bars -> ore.
const chain: Model = {
  ...base,
  nodes: [
    { id: "mine", kind: "source", name: "Mine", rate: "2" },
    { id: "ore", kind: "pool", name: "Ore", start: 0 },
    { id: "forge", kind: "converter", name: "Forge", inputs: [{ resource: "ore", amount: 2 }], outputs: [{ resource: "bars", amount: 1 }] },
    { id: "bars", kind: "pool", name: "Bars", start: 0 },
    { id: "sink", kind: "drain", name: "Sink", rate: "1" },
  ] as Model["nodes"],
  edges: [
    { id: "dig", kind: "flow", from: "mine", to: "ore" },
    { id: "feed", kind: "flow", from: "ore", to: "forge" },
    { id: "make", kind: "flow", from: "forge", to: "bars" },
    { id: "sell", kind: "flow", from: "bars", to: "sink" },
    { id: "recycle", kind: "flow", from: "bars", to: "ore" },
  ],
};

describe("layeredPositions", () => {
  it("puts each node one column right of what feeds it, cycles cut where they close", () => {
    const at = layeredPositions(chain, { columnGap: 200 });
    expect(["mine", "ore", "forge", "bars", "sink"].map((id) => at.get(id)!.x)).toEqual([0, 200, 400, 600, 800]);
  });

  it("stacks a column's nodes ROW_GAP apart, centred on y = 0", () => {
    const fork: Model = {
      ...base,
      nodes: [
        { id: "a", kind: "source", name: "A" },
        { id: "b", kind: "pool", name: "B", start: 0 },
        { id: "c", kind: "pool", name: "C", start: 0 },
      ] as Model["nodes"],
      edges: [
        { id: "ab", kind: "flow", from: "a", to: "b" },
        { id: "ac", kind: "flow", from: "a", to: "c" },
      ],
    };
    const at = layeredPositions(fork, { columnGap: 200 });
    expect(at.get("a")).toEqual({ x: 0, y: 0 });
    expect([at.get("b")!.y, at.get("c")!.y]).toEqual([-ROW_GAP / 2, ROW_GAP / 2]);
  });

  it("is deterministic", () => {
    expect([...layeredPositions(chain, { columnGap: 200 })]).toEqual([...layeredPositions(chain, { columnGap: 200 })]);
  });
});

describe("runLayout economy placement", () => {
  it("lays the economy out left to right, left of the mechanics, and keeps pins", () => {
    const model: Model = {
      ...chain,
      nodes: [
        ...chain.nodes,
        { id: "craft", kind: "mechanic", name: "Craft", reads: [], writes: [] },
        { id: "pinned", kind: "pool", name: "Pinned", start: 0, position: { x: 5, y: 7 } },
      ] as Model["nodes"],
    };
    const at = runLayout(model);
    const xs = ["mine", "ore", "forge", "bars", "sink"].map((id) => at.get(id)!.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(Math.max(...xs)).toBeLessThan(at.get("craft")!.x);
    expect(at.get("pinned")).toEqual({ x: 5, y: 7 });
  });
});

describe("runLayout column stacking", () => {
  it("keeps unconnected nodes in one column stacked, not pushed sideways", () => {
    const pairs: Model = {
      ...base,
      nodes: ["a", "b", "c"].flatMap((id) => [
        { id: `${id}-in`, kind: "source", name: id },
        { id: `${id}-pool`, kind: "pool", name: id, start: 0 },
      ]) as Model["nodes"],
      edges: ["a", "b", "c"].map((id) => ({ id, kind: "flow" as const, from: `${id}-in`, to: `${id}-pool` })),
    };
    const at = runLayout(pairs);
    expect(new Set(["a-in", "b-in", "c-in"].map((id) => at.get(id)!.x)).size).toBe(1);
    expect(new Set(["a-pool", "b-pool", "c-pool"].map((id) => at.get(id)!.x)).size).toBe(1);
  });
});

describe("layeredPositions converters", () => {
  it("places a converter between the pools it trades, with no edge drawn", () => {
    const model: Model = {
      ...base,
      nodes: [
        { id: "ore", kind: "pool", name: "Ore", start: 0 },
        { id: "forge", kind: "converter", name: "Forge", inputs: [{ resource: "ore", amount: 2 }], outputs: [{ resource: "bars", amount: 1 }] },
        { id: "bars", kind: "pool", name: "Bars", start: 0 },
      ] as Model["nodes"],
    };
    const at = layeredPositions(model, { columnGap: 200 });
    expect(["ore", "forge", "bars"].map((id) => at.get(id)!.x)).toEqual([0, 200, 400]);
  });
});

describe("layeredPositions sources", () => {
  it("puts a source in the column just before its nearest target", () => {
    const model: Model = {
      ...chain,
      nodes: [...chain.nodes, { id: "late", kind: "source", name: "Late" }] as Model["nodes"],
      edges: [...chain.edges, { id: "top-up", kind: "flow", from: "late", to: "bars" }],
    };
    const at = layeredPositions(model, { columnGap: 200 });
    expect(at.get("late")!.x).toBe(at.get("bars")!.x - 200);
  });
});
