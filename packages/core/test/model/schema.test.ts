import { describe, expect, it } from "vitest";
import { validateModel } from "../../src/model/schema.js";
import type { Model } from "../../src/model/types.js";

function base(): Model {
  return {
    version: 1,
    name: "M",
    properties: [],
    subsystems: [],
    nodes: [{ id: "p", kind: "pool", name: "P", start: 0 }],
    edges: [],
    noInteraction: [],
    invariants: [],
  };
}

function model(overrides: Record<string, unknown>): unknown {
  return { ...base(), ...overrides };
}

describe("validateModel", () => {
  it("accepts a minimal valid model", () => {
    const r = validateModel(base());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.name).toBe("M");
  });

  it("rejects a missing required field with a path containing the field name", () => {
    const r = validateModel(model({ name: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.errors.some((e) => e.path.includes("name"))).toBe(true);
  });

  it("rejects a missing version literal", () => {
    const r = validateModel(model({ version: 2 as unknown }));
    expect(r.ok).toBe(false);
  });

  it("rejects a duplicate node id", () => {
    const r = validateModel(
      model({
        nodes: [
          { id: "p", kind: "pool", name: "P", start: 0 },
          { id: "p", kind: "pool", name: "P2", start: 0 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /duplicate/i.test(e.message))).toBe(true);
  });

  it("rejects an edge pointing at an unknown node", () => {
    const r = validateModel(
      model({
        edges: [{ id: "e", kind: "flow", from: "p", to: "ghost" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /unknown node/i.test(e.message))).toBe(true);
  });

  it("rejects an invalid node kind", () => {
    const r = validateModel(
      model({
        nodes: [{ id: "p", kind: "notakind", name: "P", start: 0 }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a noInteraction referencing a non-mechanic / non-entity node", () => {
    const r = validateModel(
      model({
        noInteraction: [{ a: "p", b: "p", reason: "x" }],
      }),
    );
    expect(r.ok).toBe(false);
  });
});
