import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseModelYaml } from "../../src/model/io.js";
import type { Model } from "../../src/model/types.js";
import { possibilitySpace, type SpaceOptions } from "../../src/search/space.js";

function example(name: string): Model {
  const parsed = parseModelYaml(
    readFileSync(new URL(`../../../../fixtures/examples/${name}.yaml`, import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.model;
}

const options: SpaceOptions = { objective: "wealth", seed: 1, steps: 10, runs: 4 };

function space(model: Model, extra: Partial<SpaceOptions> = {}) {
  const result = possibilitySpace(model, { ...options, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.result;
}

describe("possibility space", () => {
  it("flags a space where only jewellery is viable", () => {
    const { findings, report } = space(example("narrow"));
    expect(report.candidates[0]!.label).toBe("focus:jeweller");
    expect(report.viableCount).toBe(1);
    expect(findings.map((f) => f.id)).toEqual(["search-narrow-space:space"]);
    expect(findings[0]!.nodes).toEqual(["jeweller"]);
  });

  it("re-scores the best under each knob's min and max", () => {
    const { report } = space(example("narrow"));
    expect(report.settings).toEqual(["defaults", "min(price)", "max(price)"]);
    expect(report.robust.length + report.specialists.length).toBeGreaterThan(0);
    for (const entry of [...report.robust, ...report.specialists]) {
      expect(Object.keys(entry.scores)).toEqual(report.settings);
    }
  });

  it("calls jewellery a specialist that depends on a high price", () => {
    const { report } = space(example("narrow"));
    const jeweller = report.specialists.find((s) => s.label === "focus:jeweller");
    expect(jeweller?.dependsOn).toBe("max(price)");
    expect(report.robust.map((r) => r.label)).not.toContain("focus:jeweller");
    expect(report.robust[0]!.worstCase).toBeGreaterThan(jeweller!.worstCase);
  });

  it("includes the model's strategies as candidates", () => {
    const model = example("narrow");
    model.strategies = [{ id: "smithing", description: "Smith only.", rules: [{ fire: "smith" }] }];
    const { report } = space(model);
    expect(report.candidates.map((c) => c.label)).toContain("strategy:smithing");
  });

  it("does not flag a space where several strategies are close", () => {
    const model = example("narrow");
    model.parameters![0]!.value = 6;
    expect(space(model).findings).toEqual([]);
  });

  it("keeps within the evaluation budget", () => {
    expect(space(example("narrow"), { maxEvaluations: 30 }).evaluationsUsed).toBeLessThanOrEqual(
      30,
    );
  });
});
