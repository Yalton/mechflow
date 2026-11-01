import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/sim/engine.js";
import { createRng } from "../../src/sim/rng.js";
import type { EngineOptions, StepInput, StepRecord } from "../../src/sim/types.js";
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
const flow = (from: string, to: string, rate?: string): Edge => ({
  id: `${from}_${to}`,
  kind: "flow",
  from,
  to,
  ...(rate !== undefined ? { rate } : {}),
});
const state = (from: string, to: string, extra: Partial<Edge> = {}): Edge => ({
  id: `${from}-${to}`,
  kind: "state",
  from,
  to,
  ...extra,
});

function run(
  m: Model,
  steps: number,
  seed = 1,
  options: EngineOptions = {},
  inputs: Record<number, StepInput> = {},
): StepRecord[] {
  const created = createEngine(m, options);
  if (!created.ok) throw new Error(JSON.stringify(created.errors));
  const rng = createRng(seed);
  let current = created.engine.initialState(rng);
  const records: StepRecord[] = [];
  for (let i = 1; i <= steps; i++) {
    const next = created.engine.step(current, rng, inputs[i]);
    current = next.state;
    records.push(next.record);
  }
  return records;
}

describe("conditions", () => {
  it("keeps a node inactive until its source reaches the threshold", () => {
    const m = model(
      [
        source("tick", 1),
        pool("count", 0),
        source("bonus", 5),
        pool("bank", 0, { activation: "passive" }),
      ],
      [
        flow("tick", "count"),
        flow("bonus", "bank"),
        state("count", "bonus", { strength: "gate", rate: "self >= 3" }),
      ],
    );
    // Conditions read the start-of-step state: count is 3 at the start of step 4.
    expect(run(m, 5).map((r) => r.amounts.bank)).toEqual([0, 0, 0, 5, 10]);
  });

  it("defaults to self > 0 for + and self == 0 for -", () => {
    const m = model(
      [
        pool("key", 0),
        source("open", 1),
        pool("in", 0, { activation: "passive" }),
        source("closed", 1),
        pool("out", 0, { activation: "passive" }),
        source("give", 1),
      ],
      [
        flow("give", "key"),
        flow("open", "in"),
        flow("closed", "out"),
        state("key", "open", { strength: "gate" }),
        state("key", "closed", { strength: "gate", polarity: "-" }),
      ],
    );
    expect(run(m, 3).map((r) => [r.amounts.in, r.amounts.out])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });

  it("stops a gate taking anything in", () => {
    const m = model(
      [
        pool("in", 5),
        { id: "g", kind: "gate", name: "g", mode: "deterministic" },
        pool("out", 0, { activation: "passive" }),
        pool("switch", 0),
      ],
      [flow("in", "g", "1"), flow("g", "out"), state("switch", "g", { strength: "gate" })],
    );
    expect(run(m, 2).map((r) => r.amounts)).toEqual([
      { in: 5, out: 0, switch: 0 },
      { in: 5, out: 0, switch: 0 },
    ]);
  });
});

describe("triggers", () => {
  it("fires along a chain one hop per step", () => {
    const m = model(
      [
        source("clock", 1),
        pool("a", 0),
        source("s2", 1, { activation: "passive" }),
        pool("b", 0, { activation: "passive" }),
        source("s3", 1, { activation: "passive" }),
        pool("c", 0, { activation: "passive" }),
      ],
      [
        flow("clock", "a"),
        flow("s2", "b"),
        flow("s3", "c"),
        state("clock", "s2", { strength: "trigger" }),
        state("s2", "s3", { strength: "trigger" }),
      ],
    );
    const records = run(m, 4);
    expect(records.map((r) => [r.amounts.a, r.amounts.b, r.amounts.c])).toEqual([
      [1, 0, 0],
      [2, 1, 0],
      [3, 2, 1],
      [4, 3, 2],
    ]);
    expect(records[0]!.triggered).toEqual(["s2"]);
    expect(records[1]!.triggered).toEqual(["s2", "s3"]);
  });

  it("fires only when the source moved all it asked for", () => {
    const m = model(
      [
        pool("stock", 3),
        pool("taker", 0),
        source("bell", 1, { activation: "passive" }),
        pool("rings", 0, { activation: "passive" }),
      ],
      [
        flow("stock", "taker", "2"),
        flow("bell", "rings"),
        state("taker", "bell", { strength: "trigger" }),
      ],
    );
    // taker gets 2, then only 1 of 2, then nothing of 2.
    expect(run(m, 4).map((r) => r.amounts.rings)).toEqual([0, 1, 1, 1]);
  });
});

describe("modifiers", () => {
  it("node modifiers follow the source's change and clamp to capacity", () => {
    const m = model(
      [source("s", 2), pool("a", 0), pool("b", 0, { capacity: 5, activation: "passive" })],
      [flow("s", "a"), state("a", "b")],
    );
    const records = run(m, 4);
    expect(records.map((r) => r.amounts.b)).toEqual([2, 4, 5, 5]);
    expect(records.map((r) => r.modified)).toEqual([{ b: 2 }, { b: 2 }, { b: 1 }, {}]);
  });

  it("node modifiers with - polarity clamp at 0 and keep fractions", () => {
    const m = model(
      [
        source("s", 1),
        pool("a", 0),
        pool("b", 2, { activation: "passive" }),
        pool("c", 0, { activation: "passive" }),
      ],
      [flow("s", "a"), state("a", "b", { polarity: "-" }), state("a", "c", { multiplier: "1/2" })],
    );
    expect(run(m, 4).map((r) => [r.amounts.b, r.amounts.c])).toEqual([
      [1, 0],
      [0, 1],
      [0, 1],
      [0, 2],
    ]);
  });

  it("label modifiers shift a source's rate by the source value", () => {
    const m = model(
      [pool("level", 3, { activation: "passive" }), source("s", 1), pool("a", 0)],
      [flow("s", "a"), state("level", "s", { multiplier: "2" })],
    );
    expect(run(m, 2).map((r) => r.amounts.a)).toEqual([7, 14]);
  });
});

describe("interactive nodes", () => {
  const button = model(
    [source("press", 1, { activation: "interactive" }), pool("hits", 0, { activation: "passive" })],
    [flow("press", "hits")],
  );
  const hits = (records: StepRecord[]): number[] => records.map((r) => r.amounts.hits!);

  it("never fires by default, always or on listed steps when asked", () => {
    expect(hits(run(button, 3))).toEqual([0, 0, 0]);
    expect(hits(run(button, 3, 1, { interactive: { press: "always" } }))).toEqual([1, 2, 3]);
    expect(hits(run(button, 4, 1, { interactive: { press: [2, 4] } }))).toEqual([0, 1, 1, 2]);
  });

  it("a probability schedule is reproducible per seed", () => {
    const options = { interactive: { press: 0.5 } };
    const fires = (seed: number): string =>
      run(button, 40, seed, options)
        .map((r) => (r.fired.length > 0 ? "x" : "."))
        .join("");
    expect(fires(3)).toBe(fires(3));
    expect(fires(3)).not.toBe(fires(4));
    expect(fires(3)).toContain("x");
    expect(fires(3)).toContain(".");
  });

  it("records a fire by hand without shifting later draws", () => {
    const options = { interactive: { press: 0.5 } };
    const plain = run(button, 10, 7, options);
    const byHand = run(button, 10, 7, options, { 2: { fire: ["press"] } });
    expect(byHand[1]!.firedByHand).toEqual(["press"]);
    expect(byHand[1]!.fired).toEqual(["press"]);
    const firedSteps = (records: StepRecord[]): number[] =>
      records.filter((r) => r.fired.length > 0).map((r) => r.step);
    expect(firedSteps(byHand)).toEqual(
      [...new Set([...firedSteps(plain), 2])].sort((a, b) => a - b),
    );
  });

  it("refuses to fire a node that is not interactive", () => {
    const created = createEngine(button);
    if (!created.ok) throw new Error("model");
    const rng = createRng(1);
    expect(() =>
      created.engine.step(created.engine.initialState(rng), rng, { fire: ["hits"] }),
    ).toThrow('cannot fire "hits": it is not an interactive node');
  });

  it("rejects bad schedules", () => {
    const created = createEngine(button, { interactive: { hits: "always", press: 2 } });
    expect(created).toEqual({
      ok: false,
      errors: [
        { path: "options.interactive.hits", message: '"hits" is not an interactive node' },
        {
          path: "options.interactive.press",
          message: "a firing probability must be between 0 and 1",
        },
      ],
    });
  });
});

describe("end conditions", () => {
  it("names the conditions that hold after a step", () => {
    const m = model(
      [source("s", 4), pool("bank", 0, { activation: "passive" })],
      [flow("s", "bank")],
      {
        endConditions: [
          { id: "rich", description: "Enough saved", expr: "bank >= 10" },
          { id: "broke", description: "Nothing left", expr: "bank < 0" },
        ],
      },
    );
    expect(run(m, 3).map((r) => r.ended)).toEqual([[], [], ["rich"]]);
  });

  it("reports an invalid end condition formula", () => {
    const created = createEngine(
      model([], [], { endConditions: [{ id: "x", description: "", expr: "1 +" }] }),
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.errors[0]!.path).toBe("endConditions.0.expr");
  });
});

it("gives an identical trace with state edges when nodes and edges are reordered", () => {
  const m = model(
    [
      source("s", 3),
      pool("a", 0, { capacity: 20 }),
      pool("b", 4, { activation: "passive" }),
      source("press", 2, { activation: "interactive" }),
      pool("c", 0, { activation: "passive" }),
      source("bell", 1, { activation: "passive" }),
    ],
    [
      flow("s", "a", "dice(1, 3)"),
      flow("press", "c"),
      flow("bell", "b"),
      state("a", "b", { multiplier: "dice(1, 4) / 4" }),
      state("b", "press", { strength: "gate", rate: "self < 30" }),
      state("press", "bell", { strength: "trigger" }),
      state("b", "s", { polarity: "-", multiplier: "1/4" }),
    ],
  );
  const reordered = { ...m, nodes: [...m.nodes].reverse(), edges: [...m.edges].reverse() };
  const options = { interactive: { press: 0.3 } };
  for (let seed = 1; seed <= 5; seed++) {
    expect(JSON.stringify(run(reordered, 30, seed, options))).toBe(
      JSON.stringify(run(m, 30, seed, options)),
    );
  }
});
