import { describe, expect, it } from "vitest";
import type { Report } from "../../src/analysis/report.js";
import { analyzeModel, hashModel } from "../../src/analysis/report.js";
import { findGhostEdges } from "../../src/analysis/ghost-edges.js";
import { loadExample } from "../helpers.js";

function ids(report: Report): string[] {
  return report.findings.map((f) => f.id);
}

describe("analyzeModel - infinite-loop", () => {
  const report = analyzeModel(loadExample("infinite-loop"));

  it("flags the uncapped conversion loop as an error", () => {
    expect(report.summary.errors).toBe(1);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ id: "infinite-loops:a,b,c", severity: "error" }),
    );
  });

  it("attributes the finding to the infinite-loops check", () => {
    expect(report.summary.byCheck["infinite-loops"]).toEqual({
      errors: 1,
      warnings: 0,
      infos: 0,
    });
  });
});

describe("analyzeModel - elements", () => {
  const report = analyzeModel(loadExample("elements"));

  it("finds the fire/water ghost edge", () => {
    expect(ids(report)).toContain("ghost-edges:fire,water");
  });

  it("flags isolated mechanics with stable ids", () => {
    const isolated = ids(report).filter((id) => id.startsWith("interaction-matrix:isolated:"));
    expect(isolated).toEqual(
      ["interaction-matrix:isolated:electricity", "interaction-matrix:isolated:ice", "interaction-matrix:isolated:water"].sort(),
    );
  });

  it("names the property links of a mechanic with no interaction edges instead of calling it isolated", () => {
    const electricity = report.findings.find((f) => f.id === "interaction-matrix:isolated:electricity")!;
    expect(electricity.title).toBe('Mechanic "Electricity" has no declared interactions');
    expect(electricity.detail).toContain("reads wetness, which Water writes");
    expect(electricity.detail).toContain("uses conductive, which Metal Door has");
  });

  it("still calls a mechanic isolated when nothing links it", () => {
    const model = loadExample("elements");
    model.nodes.push({ id: "lone", kind: "mechanic", name: "Lone", reads: [], writes: [] });
    const lone = analyzeModel(model).findings.find((f) => f.id === "interaction-matrix:isolated:lone")!;
    expect(lone.title).toBe('Mechanic "Lone" is isolated (no interaction edges)');
  });

  it("reports coupling across subsystems", () => {
    expect(ids(report)).toContain("coupling:temperature");
  });

  it("does not flag a pair covered by a noInteraction record", () => {
    const ghost = findGhostEdges(loadExample("elements"));
    const asId = (a: string, b: string) => [a, b].sort().join(",");
    expect(ghost.some((g) => asId(g.a, g.b) === asId("ice", "metal_door"))).toBe(false);
  });
});

describe("analyzeModel - ring", () => {
  const report = analyzeModel(loadExample("ring"));

  it("flags a single reinforcing feedback loop", () => {
    expect(report.summary.byCheck["feedback-loops"]).toEqual({
      errors: 0,
      warnings: 1,
      infos: 0,
    });
    expect(ids(report)).toContain("feedback-loops:p1,p2,p3,p4,p5");
  });
});

describe("analyzeModel - hub-spoke", () => {
  const report = analyzeModel(loadExample("hub-spoke"));

  it("flags the market as a single point of dependency", () => {
    expect(ids(report)).toContain("bottlenecks:market");
  });
});

describe("analyzeModel - multiplier", () => {
  const report = analyzeModel(loadExample("multiplier"));

  it("flags an unbounded multiplier chain (references self)", () => {
    expect(ids(report)).toContain("multipliers:a_to_b,b_to_c,c_to_d");
  });

  it("flags a chain whose product exceeds the threshold", () => {
    expect(ids(report)).toContain("multipliers:e_to_f,f_to_g");
  });
});

describe("analyzeModel - dag", () => {
  it("produces no findings for an acyclic model", () => {
    const report = analyzeModel(loadExample("dag"));
    expect(report.summary.errors + report.summary.warnings + report.summary.infos).toBe(0);
  });
});

describe("hashModel", () => {
  it("is stable for the same model and changes when the model changes", () => {
    const dag = loadExample("dag");
    expect(hashModel(dag)).toBe(hashModel(dag));
    expect(hashModel(dag)).not.toBe(hashModel(loadExample("ring")));
  });
});
