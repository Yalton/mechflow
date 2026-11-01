import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseModelYaml } from "../../src/model/io.js";
import type { Model } from "../../src/model/types.js";
import { compareSystems, type SystemsOptions } from "../../src/search/systems.js";

function example(name: string): Model {
  const parsed = parseModelYaml(
    readFileSync(new URL(`../../../../fixtures/examples/${name}.yaml`, import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.model;
}

const options: SystemsOptions = { objective: "wealth", seed: 1, steps: 20, runs: 4 };

function compare(model: Model, extra: Partial<SystemsOptions> = {}) {
  const result = compareSystems(model, { ...options, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.result;
}

describe("system dominance", () => {
  it("flags trade making combat and crafting obsolete", () => {
    const { findings, report } = compare(example("obsolete"));
    expect(findings.map((f) => f.id)).toEqual(["search-system-dominance:trade"]);
    expect(findings[0]!.nodes).toEqual(["haggle"]);
    const trade = report.subsystems.find((s) => s.subsystem === "trade")!;
    expect(trade.share).toBeGreaterThanOrEqual(0.95);
    expect(report.subsystems.map((s) => s.subsystem)).toEqual(["combat", "crafting", "trade"]);
  });

  it("does not flag subsystems that each add value", () => {
    const model = example("obsolete");
    // Give every subsystem its own stamina, so combining them pays.
    for (const id of ["fight", "forge"]) {
      const node = model.nodes.find((n) => n.id === id)!;
      if (node.kind === "converter") node.inputs = [];
      if (node.kind === "converter") node.outputs = [{ resource: "gold", amount: 9 }];
    }
    expect(compare(model).findings).toEqual([]);
  });

  it("keeps within the evaluation budget", () => {
    const { evaluationsUsed } = compare(example("obsolete"), { maxEvaluations: 12 });
    expect(evaluationsUsed).toBeLessThanOrEqual(12);
  });

  it("needs two subsystems to compare", () => {
    const { findings, report } = compare(example("combo"), { steps: 10 });
    expect(findings).toEqual([]);
    expect(report.subsystems).toHaveLength(1);
  });
});
