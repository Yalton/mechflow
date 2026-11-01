import type { Model } from "../../model/types.js";
import type { Trace } from "../types.js";

/** Thresholds for the single-trace checks; every field has a default. */
export interface TraceCheckOptions {
  inflation?: {
    /** End amount must reach this multiple of the reference amount. */
    factor?: number;
    /** The reference is the start amount, but never less than this. */
    minReference?: number;
    /** Runs shorter than this are not judged. */
    minSteps?: number;
  };
  starvation?: {
    /** Consecutive starved steps that make a finding. */
    minStreak?: number;
  };
  snowballing?: {
    /** Pearson correlation of amount and next growth that makes a finding. */
    minCorrelation?: number;
    minSteps?: number;
  };
  cascadingFailure?: {
    /** Steps after one starvation in which downstream starvation counts. */
    window?: number;
  };
}

export const DEFAULTS = {
  inflation: { factor: 4, minReference: 10, minSteps: 8 },
  starvation: { minStreak: 3 },
  snowballing: { minCorrelation: 0.8, minSteps: 8 },
  cascadingFailure: { window: 5 },
} as const;

/** A pool's amount at step 0 (initial) through the last step. */
export function poolSeries(trace: Trace, pool: string): number[] {
  return [trace.initial.amounts[pool]!, ...trace.steps.map((s) => s.amounts[pool]!)];
}

export function poolIds(model: Model): string[] {
  return model.nodes
    .filter((n) => n.kind === "pool")
    .map((n) => n.id)
    .sort();
}

/** A run of consecutive starved steps for one node. */
export interface Episode {
  node: string;
  /** First and last starved step. */
  start: number;
  end: number;
  /** The empty pools it could not draw enough from. */
  pools: string[];
  edges: string[];
}

/**
 * Every starvation episode in the trace, by consuming node, in step order. A
 * node is starved in a step when an edge into it took less than it asked
 * from a pool that held less at the start of the step than all edges asked of
 * it, or when it is a converter that failed because an input pool held too
 * little. Phase 1 arrivals are not counted as held, so this errs towards
 * reporting.
 */
export function starvationEpisodes(trace: Trace, model: Model): Episode[] {
  const open = new Map<string, Episode>();
  const episodes: Episode[] = [];
  starvedSteps(trace, model).forEach((starved, i) => {
    const step = trace.steps[i]!.step;
    for (const [node, episode] of open) {
      if (!starved.has(node)) {
        episodes.push(episode);
        open.delete(node);
      }
    }
    for (const [node, { pools: from, edges }] of starved) {
      const episode = open.get(node);
      if (episode) {
        episode.end = step;
        episode.pools = [...new Set([...episode.pools, ...from])].sort();
        episode.edges = [...new Set([...episode.edges, ...edges])].sort();
      } else {
        open.set(node, {
          node,
          start: step,
          end: step,
          pools: [...from].sort(),
          edges: [...edges].sort(),
        });
      }
    }
  });
  episodes.push(...open.values());
  return episodes.sort(
    (a, b) => a.start - b.start || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0),
  );
}

/** Per step, every starved node with the pools and edges it was short on. */
export function starvedSteps(
  trace: Trace,
  model: Model,
): Map<string, { pools: Set<string>; edges: Set<string> }>[] {
  const pools = new Set(poolIds(model));
  const flows = new Map(
    model.edges.filter((e) => e.kind === "flow").map((e) => [e.id, e] as const),
  );
  const converters = new Map(
    model.nodes.flatMap((n) => (n.kind === "converter" ? [[n.id, n] as const] : [])),
  );
  return trace.steps.map((record, i) => {
    const before = i === 0 ? trace.initial.amounts : trace.steps[i - 1]!.amounts;
    const asked = new Map<string, number>();
    for (const [id, want] of Object.entries(record.wanted)) {
      const edge = flows.get(id);
      if (edge && pools.has(edge.from)) asked.set(edge.from, (asked.get(edge.from) ?? 0) + want);
    }
    const starved = new Map<string, { pools: Set<string>; edges: Set<string> }>();
    const mark = (node: string, pool: string, edge?: string): void => {
      const entry = starved.get(node) ?? { pools: new Set(), edges: new Set() };
      entry.pools.add(pool);
      if (edge) entry.edges.add(edge);
      starved.set(node, entry);
    };
    for (const [id, want] of Object.entries(record.wanted)) {
      const edge = flows.get(id);
      if (!edge || !pools.has(edge.from)) continue;
      if ((record.moved[id] ?? 0) < want && before[edge.from]! < asked.get(edge.from)!) {
        mark(edge.to, edge.from, id);
      }
    }
    for (const id of record.failed) {
      const converter = converters.get(id);
      if (!converter) continue;
      for (const { resource, amount } of converter.inputs) {
        if ((before[resource] ?? 0) < amount) mark(id, resource);
      }
    }
    return starved;
  });
}
