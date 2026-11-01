import { describe, expect, it } from "vitest";
import { createRun, simulate } from "../../src/index.js";
import type { Edge, Model, Node } from "../../src/model/types.js";
import { listExamples, loadExample } from "../helpers.js";

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

const saver = model(
  [
    { id: "s", kind: "source", name: "s", rate: 4 },
    { id: "bank", kind: "pool", name: "bank", start: 0 },
  ],
  [{ id: "pay", kind: "flow", from: "s", to: "bank" }],
);

describe("simulate", () => {
  it("runs every example for 50 steps with seed 1", () => {
    for (const file of listExamples()) {
      const result = simulate(loadExample(file.replace(/\.yaml$/, "")), { seed: 1, steps: 50 });
      expect(result, file).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.trace.end?.reason, file).not.toBe("error");
    }
  });

  it("gives a stable trace for the economy example", () => {
    const result = simulate(loadExample("economy"), { seed: 1, steps: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trace).toMatchSnapshot();
  });

  it("stops after the requested steps", () => {
    const result = simulate(saver, { seed: 1, steps: 3 });
    if (!result.ok) throw new Error("run");
    expect(result.trace.steps.map((s) => s.amounts.bank)).toEqual([4, 8, 12]);
    expect(result.trace.initial).toEqual({ amounts: { bank: 0 }, registers: {} });
    expect(result.trace.end).toEqual({ reason: "steps", step: 3 });
  });

  it("stops at the first step an end condition holds and names it", () => {
    const m = {
      ...saver,
      endConditions: [{ id: "rich", description: "Saved enough", expr: "bank >= 10" }],
    };
    const result = simulate(m, { seed: 1, steps: 100 });
    if (!result.ok) throw new Error("run");
    expect(result.trace.steps).toHaveLength(3);
    expect(result.trace.end).toEqual({ reason: "endCondition", step: 3, conditions: ["rich"] });
  });

  it("collects invariant violations with their steps", () => {
    const m = {
      ...saver,
      invariants: [{ id: "small", description: "Bank stays small", expr: "bank < 9" }],
    };
    const result = simulate(m, { seed: 1, steps: 4 });
    if (!result.ok) throw new Error("run");
    expect(result.trace.invariantViolations).toEqual([
      { invariant: "small", step: 3 },
      { invariant: "small", step: 4 },
    ]);
  });

  it("ends with the reason when a formula fails mid-run", () => {
    const m = model(
      [
        { id: "s", kind: "source", name: "s", rate: 1 },
        { id: "bank", kind: "pool", name: "bank", start: 0 },
      ],
      [{ id: "pay", kind: "flow", from: "s", to: "bank", rate: "dice(1, 2 - bank)" }],
    );
    const result = simulate(m, { seed: 1, steps: 10 });
    if (!result.ok) throw new Error("run");
    expect(result.trace.end).toMatchObject({
      reason: "error",
      step: result.trace.steps.length + 1,
    });
  });

  it("returns option and model errors as data", () => {
    expect(simulate(saver, { seed: 1.5 } as never)).toEqual({
      ok: false,
      errors: [
        { path: "options.steps", message: "steps is required" },
        { path: "options.seed", message: "seed must be a whole number" },
      ],
    });
    expect(simulate(saver, { seed: 1, steps: 0 })).toMatchObject({
      ok: false,
      errors: [{ path: "options.steps" }],
    });
    const broken = simulate({ ...saver, nodes: [] }, { seed: 1, steps: 1 });
    expect(broken.ok).toBe(false);
    expect(simulate(saver, { seed: 1, steps: 1, interactive: { bank: "always" } })).toMatchObject({
      ok: false,
      errors: [{ path: "options.interactive.bank" }],
    });
  });

  it("is the same run whether simulated or stepped", () => {
    const created = createRun(loadExample("economy"), { seed: 9, steps: 15 });
    if (!created.ok) throw new Error("run");
    while (created.run.step() !== null);
    expect(created.run.trace).toEqual(
      (simulate(loadExample("economy"), { seed: 9, steps: 15 }) as { trace: unknown }).trace,
    );
  });
});

describe("createRun", () => {
  const button = model(
    [
      { id: "press", kind: "source", name: "press", rate: 1, activation: "interactive" },
      { id: "hits", kind: "pool", name: "hits", start: 0, activation: "passive" },
    ],
    [{ id: "push", kind: "flow", from: "press", to: "hits" }],
  );

  it("fires a node by hand in the next step only, and records it", () => {
    const created = createRun(button, { seed: 1 });
    if (!created.ok) throw new Error("run");
    const { run } = created;
    run.step();
    expect(run.fire("press")).toBeNull();
    expect(run.step()!.firedByHand).toEqual(["press"]);
    run.step();
    expect(run.trace.steps.map((s) => s.amounts.hits)).toEqual([0, 1, 1]);
    expect(run.state.step).toBe(3);
    expect(run.trace.end).toBeUndefined();
  });

  it("refuses to fire a node that is not interactive", () => {
    const created = createRun(button, { seed: 1 });
    if (!created.ok) throw new Error("run");
    expect(created.run.fire("hits")).toEqual({
      path: "fire",
      message: 'cannot fire "hits": it is not an interactive node',
    });
  });

  it("returns null once the run has ended", () => {
    const created = createRun(button, { seed: 1, steps: 1 });
    if (!created.ok) throw new Error("run");
    expect(created.run.step()).not.toBeNull();
    expect(created.run.step()).toBeNull();
    expect(created.run.trace.steps).toHaveLength(1);
  });
});
