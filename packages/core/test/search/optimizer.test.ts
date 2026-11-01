import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseModelYaml } from "../../src/model/io.js";
import type { Model } from "../../src/model/types.js";
import { optimizePlayer, type OptimizerOptions } from "../../src/search/optimizer.js";
import { simulate } from "../../src/sim/run.js";

function example(name: string): Model {
  const parsed = parseModelYaml(
    readFileSync(new URL(`../../../../fixtures/examples/${name}.yaml`, import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.model;
}

const options: OptimizerOptions = { objective: "wealth", seed: 1, steps: 30, runs: 2 };

function optimize(model: Model, extra: Partial<OptimizerOptions> = {}) {
  const result = optimizePlayer(model, { ...options, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.result;
}

describe("optimiser player", () => {
  it("finds that farming beats the intended investment plan", () => {
    const { findings, report } = optimize(example("exploit"));
    expect(report.fires[0]!.node).toBe("farm");
    expect(report.intended.map((s) => s.id)).toEqual(["invest"]);
    expect(report.score).toBeGreaterThan(report.intended[0]!.score * 1.2);
    expect(findings.map((f) => f.id)).toEqual(["search-unintended-optimum:optimizer"]);
    expect(findings[0]!.nodes[0]).toBe("farm");
  });

  it("derives a replayable rule strategy from its fires", () => {
    const { report } = optimize(example("exploit"));
    expect(report.strategy!.rules[0]).toEqual({ fire: "farm" });
    const replay = simulate(example("exploit"), { seed: 1, steps: 30, strategy: report.strategy! });
    expect(replay.ok).toBe(true);
    expect(report.strategyScore).not.toBeNull();
  });

  it("records its first game with the fires as fires by hand", () => {
    const { report } = optimize(example("exploit"));
    expect(report.trace.steps).toHaveLength(30);
    expect(report.trace.steps.some((s) => s.firedByHand.includes("farm"))).toBe(true);
  });

  it("is reproducible", () => {
    expect(optimize(example("exploit")).report.score).toBe(
      optimize(example("exploit")).report.score,
    );
  });

  it("raises no finding when no strategy is intended", () => {
    const model = example("exploit");
    model.strategies = [];
    const { findings, report } = optimize(model);
    expect(findings).toEqual([]);
    expect(report.intended).toEqual([]);
  });

  it("refuses work that does not fit the budget", () => {
    const result = optimizePlayer(example("exploit"), { ...options, maxEvaluations: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.path).toBe("options.maxEvaluations");
  });
});
