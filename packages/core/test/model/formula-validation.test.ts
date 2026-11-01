import { describe, expect, it } from "vitest";
import { validateModel } from "../../src/model/schema.js";
import type { Edge, Model, Node } from "../../src/model/types.js";

/** A model whose formula fields (register formula, edge rate, invariant expr) are all valid. */
function base(): Model {
  return {
    version: 1,
    name: "M",
    properties: [],
    subsystems: [],
    nodes: [
      { id: "p", kind: "pool", name: "P", start: 0 },
      { id: "r", kind: "register", name: "R", formula: "self + p" },
    ],
    edges: [{ id: "e", kind: "flow", from: "p", to: "r", rate: "p * 2" }],
    noInteraction: [],
    invariants: [{ id: "i", description: "stays positive", expr: "self > 0" }],
  };
}

function withNodes(nodes: Node[]): unknown {
  return { ...base(), nodes };
}

function withEdges(edges: Edge[]): unknown {
  return { ...base(), edges };
}

function withInvariants(invariants: Model["invariants"]): unknown {
  return { ...base(), invariants };
}

/** Find the first error whose joined path equals `path`. */
function errorAt(errors: { path: string; message: string }[], path: string) {
  return errors.find((e) => e.path === path);
}

describe("validateModel formula validation", () => {
  it("accepts valid formulas referencing existing nodes", () => {
    expect(validateModel(base()).ok).toBe(true);
  });

  it("treats 'self' as a reference, not a node id", () => {
    const r = validateModel(
      withNodes([
        { id: "p", kind: "pool", name: "P", start: 0 },
        { id: "r", kind: "register", name: "R", formula: "self" },
      ]),
    );
    expect(r.ok).toBe(true);
  });

  it("reports a parse error in a register formula with the field path and offset", () => {
    const r = validateModel(withNodes([
      { id: "p", kind: "pool", name: "P", start: 0 },
      { id: "r", kind: "register", name: "R", formula: "p +" },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = errorAt(r.errors, "nodes.1.formula");
      expect(err).toBeDefined();
      expect(err?.message).toMatch(/offset \d+/);
    }
  });

  it("reports a parse error in an edge rate with the field path and offset", () => {
    const r = validateModel(withEdges([
      { id: "e", kind: "flow", from: "p", to: "r", rate: "p *" },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = errorAt(r.errors, "edges.0.rate");
      expect(err).toBeDefined();
      expect(err?.message).toMatch(/offset \d+/);
    }
  });

  it("reports an unknown reference in an edge multiplier", () => {
    const r = validateModel(withEdges([
      { id: "e", kind: "flow", from: "p", to: "r", multiplier: "ghost * 2" },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = errorAt(r.errors, "edges.0.multiplier");
      expect(err).toBeDefined();
      expect(err?.message).toContain("ghost");
    }
  });

  it("reports an unknown reference in an invariant expr", () => {
    const r = validateModel(withInvariants([
      { id: "i", description: "d", expr: "ghost > 0" },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = errorAt(r.errors, "invariants.0.expr");
      expect(err).toBeDefined();
      expect(err?.message).toContain("ghost");
    }
  });

  it("reports every unknown reference in a formula", () => {
    const r = validateModel(withNodes([
      { id: "p", kind: "pool", name: "P", start: 0 },
      { id: "r", kind: "register", name: "R", formula: "a + b" },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const refs = r.errors.filter((e) => e.path === "nodes.1.formula").map((e) => e.message);
      expect(refs.some((m) => m.includes("a"))).toBe(true);
      expect(refs.some((m) => m.includes("b"))).toBe(true);
    }
  });

  it("accepts a formula that references only existing nodes", () => {
    const r = validateModel(withNodes([
      { id: "p", kind: "pool", name: "P", start: 0 },
      { id: "q", kind: "pool", name: "Q", start: 0 },
      { id: "r", kind: "register", name: "R", formula: "p + q" },
    ]));
    expect(r.ok).toBe(true);
  });
});
