import type { Finding } from "../../analysis/types.js";
import type { Model } from "../../model/types.js";
import type { Trace } from "../types.js";
import { DEFAULTS, poolIds, poolSeries, type TraceCheckOptions } from "./shared.js";

/**
 * A pool that grows without bound: it ends at `factor` times its start or
 * more, and is still growing over the last quarter of the run. The start
 * counts as at least `minReference`, so a pool that starts empty is not
 * flagged for filling a little. Pools with a capacity cannot grow without
 * bound and are skipped.
 */
export function inflationCheck(
  trace: Trace,
  model: Model,
  options: TraceCheckOptions = {},
): Finding[] {
  const { factor, minReference, minSteps } = { ...DEFAULTS.inflation, ...options.inflation };
  const steps = trace.steps.length;
  if (steps < minSteps) return [];
  const capped = new Set(
    model.nodes.filter((n) => n.kind === "pool" && n.capacity !== undefined).map((n) => n.id),
  );
  const findings: Finding[] = [];
  for (const pool of poolIds(model)) {
    if (capped.has(pool)) continue;
    const series = poolSeries(trace, pool);
    const quarter = Math.max(1, Math.floor(steps / 4));
    const reference = Math.max(series[0]!, minReference);
    const end = series[steps]!;
    const lateGrowth = (end - series[steps - quarter]!) / quarter;
    if (end < factor * reference || lateGrowth <= 0) continue;
    findings.push({
      id: `sim-inflation:${pool}`,
      check: "sim-inflation",
      severity: "warning",
      title: `${pool} grows without bound`,
      detail:
        `${pool} went from ${series[0]} to ${end} in ${steps} steps ` +
        `(${(end / reference).toFixed(1)}x its reference of ${reference}) and was still growing ` +
        `by ${lateGrowth.toFixed(1)} per step at the end.`,
      nodes: [pool],
      edges: [],
      data: {
        start: series[0],
        reference,
        end,
        ratio: end / reference,
        lateGrowthPerStep: lateGrowth,
      },
    });
  }
  return findings;
}
