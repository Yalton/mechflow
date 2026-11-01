import { describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../../src/sim/engine.js";
import { createRng } from "../../src/sim/rng.js";
import type { SimState, StepRecord } from "../../src/sim/types.js";
import type { Edge, Model, Node } from "../../src/model/types.js";

function model(nodes: Node[], edges: Edge[], extra: Partial<Model> = {}): Model {
  return {
    version: 1,
    name: "Sim",
    properties: [],
    subsystems: [],
    nodes,
    edges,
    noInteraction: [],
    invariants: [],
    ...extra,
  };
}

const pool = (id: string, start: number, extra: Partial<Node> = {}): Node =>
  ({ id, kind: "pool", name: id, start, ...extra }) as Node;
const source = (id: string, rate: number, extra: Partial<Node> = {}): Node =>
  ({ id, kind: "source", name: id, rate, ...extra }) as Node;
const drain = (id: string, rate: number, extra: Partial<Node> = {}): Node =>
  ({ id, kind: "drain", name: id, rate, ...extra }) as Node;
const flow = (from: string, to: string, rate?: string, extra: Partial<Edge> = {}): Edge => ({
  id: `${from}_${to}`,
  kind: "flow",
  from,
  to,
  ...(rate !== undefined ? { rate } : {}),
  ...extra,
});

function engineFor(m: Model): Engine {
  const created = createEngine(m);
  if (!created.ok) throw new Error(JSON.stringify(created.errors));
  return created.engine;
}

/** Run `steps` steps and return every step record. */
function run(m: Model, steps: number, seed = 1): StepRecord[] {
  const engine = engineFor(m);
  const rng = createRng(seed);
  let state = engine.initialState(rng);
  const records: StepRecord[] = [];
  for (let i = 0; i < steps; i++) {
    const next = engine.step(state, rng);
    state = next.state;
    records.push(next.record);
  }
  return records;
}

describe("competing flows", () => {
  it("shares a short pool proportionally between pull-any consumers", () => {
    const m = model(
      [pool("a", 5), pool("b", 0), pool("c", 0)],
      [flow("a", "b", "4"), flow("a", "c", "6")],
    );
    const [first] = run(m, 1);
    expect(first!.wanted).toEqual({ a_b: 4, a_c: 6 });
    expect(first!.moved).toEqual({ a_b: 2, a_c: 3 });
    expect(first!.amounts).toEqual({ a: 0, b: 2, c: 3 });
  });

  it("breaks an exact tie with the seeded shuffle, varying by seed", () => {
    const m = model([pool("a", 1), pool("b", 0), pool("c", 0)], [flow("a", "b"), flow("a", "c")]);
    const winners = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const { amounts } = run(m, 1, seed)[0]!;
      expect(amounts.b! + amounts.c!).toBe(1);
      winners.add(amounts.b === 1 ? "b" : "c");
    }
    expect(winners).toEqual(new Set(["b", "c"]));
  });

  it("never splits all-mode competitors, and the winner varies with the seed", () => {
    const m = model(
      [pool("a", 5), pool("b", 0, { flowMode: "all" }), pool("c", 0, { flowMode: "all" })],
      [flow("a", "b", "4"), flow("a", "c", "4")],
    );
    const winners = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const record = run(m, 1, seed)[0]!;
      const winner = record.amounts.b === 4 ? "b" : "c";
      const loser = winner === "b" ? "c" : "b";
      expect(record.amounts).toEqual({ a: 1, [winner]: 4, [loser]: 0 });
      expect(record.failed).toEqual([loser]);
      winners.add(winner);
    }
    expect(winners).toEqual(new Set(["b", "c"]));
  });

  it("an all-mode node moves every input in full or nothing", () => {
    const m = model(
      [pool("a", 5), pool("b", 1), pool("c", 0, { flowMode: "all" })],
      [flow("a", "c", "2"), flow("b", "c", "2")],
    );
    const [first] = run(m, 1);
    expect(first!.failed).toEqual(["c"]);
    expect(first!.amounts).toEqual({ a: 5, b: 1, c: 0 });
  });

  it("shares a short target's room and leaves the refused resources at the sources", () => {
    const m = model(
      [pool("a", 4), pool("b", 4), pool("p", 0, { capacity: 6 })],
      [flow("a", "p", "4"), flow("b", "p", "4")],
    );
    const [first] = run(m, 1);
    expect(first!.amounts).toEqual({ a: 1, b: 1, p: 6 });
  });

  it("counts the earlier group's share first: pull-all before pull-any", () => {
    const m = model(
      [pool("a", 3), pool("any", 0), pool("strict", 0, { flowMode: "all" })],
      [flow("a", "any", "3"), flow("a", "strict", "3")],
    );
    const [first] = run(m, 1);
    expect(first!.amounts).toEqual({ a: 0, any: 0, strict: 3 });
  });
});

describe("step order", () => {
  it("moves a resource along at most one edge per step", () => {
    const m = model(
      [pool("a", 10), pool("b", 0), pool("c", 0)],
      [flow("a", "b", "10"), flow("b", "c", "10")],
    );
    const [first, second] = run(m, 2);
    expect(first!.amounts).toEqual({ a: 0, b: 10, c: 0 });
    expect(second!.amounts).toEqual({ a: 0, b: 0, c: 10 });
  });

  it("drives an edge once even when the source pushes and the target pulls", () => {
    const m = model([source("s", 3), pool("p", 0)], [flow("s", "p")]);
    expect(run(m, 2).map((r) => r.amounts.p)).toEqual([3, 6]);
  });

  it("lets a push pool share its own amount among its outputs", () => {
    const m = model(
      [
        pool("a", 3, { act: "push" }),
        pool("b", 0, { activation: "passive" }),
        pool("c", 0, { activation: "passive" }),
      ],
      [flow("a", "b", "2"), flow("a", "c", "4")],
    );
    expect(run(m, 1)[0]!.amounts).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("drains pull at their node rate", () => {
    const m = model([pool("a", 5), drain("d", 2)], [flow("a", "d")]);
    expect(run(m, 3).map((r) => r.amounts.a)).toEqual([3, 1, 0]);
  });
});

describe("activation", () => {
  it("passive nodes do not act and onStart nodes act in step 1 only", () => {
    const m = model(
      [
        pool("a", 10),
        pool("lazy", 0, { activation: "passive" }),
        pool("once", 0, { activation: "onStart" }),
      ],
      [flow("a", "lazy"), flow("a", "once")],
    );
    expect(run(m, 3).map((r) => [r.amounts.lazy, r.amounts.once])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
  });
});

describe("rates", () => {
  it("moves 1 every third step for a rate of 1/3", () => {
    const m = model([source("s", 1), pool("p", 0)], [flow("s", "p", "1/3")]);
    expect(run(m, 9).map((r) => r.amounts.p)).toEqual([0, 0, 1, 1, 1, 2, 2, 2, 3]);
  });

  it("evaluates rates on the start-of-step state with self bound to the source", () => {
    const m = model([pool("a", 8), pool("b", 0)], [flow("a", "b", "self / 2")]);
    expect(run(m, 3).map((r) => r.amounts.a)).toEqual([4, 2, 1]);
  });

  it("scales arrivals by the multiplier", () => {
    const m = model([pool("a", 4), pool("b", 0)], [flow("a", "b", "3", { multiplier: "2.5" })]);
    expect(run(m, 1)[0]!.amounts).toEqual({ a: 1, b: 7 });
  });

  it("treats a negative rate as 0 and warns once per run", () => {
    const m = model([pool("a", 4), pool("b", 0)], [flow("a", "b", "0 - 2")]);
    const records = run(m, 3);
    expect(records.map((r) => r.amounts.b)).toEqual([0, 0, 0]);
    expect(records[0]!.warnings.map((w) => w.code)).toEqual(["negative-rate"]);
    expect(records[1]!.warnings).toEqual([]);
  });
});

describe("registers and invariants", () => {
  it("computes registers in dependency order each step", () => {
    const m = model(
      [
        pool("a", 2),
        pool("b", 0),
        { id: "double", kind: "register", name: "D", formula: "half * 4" },
        { id: "half", kind: "register", name: "H", formula: "a / 2" },
      ],
      [flow("a", "b", "double")],
    );
    const [first] = run(m, 1);
    expect(first!.registers).toEqual({ double: 4, half: 1 });
    expect(first!.amounts).toEqual({ a: 0, b: 2 });
  });

  it("rejects a register cycle before the run starts", () => {
    const m = model(
      [
        { id: "r1", kind: "register", name: "R1", formula: "r2 + 1" },
        { id: "r2", kind: "register", name: "R2", formula: "r1" },
        { id: "r3", kind: "register", name: "R3", formula: "r3 + 1" },
      ],
      [],
    );
    const created = createEngine(m);
    expect(created).toEqual({
      ok: false,
      errors: [{ path: "nodes", message: "registers form a cycle: r1, r2, r3" }],
    });
  });

  it("reports invariant violations after each step without stopping", () => {
    const m = model([pool("a", 4), pool("b", 0)], [flow("a", "b", "2")], {
      invariants: [{ id: "keep", description: "a keeps at least 1", expr: "a >= 1" }],
    });
    expect(run(m, 3).map((r) => r.invariantViolations)).toEqual([[], ["keep"], ["keep"]]);
  });
});

describe("determinism", () => {
  const busy = model(
    [
      source("mine", 3),
      pool("ore", 5, { capacity: 12 }),
      pool("left", 0, { flowMode: "all" }),
      pool("right", 0, { flowMode: "all" }),
      pool("bank", 1),
      pool("shop", 0, { capacity: 4 }),
      drain("tax", 1),
      { id: "luck", kind: "register", name: "Luck", formula: "dice(1, 3)" },
    ],
    [
      flow("mine", "ore", "luck"),
      flow("ore", "left", "2"),
      flow("ore", "right", "2"),
      flow("ore", "bank", "dice(1, 4) / 2"),
      flow("left", "shop", "1"),
      flow("right", "shop", "1"),
      flow("bank", "tax"),
      flow("bank", "shop", "1/2"),
    ],
  );

  it("gives the same trace for the same seed and a different one for another", () => {
    expect(run(busy, 30, 7)).toEqual(run(busy, 30, 7));
    expect(run(busy, 30, 7)).not.toEqual(run(busy, 30, 8));
  });

  it("gives an identical trace when nodes and edges are reordered", () => {
    const reordered = {
      ...busy,
      nodes: [...busy.nodes].reverse(),
      edges: [...busy.edges].reverse(),
    };
    const shuffled = {
      ...busy,
      nodes: createRng(99).shuffle(busy.nodes),
      edges: createRng(98).shuffle(busy.edges),
    };
    for (let seed = 1; seed <= 5; seed++) {
      const expected = JSON.stringify(run(busy, 30, seed));
      expect(JSON.stringify(run(reordered, 30, seed))).toBe(expected);
      expect(JSON.stringify(run(shuffled, 30, seed))).toBe(expected);
    }
  });

  it("does not mutate the state it is given", () => {
    const engine = engineFor(busy);
    const rng = createRng(3);
    const initial = engine.initialState(rng);
    const snapshot: SimState = JSON.parse(JSON.stringify(initial));
    engine.step(initial, rng);
    expect(initial).toEqual(snapshot);
  });

  it("keeps pool amounts non-negative integers and within capacity", () => {
    for (const record of run(busy, 50, 4)) {
      for (const amount of Object.values(record.amounts)) {
        expect(Number.isInteger(amount) && amount >= 0).toBe(true);
      }
      expect(record.amounts.ore).toBeLessThanOrEqual(12);
      expect(record.amounts.shop).toBeLessThanOrEqual(4);
    }
  });
});
