import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/sim/engine.js";
import { createRng } from "../../src/sim/rng.js";
import type { StepRecord } from "../../src/sim/types.js";
import type { Edge, GateNode, Model, Node } from "../../src/model/types.js";

function model(nodes: Node[], edges: Edge[]): Model {
  return {
    version: 1,
    name: "Sim",
    properties: [],
    subsystems: [],
    nodes,
    edges,
    noInteraction: [],
    invariants: [],
  };
}

const pool = (id: string, start: number, extra: Partial<Node> = {}): Node =>
  ({ id, kind: "pool", name: id, start, ...extra }) as Node;
const source = (id: string, rate: number): Node => ({ id, kind: "source", name: id, rate });
const gate = (id: string, mode: GateNode["mode"]): Node => ({ id, kind: "gate", name: id, mode });
const converter = (
  id: string,
  inputs: [string, number][],
  outputs: [string, number][],
  extra: Partial<Node> = {},
): Node =>
  ({
    id,
    kind: "converter",
    name: id,
    inputs: inputs.map(([resource, amount]) => ({ resource, amount })),
    outputs: outputs.map(([resource, amount]) => ({ resource, amount })),
    ...extra,
  }) as Node;
const flow = (from: string, to: string, rate?: string, extra: Partial<Edge> = {}): Edge => ({
  id: `${from}_${to}`,
  kind: "flow",
  from,
  to,
  ...(rate !== undefined ? { rate } : {}),
  ...extra,
});

function run(m: Model, steps: number, seed = 1): StepRecord[] {
  const created = createEngine(m);
  if (!created.ok) throw new Error(JSON.stringify(created.errors));
  const rng = createRng(seed);
  let state = created.engine.initialState(rng);
  const records: StepRecord[] = [];
  for (let i = 0; i < steps; i++) {
    const next = created.engine.step(state, rng);
    state = next.state;
    records.push(next.record);
  }
  return records;
}

describe("converters", () => {
  it("consumes inputs in step t and delivers outputs in step t + 1", () => {
    const m = model(
      [
        pool("ore", 4),
        pool("coal", 1),
        pool("bars", 0),
        converter(
          "smelt",
          [
            ["ore", 2],
            ["coal", 1],
          ],
          [["bars", 3]],
        ),
      ],
      [],
    );
    const [first, second, third] = run(m, 3);
    expect(first!.amounts).toEqual({ bars: 0, coal: 0, ore: 2 });
    expect(first!.activations).toEqual({ smelt: 1 });
    expect(first!.inTransit).toBe(3);
    expect(second!.arrivals).toEqual({ bars: 3 });
    expect(second!.amounts).toEqual({ bars: 3, coal: 0, ore: 2 });
    // Out of coal: the converter fails and nothing more is made.
    expect(second!.failed).toEqual(["smelt"]);
    expect(third!.amounts.bars).toBe(3);
  });

  it("activates up to maxActivationsPerStep while all inputs last", () => {
    const m = model(
      [
        pool("ore", 7),
        pool("bars", 0),
        converter("smelt", [["ore", 2]], [["bars", 1]], { maxActivationsPerStep: 5 }),
      ],
      [],
    );
    const records = run(m, 3);
    expect(records.map((r) => r.activations.smelt)).toEqual([3, 0, 0]);
    expect(records.map((r) => r.amounts)).toEqual([
      { bars: 0, ore: 1 },
      { bars: 3, ore: 1 },
      { bars: 3, ore: 1 },
    ]);
  });

  it("competes with other pull-all nodes in the seeded shuffle", () => {
    const m = model(
      [
        pool("ore", 2),
        pool("hoard", 0, { flowMode: "all" }),
        pool("bars", 0),
        converter("smelt", [["ore", 2]], [["bars", 1]]),
      ],
      [flow("ore", "hoard", "2")],
    );
    const winners = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const [first] = run(m, 1, seed);
      winners.add(first!.amounts.hoard === 2 ? "hoard" : "smelt");
      expect(first!.amounts.ore).toBe(0);
    }
    expect(winners).toEqual(new Set(["hoard", "smelt"]));
  });

  it("loses outputs that do not fit when they arrive", () => {
    const m = model(
      [
        pool("ore", 10),
        pool("bars", 0, { capacity: 2 }),
        converter("smelt", [["ore", 1]], [["bars", 3]]),
      ],
      [],
    );
    const [, second] = run(m, 2);
    expect(second!.arrivals).toEqual({ bars: 2 });
    expect(second!.capacityLoss).toEqual({ bars: 1 });
  });

  it("rejects converters it cannot simulate", () => {
    const created = createEngine(
      model(
        [
          pool("ore", 1),
          source("s", 1),
          converter("bad", [["s", 1.5]], [["nowhere", 1]], { maxActivationsPerStep: 0 }),
        ],
        [],
      ),
    );
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.errors.map((e) => e.path)).toEqual([
      "nodes.2.inputs.0.resource",
      "nodes.2.inputs.0.amount",
      "nodes.2.outputs.0.resource",
      "nodes.2.maxActivationsPerStep",
    ]);
  });
});

describe("gates", () => {
  it("a deterministic gate hits its exact weighted shares over 100 steps", () => {
    const m = model(
      [source("s", 1), gate("g", "deterministic"), pool("a", 0), pool("b", 0), pool("c", 0)],
      [flow("s", "g"), flow("g", "a", "1"), flow("g", "b", "2"), flow("g", "c", "2")],
    );
    const records = run(m, 100);
    expect(records.at(-1)!.amounts).toEqual({ a: 20, b: 40, c: 40 });
    // Smooth: never more than one resource ahead of its share.
    for (const [i, r] of records.entries()) {
      expect(Math.abs(r.amounts.b! - ((i + 1) * 2) / 5)).toBeLessThan(1.01);
    }
  });

  it("routes in the same step it receives, then the targets act next step", () => {
    const m = model(
      [
        pool("in", 3, { act: "push" }),
        gate("g", "deterministic"),
        pool("out", 0),
        pool("after", 0),
      ],
      [flow("in", "g", "3"), flow("g", "out"), flow("out", "after", "10")],
    );
    const [first, second] = run(m, 2);
    expect(first!.amounts).toEqual({ after: 0, in: 0, out: 3 });
    expect(second!.amounts).toEqual({ after: 3, in: 0, out: 0 });
  });

  it("pulls from a pool on its own, as an automatic pull-any node", () => {
    const m = model(
      [pool("in", 5), gate("g", "deterministic"), pool("out", 0)],
      [flow("in", "g", "2"), flow("g", "out")],
    );
    expect(run(m, 3).map((r) => r.amounts.out)).toEqual([2, 4, 5]);
  });

  it("a random gate is reproducible per seed and roughly follows its weights", () => {
    const m = model(
      [source("s", 10), gate("g", "random"), pool("a", 0), pool("b", 0)],
      [flow("s", "g"), flow("g", "a", "1"), flow("g", "b", "3")],
    );
    expect(run(m, 50, 4)).toEqual(run(m, 50, 4));
    expect(run(m, 50, 4)).not.toEqual(run(m, 50, 5));
    const final = run(m, 100, 4).at(-1)!.amounts;
    expect(final.a! + final.b!).toBe(1000);
    expect(final.b! / 1000).toBeGreaterThan(0.7);
    expect(final.b! / 1000).toBeLessThan(0.8);
  });

  it("a condition gate shares among true outputs and loses what has nowhere to go", () => {
    const m = model(
      [source("s", 4), gate("g", "condition"), pool("small", 0), pool("big", 0)],
      [flow("s", "g", "4"), flow("g", "small", "self < 3"), flow("g", "big", "self > 10")],
    );
    const [first] = run(m, 1);
    expect(first!.amounts).toEqual({ big: 0, small: 0 });
    expect(first!.gateLoss).toEqual({ g: 4 });

    const split = model(
      [source("s", 4), gate("g", "condition"), pool("x", 0), pool("y", 0)],
      [flow("s", "g", "4"), flow("g", "x", "self >= 4"), flow("g", "y")],
    );
    expect(run(split, 1)[0]!.amounts).toEqual({ x: 2, y: 2 });
  });

  it("counts deliveries a full target refuses as gate loss", () => {
    const m = model(
      [source("s", 5), gate("g", "deterministic"), pool("p", 0, { capacity: 3 })],
      [flow("s", "g", "5"), flow("g", "p")],
    );
    const [first] = run(m, 1);
    expect(first!.amounts).toEqual({ p: 3 });
    expect(first!.gateLoss).toEqual({ g: 2 });
  });

  it("routes chained gates in order within one step", () => {
    const m = model(
      [source("s", 2), gate("g1", "deterministic"), gate("g2", "deterministic"), pool("p", 0)],
      [flow("s", "g1", "2"), flow("g1", "g2"), flow("g2", "p")],
    );
    expect(run(m, 1)[0]!.amounts).toEqual({ p: 2 });
  });

  it("rejects a cycle made only of gates", () => {
    const created = createEngine(
      model([gate("a", "random"), gate("b", "random")], [flow("a", "b"), flow("b", "a")]),
    );
    expect(created).toEqual({
      ok: false,
      errors: [{ path: "edges", message: "gates form a cycle: a, b" }],
    });
  });
});

describe("delays", () => {
  it("takes resources in step t and delivers them in phase 1 of step t + 3", () => {
    const m = model([pool("a", 5), pool("b", 0)], [flow("a", "b", "5", { delay: 3 })]);
    const records = run(m, 4);
    expect(records.map((r) => [r.amounts.a, r.amounts.b, r.inTransit])).toEqual([
      [0, 0, 5],
      [0, 0, 5],
      [0, 0, 5],
      [0, 5, 0],
    ]);
    expect(records[3]!.arrivals).toEqual({ b: 5 });
  });

  it("checks capacity on arrival, not when sent", () => {
    const m = model(
      [pool("a", 5, { act: "push" }), pool("b", 4, { capacity: 6, activation: "passive" })],
      [flow("a", "b", "5", { delay: 1 })],
    );
    const [first, second] = run(m, 2);
    expect(first!.amounts).toEqual({ a: 0, b: 4 });
    expect(second!.arrivals).toEqual({ b: 2 });
    expect(second!.capacityLoss).toEqual({ b: 3 });
  });
});

describe("determinism with gates, converters and delays", () => {
  const busy = model(
    [
      source("mine", 3),
      gate("split", "random"),
      gate("fair", "deterministic"),
      pool("ore", 2, { capacity: 15 }),
      pool("scrap", 0),
      pool("bars", 0, { capacity: 9 }),
      pool("bank", 0),
      converter("smelt", [["ore", 2]], [["bars", 1]], { maxActivationsPerStep: 2 }),
      converter("sell", [["bars", 1]], [["bank", 3]]),
    ],
    [
      flow("mine", "split", "dice(1, 4)"),
      flow("split", "ore", "3"),
      flow("split", "fair", "1"),
      flow("fair", "scrap", "1"),
      flow("fair", "bank", "1", { delay: 2 }),
      flow("scrap", "bank", "1/2", { delay: 1 }),
    ],
  );

  it("gives an identical trace when nodes and edges are reordered", () => {
    const reordered = {
      ...busy,
      nodes: [...busy.nodes].reverse(),
      edges: [...busy.edges].reverse(),
    };
    for (let seed = 1; seed <= 5; seed++) {
      expect(JSON.stringify(run(reordered, 40, seed))).toBe(JSON.stringify(run(busy, 40, seed)));
    }
  });

  it("keeps amounts whole, non-negative and within capacity", () => {
    for (const r of run(busy, 40, 2)) {
      for (const amount of Object.values(r.amounts))
        expect(Number.isInteger(amount) && amount >= 0).toBe(true);
      expect(r.amounts.ore).toBeLessThanOrEqual(15);
      expect(r.amounts.bars).toBeLessThanOrEqual(9);
    }
  });
});
