import type { StepRecord } from "@mechflow/core";
import type { FlowGraph } from "./toFlow.js";

/**
 * Overlay the active run on a flow graph: pools carry their current amount as
 * `data.runAmount`; flow edges that moved resources in the latest step are
 * flagged `data.moving` with the amount as `data.movedAmount` (and the step as
 * `data.movedStep`, so the token animation restarts each step), and edges that
 * wanted resources but moved none are flagged `data.starved`. State edges whose
 * source (a pool's amount or a register's value) changed in the latest step,
 * compared with `previous`, carry the new value as `data.signal`. Returns the
 * graph unchanged when no run is active, so the caller's `useMemo` keeps a
 * stable reference.
 */
export function applyRun(
  graph: FlowGraph,
  amounts: Record<string, number> | null,
  record: StepRecord | null,
  previous: { amounts: Record<string, number>; registers: Record<string, number> } | null = null,
): FlowGraph {
  if (!amounts) return graph;
  const moved = record?.moved ?? {};
  const wanted = record?.wanted ?? {};
  // A node's value now and before the latest step, if it has one.
  const valueOf = (id: string): [number, number] | null => {
    if (!record || !previous) return null;
    if (id in record.amounts && id in previous.amounts) return [record.amounts[id]!, previous.amounts[id]!];
    if (id in record.registers && id in previous.registers) return [record.registers[id]!, previous.registers[id]!];
    return null;
  };
  return {
    nodes: graph.nodes.map((node) =>
      node.id in amounts ? { ...node, data: { ...node.data, runAmount: amounts[node.id] } } : node,
    ),
    edges: graph.edges.map((edge) => {
      const data = edge.data!;
      if (data.kind === "state") {
        const values = valueOf(edge.source);
        if (values === null || values[0] === values[1]) return edge;
        return { ...edge, data: { ...data, signal: values[0], movedStep: record?.step } };
      }
      const amount = moved[edge.id] ?? 0;
      if (amount > 0) {
        return { ...edge, data: { ...data, moving: true, movedAmount: amount, movedStep: record?.step } };
      }
      if ((wanted[edge.id] ?? 0) > 0) return { ...edge, data: { ...data, starved: true } };
      return edge;
    }),
  };
}
