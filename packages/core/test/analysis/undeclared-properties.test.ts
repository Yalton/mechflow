import { describe, expect, it } from "vitest";
import type { Model } from "../../src/model/types.js";
import { analyzeModel } from "../../src/analysis/report.js";

function model(properties: string[]): Model {
  return {
    version: 1, name: "Property test", subsystems: [], noInteraction: [], invariants: [], edges: [],
    properties: properties.map((id) => ({ id, kind: "number" as const })),
    nodes: [
      { id: "ledger", kind: "mechanic", name: "Case ledger", reads: ["fee", "rate"], writes: ["total"] },
      { id: "payer", kind: "entity", name: "Payer", has: ["fee", "multiplier"] },
    ],
  };
}

describe("undeclared-properties analysis", () => {
  it("warns once per undeclared read, write and has", () => {
    const report = analyzeModel(model(["fee"]), { checks: ["undeclared-properties"] });
    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "undeclared-properties:ledger:reads:rate", severity: "warning",
        nodes: ["ledger"], edges: [], data: { relation: "reads", property: "rate" },
      }),
      expect.objectContaining({
        id: "undeclared-properties:ledger:writes:total", severity: "warning",
        nodes: ["ledger"], edges: [], data: { relation: "writes", property: "total" },
      }),
      expect.objectContaining({
        id: "undeclared-properties:payer:has:multiplier", severity: "warning",
        nodes: ["payer"], edges: [], data: { relation: "has", property: "multiplier" },
      }),
    ]);
    expect(report.findings[1]!.title).toBe('"Case ledger" writes undeclared property "total"');
    expect(report.findings[1]!.detail).toContain('Declare "total" under properties:');
    expect(report.summary.byCheck["undeclared-properties"]).toEqual({ errors: 0, warnings: 3, infos: 0 });
  });

  it("reports nothing when every referenced property is declared", () => {
    const report = analyzeModel(model(["fee", "rate", "total", "multiplier"]), { checks: ["undeclared-properties"] });
    expect(report.findings).toEqual([]);
  });
});
