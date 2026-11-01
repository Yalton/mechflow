import type { Finding } from "../../analysis/types.js";
import type { Model } from "../../model/types.js";
import type { Trace } from "../types.js";
import { DEFAULTS, starvationEpisodes, type TraceCheckOptions } from "./shared.js";

/**
 * A node starved for `minStreak` or more consecutive steps: what it pulls
 * moved less than asked because a source pool ran dry. One finding per node,
 * describing its longest episode.
 */
export function starvationCheck(
  trace: Trace,
  model: Model,
  options: TraceCheckOptions = {},
): Finding[] {
  const { minStreak } = { ...DEFAULTS.starvation, ...options.starvation };
  const longest = new Map<string, ReturnType<typeof starvationEpisodes>[number]>();
  const count = new Map<string, number>();
  for (const episode of starvationEpisodes(trace, model)) {
    const length = episode.end - episode.start + 1;
    if (length < minStreak) continue;
    count.set(episode.node, (count.get(episode.node) ?? 0) + 1);
    const best = longest.get(episode.node);
    if (!best || length > best.end - best.start + 1) longest.set(episode.node, episode);
  }
  return [...longest.values()].map((episode) => {
    const length = episode.end - episode.start + 1;
    return {
      id: `sim-starvation:${episode.node}`,
      check: "sim-starvation",
      severity: "warning",
      title: `${episode.node} starves for ${length} steps`,
      detail:
        `${episode.node} got less than it asked for from ${episode.pools.join(", ")} ` +
        `in steps ${episode.start} to ${episode.end} because ${episode.pools.length > 1 ? "they" : "it"} ran dry.`,
      nodes: [episode.node, ...episode.pools.filter((p) => p !== episode.node)],
      edges: episode.edges,
      data: {
        longestStreak: length,
        start: episode.start,
        end: episode.end,
        pools: episode.pools,
        episodes: count.get(episode.node),
      },
    };
  });
}
