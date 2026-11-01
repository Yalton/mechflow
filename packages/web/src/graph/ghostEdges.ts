import type { GhostEdge, GhostReason, Report } from "@mechflow/core";

/**
 * Convert a report's ghost edges into render-ready descriptors.
 *
 * A ghost edge is a mechanic/entity pair that is related by the model (shared
 * properties or a shared neighbour) but has no interaction edge. The core
 * analysis (`findGhostEdges`) produces the raw edges with reasons and scores;
 * this module reduces each to a label + score so the graph renderer can draw
 * them. Pure, side-effect-free.
 */

/** React Flow edge type tag for a ghost edge. */
export const GHOST_EDGE_TYPE = "mechflow-ghost-edge";

/** A ghost edge reduced to what the renderer needs: a label and a score. */
export interface GhostEdgeDescriptor {
  /** Stable React Flow edge id, e.g. "ghost-edge:fire_water". */
  id: string;
  a: string;
  b: string;
  /** The top (highest-weight) reason, as a human label. */
  reason: string;
  /** The top reason in a word or two, for the badge on the canvas. */
  short: string;
  /** Every reason as a human label, in the core's reported order. */
  reasons: string[];
  /** Combined relatedness score (core weights + shared third node). */
  score: number;
}

/** Core reason weights, mirrored here so the label order matches the score. */
const WEIGHT: Record<GhostReason["kind"], number> = {
  readWrite: 3,
  sharedWrite: 2,
  sharedTarget: 2,
  sharedRead: 1,
};

/**
 * Label for a pair the core relates only through a shared neighbour: it reports
 * those with an empty reasons list. Matches the core's report wording.
 */
const NEIGHBOUR_REASON = "share a neighbour";
const NEIGHBOUR_SHORT = "neighbour";

/**
 * The top (highest-weight) reason for a ghost edge, or undefined when the pair
 * is related only by a shared neighbour. Ties keep the core's reported order
 * (first occurrence wins), matching the score contribution.
 */
export function topReason(g: GhostEdge): GhostReason | undefined {
  let best = g.reasons[0];
  if (!best) return undefined;
  let bestWeight = WEIGHT[best.kind];
  for (const r of g.reasons.slice(1)) {
    const weight = WEIGHT[r.kind];
    if (weight > bestWeight) {
      best = r;
      bestWeight = weight;
    }
  }
  return best;
}

/** Human label for a single reason, matching the report wording. */
export function reasonLabel(r: GhostReason): string {
  switch (r.kind) {
    case "sharedWrite":
      return `both write ${r.property}`;
    case "sharedRead":
      return `both read ${r.property}`;
    case "readWrite":
      return `${r.property} is written by one and read by the other`;
    case "sharedTarget":
      return `acts on ${r.target}`;
  }
}

/** The badge text for a reason: the property it is about, or the shared target. */
export function shortLabel(r: GhostReason): string {
  return r.kind === "sharedTarget" ? `→ ${r.target ?? ""}` : (r.property ?? "");
}

/** Stable id for a ghost edge between two node ids (sorted, order-independent). */
export function ghostEdgeId(a: string, b: string): string {
  return `ghost-edge:${[a, b].sort().join("_")}`;
}

/**
 * Convert a report's ghost edges into render-ready descriptors, highest score
 * first. Deterministic (matches the core's score-desc, id-asc ordering).
 */
export function ghostEdgesToDescriptors(
  report: Pick<Report, "ghostEdges">,
): GhostEdgeDescriptor[] {
  return [...report.ghostEdges]
    .sort((x, y) => {
      const byScore = y.score - x.score;
      return byScore !== 0
        ? byScore
        : ghostEdgeId(x.a, x.b) < ghostEdgeId(y.a, y.b)
          ? -1
          : 1;
    })
    .map((g) => {
      const top = topReason(g);
      return {
        id: ghostEdgeId(g.a, g.b),
        a: g.a,
        b: g.b,
        reason: top ? reasonLabel(top) : NEIGHBOUR_REASON,
        short: top ? shortLabel(top) : NEIGHBOUR_SHORT,
        reasons: top ? g.reasons.map(reasonLabel) : [NEIGHBOUR_REASON],
        score: g.score,
      };
    });
}

/**
 * Hide pairs whose score is at or below the threshold. Keeps the input order
 * (already score-descending), so the slider only ever removes the weakest.
 */
export function filterGhostEdges(
  descriptors: ReadonlyArray<GhostEdgeDescriptor>,
  threshold: number,
): GhostEdgeDescriptor[] {
  return descriptors.filter((d) => d.score >= threshold);
}
