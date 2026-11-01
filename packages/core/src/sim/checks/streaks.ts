import type { Finding } from "../../analysis/types.js";
import type { Model } from "../../model/types.js";
import type { MonteCarloResult } from "../montecarlo.js";
import { BATCH_DEFAULTS, type BatchCheckOptions } from "./batch.js";
import { starvedSteps } from "./shared.js";

/**
 * The worst case of each node across a batch: its longest streak of
 * consecutive short steps in any run, where a step is short if the node
 * failed an all-mode activation or was starved (see the starvation check). A
 * node whose worst streak is `minStreak` or more is reported with the seed of
 * the run it happened in, so that run can be replayed. Needs the batch's
 * traces (`keepTraces: true`).
 */
export function streaksCheck(
  result: MonteCarloResult,
  model: Model,
  options: BatchCheckOptions = {},
): Finding[] {
  const { minStreak } = { ...BATCH_DEFAULTS.streaks, ...options.streaks };
  if (!result.traces) {
    throw new Error("the streaks check needs the batch's traces: run monteCarlo with keepTraces");
  }
  // Per node: the longest streak in each run.
  const perRun = new Map<string, { streak: number; start: number }[]>();
  result.traces.forEach((trace, run) => {
    const starved = starvedSteps(trace, model);
    const current = new Map<string, number>();
    trace.steps.forEach((record, i) => {
      const short = new Set([...record.failed, ...starved[i]!.keys()]);
      for (const node of new Set([...current.keys(), ...short])) {
        const length = short.has(node) ? (current.get(node) ?? 0) + 1 : 0;
        current.set(node, length);
        if (!perRun.has(node)) {
          perRun.set(
            node,
            result.traces!.map(() => ({ streak: 0, start: 0 })),
          );
        }
        const best = perRun.get(node)![run]!;
        if (length > best.streak) {
          best.streak = length;
          best.start = record.step - length + 1;
        }
      }
    });
  });

  const findings: Finding[] = [];
  for (const node of [...perRun.keys()].sort()) {
    const runs = perRun.get(node)!;
    let worst = 0;
    runs.forEach((r, i) => {
      if (r.streak > runs[worst]!.streak) worst = i;
    });
    const { streak, start } = runs[worst]!;
    if (streak < minStreak) continue;
    const affected = runs.filter((r) => r.streak >= minStreak).length;
    const seed = result.runs[worst]!.seed;
    findings.push({
      id: `sim-streaks:${node}`,
      check: "sim-streaks",
      severity: "warning",
      title: `${node} can come up short for ${streak} steps in a row`,
      detail:
        `In the worst of ${runs.length} runs (seed ${seed}), ${node} was short from step ` +
        `${start} to ${start + streak - 1}. ${affected} of ${runs.length} runs had a streak of ` +
        `${minStreak} or more.`,
      nodes: [node],
      edges: [],
      data: {
        worstStreak: streak,
        start,
        seed,
        run: worst,
        runsAffected: affected,
        runs: runs.length,
      },
    });
  }
  return findings;
}
