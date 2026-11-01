import type { Finding } from "../../analysis/types.js";
import type { Model } from "../../model/types.js";
import type { Trace } from "../types.js";
import { DEFAULTS, starvationEpisodes, type TraceCheckOptions, type Episode } from "./shared.js";

/**
 * One node's starvation followed, within `window` steps each, by starvation of
 * nodes downstream of it along flow edges. Reported once per origin: the first
 * episode of a node that is not itself part of an earlier cascade, with the
 * chain of nodes that starved after it.
 */
export function cascadingFailureCheck(
  trace: Trace,
  model: Model,
  options: TraceCheckOptions = {},
): Finding[] {
  const { window } = { ...DEFAULTS.cascadingFailure, ...options.cascadingFailure };
  const next = new Map<string, string[]>();
  for (const edge of model.edges) {
    if (edge.kind !== "flow") continue;
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }
  const episodes = starvationEpisodes(trace, model);
  const firstOf = new Map<string, Episode>();
  for (const e of episodes) if (!firstOf.has(e.node)) firstOf.set(e.node, e);

  const inCascade = new Set<string>();
  const findings: Finding[] = [];
  for (const origin of firstOf.values()) {
    if (inCascade.has(origin.node)) continue;
    // Walk downstream: a successor that starts starving within the window of
    // its predecessor's start joins the chain.
    const chain: { node: string; step: number }[] = [];
    const seen = new Set([origin.node]);
    const queue: Episode[] = [origin];
    while (queue.length > 0) {
      const from = queue.shift()!;
      for (const to of [...(next.get(from.node) ?? [])].sort()) {
        if (seen.has(to)) continue;
        const episode = episodes.find(
          (e) => e.node === to && e.start > from.start && e.start <= from.start + window,
        );
        if (!episode) continue;
        seen.add(to);
        chain.push({ node: to, step: episode.start });
        queue.push(episode);
      }
    }
    if (chain.length === 0) continue;
    for (const { node } of chain) inCascade.add(node);
    findings.push({
      id: `sim-cascading-failure:${origin.node}`,
      check: "sim-cascading-failure",
      severity: "warning",
      title: `Starvation of ${origin.node} cascades to ${chain.length} downstream node${chain.length > 1 ? "s" : ""}`,
      detail:
        `${origin.node} starved from step ${origin.start}, then ` +
        chain.map((c) => `${c.node} from step ${c.step}`).join(", ") +
        ".",
      nodes: [origin.node, ...chain.map((c) => c.node)],
      edges: [],
      data: { origin: origin.node, step: origin.start, chain, window },
    });
  }
  return findings;
}
