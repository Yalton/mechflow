import type { Model } from "@mechflow/core";
import type { FlowGraph } from "./toFlow.js";

/**
 * Resource chains, coloured as Machinations colours its resource paths.
 *
 * A chain is a set of economy nodes joined by flow edges. Converters bound
 * chains, since a converter turns one resource into another: an edge into a
 * converter belongs to the chain it comes from, an edge out of one to the
 * chain it goes to, and the converter itself to none. Chains are numbered by
 * their smallest node id, so colours stay put as a model is edited elsewhere.
 */

/** How many chain colours styles.css defines (--chain-1 to --chain-N). */
export const CHAIN_COLOURS = 6;

export interface Chains {
  /** Chain number of each node in a chain. */
  nodes: Map<string, number>;
  /** Chain number of each flow edge. */
  edges: Map<string, number>;
}

export function findChains(model: Model): Chains {
  const kind = new Map(model.nodes.map((n) => [n.id, n.kind]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const add = (id: string): void => {
    if (!parent.has(id)) parent.set(id, id);
  };
  // The end of a flow edge that carries its chain: not the converter.
  const anchor = (from: string, to: string): string => (kind.get(from) === "converter" ? to : from);

  const flows = model.edges.filter((e) => e.kind === "flow" && kind.has(e.from) && kind.has(e.to));
  for (const { from, to } of flows) {
    const ends = [from, to].filter((id) => kind.get(id) !== "converter");
    ends.forEach(add);
    if (ends.length === 2) {
      const [a, b] = [find(ends[0]!), find(ends[1]!)];
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }

  // Each union keeps the smaller id as root, so a root is its chain's smallest id.
  const roots = [...new Set([...parent.keys()].map(find))].sort();
  const number = new Map(roots.map((root, i) => [root, i]));
  const nodes = new Map([...parent.keys()].map((id) => [id, number.get(find(id))!]));
  const edges = new Map<string, number>();
  for (const edge of flows) {
    const end = anchor(edge.from, edge.to);
    if (nodes.has(end)) edges.set(edge.id, nodes.get(end)!);
  }
  return { nodes, edges };
}

/** The colour of chain `n`. */
export function chainColour(n: number): string {
  return `var(--chain-${(n % CHAIN_COLOURS) + 1})`;
}

/** Set `data.chain` (a colour) on each node and flow edge in a chain. */
export function applyChains(graph: FlowGraph, chains: Chains): FlowGraph {
  return {
    nodes: graph.nodes.map((node) =>
      chains.nodes.has(node.id) ? { ...node, data: { ...node.data, chain: chainColour(chains.nodes.get(node.id)!) } } : node,
    ),
    edges: graph.edges.map((edge) =>
      chains.edges.has(edge.id) ? { ...edge, data: { ...edge.data!, chain: chainColour(chains.edges.get(edge.id)!) } } : edge,
    ),
  };
}
