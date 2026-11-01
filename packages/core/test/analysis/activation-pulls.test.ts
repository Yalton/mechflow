import { describe, expect, it } from "vitest";
import type { Model } from "../../src/model/types.js";
import { analyzeModel } from "../../src/analysis/report.js";

function model(activation: "onStart" | "interactive" | "automatic", poolActivation?: "automatic" | "passive", act?: "pull" | "push"): Model {
  return {
    version: 1, name: "Pull test", properties: [], subsystems: [], noInteraction: [], invariants: [],
    nodes: [
      { id: "bonus", kind: "source", name: "Head start", rate: 10, activation },
      { id: "gear", kind: "pool", name: "Gear", start: 0, activation: poolActivation, act },
    ],
    edges: [{ id: "bonus_to_gear", kind: "flow", from: "bonus", to: "gear", rate: "10" }],
  };
}

describe("activation-pulls analysis", () => {
  it.each(["onStart", "interactive"] as const)("warns when an %s source feeds an automatic pulling pool", (activation) => {
    const report = analyzeModel(model(activation), { checks: ["activation-pulls"] });
    expect(report.findings).toEqual([expect.objectContaining({
      id: "activation-pulls:bonus_to_gear", severity: "warning",
      nodes: ["bonus", "gear"], edges: ["bonus_to_gear"],
    })]);
    expect(report.findings[0]!.detail).toContain("gate this flow edge's rate");
    expect(report.summary.warnings).toBe(1);
  });

  it("does not warn for a passive or pushing pool, or an automatic source", () => {
    for (const candidate of [
      model("onStart", "passive"), model("interactive", "automatic", "push"), model("automatic"),
    ]) {
      expect(analyzeModel(candidate, { checks: ["activation-pulls"] }).findings).toEqual([]);
    }
  });
});
