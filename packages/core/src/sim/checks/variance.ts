import type { Finding } from "../../analysis/types.js";
import type { MonteCarloResult } from "../montecarlo.js";
import { BATCH_DEFAULTS, type BatchCheckOptions } from "./batch.js";

/**
 * A pool whose final amount varies a lot between runs: the coefficient of
 * variation (population standard deviation over mean) of its final amounts
 * is above `maxCv`. Pools that end at 0 on average are skipped.
 */
export function varianceCheck(
  result: MonteCarloResult,
  options: BatchCheckOptions = {},
): Finding[] {
  const { maxCv, minRuns } = { ...BATCH_DEFAULTS.variance, ...options.variance };
  if (result.runs.length < minRuns) return [];
  const findings: Finding[] = [];
  for (const [pool, final] of Object.entries(result.finals).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (final.mean <= 0) continue;
    const sd = Math.sqrt(
      final.values.reduce((sum, v) => sum + (v - final.mean) ** 2, 0) / final.values.length,
    );
    const cv = sd / final.mean;
    if (cv <= maxCv) continue;
    findings.push({
      id: `sim-variance:${pool}`,
      check: "sim-variance",
      severity: "warning",
      title: `${pool} ends very differently from run to run`,
      detail:
        `Over ${result.runs.length} runs, ${pool} ended between ${final.p5} and ${final.p95} ` +
        `(5th to 95th percentile, median ${final.p50}); its spread is ${cv.toFixed(2)} times its mean.`,
      nodes: [pool],
      edges: [],
      data: {
        cv,
        mean: final.mean,
        sd,
        p5: final.p5,
        p50: final.p50,
        p95: final.p95,
        min: final.min,
        max: final.max,
        runs: result.runs.length,
      },
    });
  }
  return findings;
}
