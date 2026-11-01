import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseModelYaml } from "../../src/model/io.js";
import type { Model } from "../../src/model/types.js";
import { boundarySweep, stackEverything, type BoundaryOptions } from "../../src/search/boundary.js";

function example(name: string): Model {
  const parsed = parseModelYaml(
    readFileSync(new URL(`../../../../fixtures/examples/${name}.yaml`, import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.model;
}

const options: BoundaryOptions = { objective: "strength", seed: 1, steps: 50, runs: 3 };

function sweep(model: Model, extra: Partial<BoundaryOptions> = {}) {
  const result = boundarySweep(model, { ...options, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.result;
}

describe("boundary sweep", () => {
  it("tries the defaults, each knob alone, all at once, and pairs at max", () => {
    const { report, evaluationsUsed } = sweep(example("boundary"));
    expect(report.settings.map((s) => s.label)).toEqual([
      "defaults",
      "min(recruits)",
      "max(recruits)",
      "min(training)",
      "max(training)",
      "all max",
      "all min",
    ]);
    // With two knobs, the one pair is the same setting as "all max".
    expect(evaluationsUsed).toBe(7);
    expect(report.settings[2]!.parameters).toEqual({ recruits: 5 });
  });

  it("flags the army exploding only when both knobs are at max", () => {
    const { findings } = sweep(example("boundary"));
    const explosion = findings.find((f) => f.id === "search-boundary:explosion:army");
    expect(explosion).toBeDefined();
    expect(explosion!.nodes).toEqual(["army"]);
    expect((explosion!.data!.settings as { label: string }[]).map((s) => s.label)).toEqual([
      "all max",
    ]);
  });

  it("reports nothing for a model with no knobs", () => {
    const { findings, report } = sweep(example("economy"), {
      objective: { id: "o", description: "Any.", expr: "0", measure: "final", sense: "max" },
    });
    expect(findings).toEqual([]);
    expect(report.settings.map((s) => s.label)).toEqual(["defaults"]);
  });

  it("sweeps field overrides as knobs too", () => {
    const { report } = sweep(example("boundary"), {
      fields: [{ path: "nodes.army.start", min: 0, max: 1000 }],
      maxEvaluations: 3,
    });
    expect(report.knobs.map((k) => k.id)).toEqual(["recruits", "training", "nodes.army.start"]);
    expect(report.settings).toHaveLength(3);
    expect(report.skipped[0]).toBe("min(training)");
  });

  it("does not report problems the defaults already have", () => {
    const { findings, report } = sweep(example("boundary"));
    const defaults = new Set(report.settings[0]!.problems);
    for (const finding of findings) {
      expect(defaults.has(finding.data!.problem as string)).toBe(false);
    }
  });

  it("builds the stack-everything strategy from the interactive nodes", () => {
    const model = example("boundary");
    expect(stackEverything(model)).toBeNull();
    model.nodes.push({ id: "b", kind: "source", name: "B", rate: 1, activation: "interactive" });
    model.nodes.push({ id: "a", kind: "source", name: "A", rate: 1, activation: "interactive" });
    expect(stackEverything(model)).toMatchObject({
      actionsPerStep: 2,
      rules: [{ fire: "a" }, { fire: "b" }],
    });
  });
});
