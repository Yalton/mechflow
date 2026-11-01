import type { TraceResult } from "@mechflow/core";
import type { FlowGraph } from "./toFlow.js";

/**
 * Prefix of the CSS class applied to a node reached by a trace at a given depth.
 * The class is `trace-depth-1`, `trace-depth-2`, `trace-depth-3` for the first,
 * second, and third order. The viewer colours each by its depth rule.
 */
export const TRACE_CLASS_PREFIX = "trace-depth-";

/**
 * Overlay a depth-bounded effect trace onto a flow graph.
 *
 * Reached nodes (depth 1–3) receive a depth class (`trace-depth-N`) so the
 * viewer colours them by order, plus their cumulative polarity sign on `data`.
 * The origin node (depth 0) is left untouched — it is the selected node. Edges
 * on the trace path are flagged `trace: true` so their renderer can emphasise
 * them. Returns the graph unchanged when no result is supplied, preserving
 * referential stability for the caller's `useMemo`.
 */
export function applyTrace(
  graph: FlowGraph,
  result: TraceResult | null,
): FlowGraph {
  if (!result) return graph;

  const depthByNode = new Map<string, number>();
  const polarityByNode = new Map<string, "+" | "-">();
  for (const level of result.levels) {
    for (const node of level.nodes) {
      depthByNode.set(node.id, level.depth);
      polarityByNode.set(node.id, node.polarity);
    }
  }

  return {
    nodes: graph.nodes.map((node) => {
      const depth = depthByNode.get(node.id);
      // The origin (depth 0) is the selected node; only reached nodes are marked.
      if (depth === undefined || depth === 0) return node;
      return {
        ...node,
        data: {
          ...node.data,
          traceDepth: depth,
          tracePolarity: polarityByNode.get(node.id) ?? "+",
        },
        className: `${TRACE_CLASS_PREFIX}${depth}`,
      };
    }),
    edges: graph.edges.map((edge) => {
      // `edge.data` is typed optional by React Flow but always present on graphs
      // produced by `toFlow`; assert it so the spread keeps required fields.
      const data = edge.data!;
      const fromDepth = depthByNode.get(data.edge.from);
      const toDepth = depthByNode.get(data.edge.to);
      if (fromDepth === undefined && toDepth === undefined) return edge;
      return {
        ...edge,
        data: { ...data, trace: true },
      };
    }),
  };
}
