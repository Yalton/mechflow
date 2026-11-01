import { feedbackLoopsCheck } from "../../analysis/feedback-loops.js";
import { buildGraphIndex } from "../../analysis/graph.js";
import type { Finding } from "../../analysis/types.js";
import type { Model } from "../../model/types.js";
import type { Trace } from "../types.js";
import { DEFAULTS, poolIds, poolSeries, type TraceCheckOptions } from "./shared.js";

/**
 * Positive feedback: across the run, a pool's growth in a step correlates with
 * its amount before that step (Pearson r of `minCorrelation` or more) and it
 * grew overall. The finding names the reinforcing loops through the pool from
 * the static feedback-loop analysis.
 */
export function snowballingCheck(
  trace: Trace,
  model: Model,
  options: TraceCheckOptions = {},
): Finding[] {
  const { minCorrelation, minSteps } = { ...DEFAULTS.snowballing, ...options.snowballing };
  if (trace.steps.length < minSteps) return [];
  let loops: Finding[] | null = null;
  const findings: Finding[] = [];
  for (const pool of poolIds(model)) {
    const series = poolSeries(trace, pool);
    const before = series.slice(0, -1);
    const growth = series.slice(1).map((amount, i) => amount - series[i]!);
    const r = correlation(before, growth);
    if (r === null || r < minCorrelation || series.at(-1)! <= series[0]!) continue;
    loops ??= feedbackLoopsCheck
      .run(model, buildGraphIndex(model))
      .filter((f) => f.data?.sign === "reinforcing");
    const through = loops.filter((f) => f.nodes.includes(pool));
    const loopNodes = [...new Set(through.flatMap((f) => f.nodes))]
      .filter((n) => n !== pool)
      .sort();
    findings.push({
      id: `sim-snowballing:${pool}`,
      check: "sim-snowballing",
      severity: "warning",
      title: `${pool} snowballs`,
      detail:
        `The more ${pool} holds, the faster it grows (correlation ${r.toFixed(2)}), ` +
        `from ${series[0]} to ${series.at(-1)}.` +
        (through.length > 0
          ? ` Reinforcing loop: ${through.map((f) => f.nodes.join(", ")).join("; ")}.`
          : " No reinforcing loop was found in the graph; the growth may come from formulas."),
      nodes: [pool, ...loopNodes],
      edges: [],
      data: {
        correlation: r,
        start: series[0],
        end: series.at(-1),
        loops: through.map((f) => f.id),
      },
    });
  }
  return findings;
}

/** Pearson correlation, or null when either series is constant. */
function correlation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
