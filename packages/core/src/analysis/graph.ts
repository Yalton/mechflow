import type { Edge, EdgeKind, Model, Node } from "../model/types.js";
import type { AnalysisIndex } from "./types.js";

/**
 * Build the analysis index: lookup maps plus node->subsystem and property maps
 * that every check can rely on.
 */
export function buildGraphIndex(model: Model): AnalysisIndex {
  const nodeById = new Map<string, Node>();
  for (const node of model.nodes) nodeById.set(node.id, node);
  const edgeById = new Map<string, Edge>();
  for (const edge of model.edges) edgeById.set(edge.id, edge);
  const nodeToSubsystem = new Map<string, string>();
  for (const node of model.nodes) {
    if (node.subsystem) nodeToSubsystem.set(node.id, node.subsystem);
  }
  const properties = new Map<string, import("../model/types.js").Property>();
  for (const property of model.properties) properties.set(property.id, property);
  return { model, nodeById, edgeById, nodeToSubsystem, properties };
}

/**
 * Directed adjacency restricted to the given edge kinds. Successor lists are
 * de-duplicated so node-sequence cycles are enumerated once.
 */
export function adjacencyFor(
  index: AnalysisIndex,
  kinds: EdgeKind[],
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const ensure = (id: string): void => {
    if (!adj.has(id)) adj.set(id, []);
  };
  for (const edge of index.model.edges) {
    if (!kinds.includes(edge.kind)) continue;
    ensure(edge.from);
    ensure(edge.to);
    const list = adj.get(edge.from)!;
    if (!list.includes(edge.to)) list.push(edge.to);
  }
  return adj;
}

/**
 * Enumerate simple directed cycles. Each cycle is returned once, rotated so its
 * lexicographically smallest node comes first, capped at `maxCount` cycles to
 * keep explosion-prone graphs tractable.
 */
export function simpleCycles(adj: Map<string, string[]>, maxCount = 50): string[][] {
  const cycles: string[][] = [];
  const nodes = Array.from(adj.keys()).sort();
  for (let i = 0; i < nodes.length && cycles.length < maxCount; i++) {
    const start = nodes[i]!;
    const subgraph = new Set(nodes.slice(i));
    const stack: string[] = [start];
    const onStack = new Set([start]);
    const dfs = (): boolean => {
      const top = stack[stack.length - 1]!;
      for (const next of adj.get(top) ?? []) {
        if (!subgraph.has(next)) continue;
        if (next === start) {
          cycles.push(stack.slice());
          if (cycles.length >= maxCount) return true;
        } else if (!onStack.has(next)) {
          stack.push(next);
          onStack.add(next);
          if (dfs()) return true;
          stack.pop();
          onStack.delete(next);
        }
      }
      return false;
    };
    dfs();
  }
  return cycles;
}

/**
 * Tarjan's strongly connected components.
 */
export function stronglyConnectedComponents(adj: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  const strongConnect = (v: string): void => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      result.push(component);
    }
  };

  for (const v of adj.keys()) {
    if (!indices.has(v)) strongConnect(v);
  }
  return result.filter((c) => c.length > 1);
}

/**
 * The (unique) subsystem a node belongs to, or the empty string when it has none.
 */
export function subsystemOf(index: AnalysisIndex, nodeId: string): string {
  return index.nodeToSubsystem.get(nodeId) ?? "";
}
