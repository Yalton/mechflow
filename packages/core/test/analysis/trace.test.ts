import { describe, expect, it } from "vitest";
import { traceEffects } from "../../src/analysis/trace.js";
import { loadExample } from "../helpers.js";

describe("traceEffects", () => {
  const model = loadExample("elements");
  const result = traceEffects(model, "fire", 2);

  const atDepth = (depth: number) =>
    result.levels.find((l) => l.depth === depth)?.nodes.map((n) => n.id) ?? [];

  it("reaches wood via the direct interaction edge at depth 1", () => {
    const wood = result.levels[1].nodes.find((n) => n.id === "wood");
    expect(wood?.via).toBe("fire_to_wood");
  });

  it("reaches water and ice through shared properties at depth 1", () => {
    const depth1 = atDepth(1);
    expect(depth1).toContain("water");
    expect(depth1).toContain("ice");
  });

  it("reaches electricity at depth 2 via wetness", () => {
    const electricity = result.levels[2].nodes.find((n) => n.id === "electricity");
    expect(electricity?.via).toBe("property:wetness");
  });

  it("never revisits a node (no infinite loop on cyclic graphs)", () => {
    const allIds = result.levels.flatMap((l) => l.nodes.map((n) => n.id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
