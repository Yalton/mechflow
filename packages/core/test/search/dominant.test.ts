import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseModelYaml } from "../../src/model/io.js";
import type { Model } from "../../src/model/types.js";
import {
  dominantCombinations,
  focusStrategy,
  type DominantOptions,
} from "../../src/search/dominant.js";

function example(name: string): Model {
  const parsed = parseModelYaml(
    readFileSync(new URL(`../../../../fixtures/examples/${name}.yaml`, import.meta.url), "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.model;
}

const options: DominantOptions = { objective: "wealth", seed: 1, steps: 30, runs: 2 };

function search(model: Model, extra: Partial<DominantOptions> = {}) {
  const result = dominantCombinations(model, { ...options, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.result;
}

describe("dominant-combination search", () => {
  it("tries every set up to size k when the budget allows", () => {
    const { report, evaluationsUsed } = search(example("combo"));
    expect(report.mode).toBe("exhaustive");
    // Baseline plus 3 singles, 3 pairs and 1 triple.
    expect(evaluationsUsed).toBe(8);
    expect(report.ranked).toHaveLength(7);
    expect(report.ranked[0]!.nodes).toEqual(["drill", "pray", "sharpen"]);
  });

  it("flags the pair that multiplies, with its synergy", () => {
    const { findings, report } = search(example("combo"), { k: 2 });
    expect(findings.map((f) => f.id)).toEqual(["search-dominant:pray+sharpen"]);
    const pair = report.ranked.find((r) => r.nodes.join() === "pray,sharpen")!;
    expect(pair.synergy).toBeGreaterThan(1.5);
    expect(findings[0]!.data!.strategy).toEqual(focusStrategy(["sharpen", "pray"]));
  });

  it("does not flag sets whose members just add up", () => {
    const { findings } = search(example("combo"), { nodes: ["drill", "pray"] });
    expect(findings).toEqual([]);
  });

  it("samples and then searches locally when the budget is too small", () => {
    const { report, evaluationsUsed } = search(example("combo"), { maxEvaluations: 6 });
    expect(report.mode).toBe("sampled");
    expect(evaluationsUsed).toBeLessThanOrEqual(6);
    // Singles always come first, so synergy can be computed.
    expect(report.ranked.filter((r) => r.nodes.length === 1)).toHaveLength(3);
  });

  it("is reproducible", () => {
    expect(search(example("combo"), { maxEvaluations: 6 })).toEqual(
      search(example("combo"), { maxEvaluations: 6 }),
    );
  });

  it("finds nothing in a model with no interactive nodes", () => {
    const { findings, report } = search(example("economy"), {
      objective: { id: "o", description: "Any.", expr: "0", measure: "final", sense: "max" },
    });
    expect(findings).toEqual([]);
    expect(report.ranked).toEqual([]);
  });

  it("rejects nodes that are not interactive", () => {
    const result = dominantCombinations(example("combo"), { ...options, nodes: ["gold"] });
    expect(result.ok).toBe(false);
  });
});
