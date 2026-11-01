import type { ConverterNode, Model, Node } from "../model/types.js";
import type { Check, Finding } from "./types.js";

interface ConversionEdge {
  from: string;
  to: string;
  ratio: number;
  converterId: string;
}

/**
 * Build the resource-conversion graph: pools are nodes, and a converter with a
 * single input and a single output becomes a directed edge from its input pool
 * to its output pool carrying the conversion ratio (output amount / input
 * amount). Converters without exactly one input and one output are skipped, as
 * their per-resource ratio is ambiguous.
 */
function buildConversionGraph(model: Model): {
  adj: Map<string, ConversionEdge[]>;
  pools: Map<string, Node>;
} {
  const adj = new Map<string, ConversionEdge[]>();
  const ensure = (id: string): void => {
    if (!adj.has(id)) adj.set(id, []);
  };
  const pools = new Map<string, Node>();
  for (const node of model.nodes) {
    if (node.kind === "pool") pools.set(node.id, node);
  }
  for (const node of model.nodes) {
    if (node.kind !== "converter") continue;
    const conv = node as ConverterNode;
    if (conv.inputs.length !== 1 || conv.outputs.length !== 1) continue;
    const input = conv.inputs[0]!;
    const output = conv.outputs[0]!;
    if (input.amount === 0) continue;
    ensure(input.resource);
    ensure(output.resource);
    adj.get(input.resource)!.push({
      from: input.resource,
      to: output.resource,
      ratio: output.amount / input.amount,
      converterId: conv.id,
    });
  }
  return { adj, pools };
}

export const infiniteLoopsCheck: Check = {
  id: "infinite-loops",
  name: "Infinite conversion loops",
  run(model, index) {
    const { adj } = buildConversionGraph(model);
    const cycles = simpleCycles(adj);
    const findings: Finding[] = [];
    for (const cycle of cycles) {
      let gain = 1;
      const converters = new Set<string>();
      const hopRatios: number[] = [];
      for (let i = 0; i < cycle.length; i++) {
        const from = cycle[i]!;
        const to = cycle[(i + 1) % cycle.length]!;
        const edge = (adj.get(from) ?? []).find((e) => e.to === to);
        if (!edge) continue;
        gain *= edge.ratio;
        hopRatios.push(edge.ratio);
        converters.add(edge.converterId);
      }
      if (!isFinite(gain)) continue;
      const caps: string[] = [];
      for (const nodeId of cycle) {
        const pool = index.nodeById.get(nodeId);
        if (pool && pool.kind === "pool" && pool.capacity !== undefined) {
          caps.push(`pool:${nodeId}:capacity:${pool.capacity}`);
        }
      }
      for (const converterId of converters) {
        const conv = index.nodeById.get(converterId);
        if (conv && conv.kind === "converter" && conv.maxActivationsPerStep !== undefined) {
          caps.push(`converter:${converterId}:maxActivationsPerStep:${conv.maxActivationsPerStep}`);
        }
      }
      const uncapped = caps.length === 0;
      const nodes = cycle.slice().sort();
      const id = `infinite-loops:${nodes.join(",")}`;
      let severity: "info" | "warning" | "error" = "info";
      let title = `Resource conversion loop ${cycle.join(" -> ")} (gain ${round(gain)})`;
      if (gain > 1) {
        severity = uncapped ? "error" : "warning";
        title += uncapped
          ? " — uncapped, infinite resource generation"
          : ` — capped by ${caps.join(", ")}`;
      } else if (gain === 1) {
        severity = "info";
        title += " — resource-neutral (may still produce side effects)";
      } else {
        severity = "info";
        title += " — decaying loop";
      }
      findings.push({
        id,
        check: "infinite-loops",
        severity,
        title,
        detail: `Loop gain is ${round(gain)} (ratios ${hopRatios.map(round).join(" × ")}).` +
          (uncapped ? " No pool capacity or converter cap limits it." : ` Caps: ${caps.join("; ")}.`),
        nodes: nodes.slice(),
        edges: [],
        data: { gain: round(gain), resources: nodes.slice(), converters: Array.from(converters).sort(), caps },
      });
    }
    return findings;
  },
};

function simpleCycles(adj: Map<string, ConversionEdge[]>): string[][] {
  const cycles: string[][] = [];
  const nodes = Array.from(adj.keys()).sort();
  for (let i = 0; i < nodes.length; i++) {
    const start = nodes[i]!;
    const subgraph = new Set(nodes.slice(i));
    const stack: string[] = [start];
    const onStack = new Set([start]);
    const dfs = (): boolean => {
      const top = stack[stack.length - 1]!;
      for (const edge of adj.get(top) ?? []) {
        if (!subgraph.has(edge.to)) continue;
        if (edge.to === start) {
          cycles.push(stack.slice());
        } else if (!onStack.has(edge.to)) {
          stack.push(edge.to);
          onStack.add(edge.to);
          if (dfs()) return true;
          stack.pop();
          onStack.delete(edge.to);
        }
      }
      return false;
    };
    dfs();
  }
  return cycles;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
