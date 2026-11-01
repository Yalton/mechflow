import type { EdgeKind, Model } from "../model/types.js";
import type { Check, Finding } from "./types.js";

const KINDS: EdgeKind[] = ["flow", "interaction"];

interface Graph {
  adj: Map<string, Set<string>>;
  nodes: string[];
}

function buildGraph(model: Model, undirected: boolean): Graph {
  const adj = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
    if (undirected) {
      if (!adj.has(to)) adj.set(to, new Set());
      adj.get(to)!.add(from);
    }
  };
  for (const edge of model.edges) {
    if (!KINDS.includes(edge.kind)) continue;
    add(edge.from, edge.to);
  }
  const nodes = Array.from(adj.keys()).sort();
  return { adj, nodes };
}

function brandesDirected(adj: Map<string, Set<string>>, nodes: string[]): Map<string, number> {
  const betweenness = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const s of nodes) {
    const stack: string[] = [];
    const pred = new Map<string, string[]>();
    const sigma = new Map<string, number>([[s, 1]]);
    const dist = new Map<string, number>([[s, 0]]);
    const queue: string[] = [s];
    while (queue.length) {
      const v = queue.shift()!;
      stack.push(v);
      const dv = dist.get(v)!;
      for (const w of adj.get(v) ?? []) {
        if (!dist.has(w)) {
          dist.set(w, dv + 1);
          queue.push(w);
        }
        if (dist.get(w) === dv + 1) {
          sigma.set(w, (sigma.get(w) ?? 0) + (sigma.get(v)!));
          const preds = pred.get(w);
          if (preds) preds.push(v);
          else pred.set(w, [v]);
        }
      }
    }
    const delta = new Map<string, number>();
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of pred.get(w) ?? []) {
        delta.set(v, (delta.get(v) ?? 0) + ((sigma.get(v)! / sigma.get(w)!) * (1 + (delta.get(w) ?? 0))));
      }
      if (w !== s) betweenness.set(w, (betweenness.get(w) ?? 0) + (delta.get(w) ?? 0));
    }
  }
  return betweenness;
}

function articulationPoints(adj: Map<string, Set<string>>, nodes: string[]): Set<string> {
  let timer = 0;
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const ap = new Set<string>();
  const dfs = (v: string): void => {
    disc.set(v, timer);
    low.set(v, timer);
    timer++;
    let children = 0;
    for (const w of adj.get(v) ?? []) {
      if (!disc.has(w)) {
        parent.set(w, v);
        children++;
        dfs(w);
        if (parent.get(v) === null && children > 1) ap.add(v);
        if (parent.get(v) !== null && low.get(w)! >= disc.get(v)!) ap.add(v);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (w !== parent.get(v)) {
        low.set(v, Math.min(low.get(v)!, disc.get(w)!));
      }
    }
  };
  for (const v of nodes) {
    if (!disc.has(v)) {
      parent.set(v, null);
      dfs(v);
    }
  }
  return ap;
}

function dependentsCutOff(
  adj: Map<string, Set<string>>,
  removed: string,
): number {
  const seen = new Set<string>([removed]);
  const reachable = new Set<string>();
  const stack: string[] = [];
  for (const w of adj.get(removed) ?? []) {
    if (!seen.has(w)) {
      stack.push(w);
      seen.add(w);
    }
  }
  while (stack.length) {
    const v = stack.pop()!;
    if (reachable.has(v)) continue;
    reachable.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!seen.has(w)) {
        seen.add(w);
        stack.push(w);
      }
    }
  }
  const total = adj.size - 1;
  return Math.max(0, total - reachable.size);
}

export const bottlenecksCheck: Check = {
  id: "bottlenecks",
  name: "Bottlenecks and single points of dependency",
  run(model, index) {
    if (index.model.nodes.length < 5) return [];
    const directed = buildGraph(model, false);
    const undirected = buildGraph(model, true);
    const betweenness = brandesDirected(directed.adj, directed.nodes);
    const aps = articulationPoints(undirected.adj, undirected.nodes);

    const values = Array.from(betweenness.values());
    const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length || 1);
    const std = Math.sqrt(variance);
    const threshold = mean + 2 * std;

    const flagged = new Set<string>();
    for (const node of directed.nodes) {
      if (betweenness.get(node)! > threshold) flagged.add(node);
    }
    for (const node of aps) flagged.add(node);

    const findings: Finding[] = [];
    for (const node of flagged) {
      const bp = betweenness.get(node)!;
      const isArticulation = aps.has(node);
      findings.push({
        id: `bottlenecks:${node}`,
        check: "bottlenecks",
        severity: "warning",
        title: isArticulation
          ? `${node} is a single point of dependency`
          : `${node} has unusually high flow betweenness`,
        detail:
          `Betweenness centrality is ${bp.toFixed(3)} (mean ${mean.toFixed(3)}, ` +
          `threshold ${threshold.toFixed(3)}). ` +
          (isArticulation
            ? `Removing ${node} disconnects ${dependentsCutOff(undirected.adj, node)} node(s) from the graph.`
            : `This node sits on an unusually large share of shortest paths.`),
        nodes: [node],
        edges: [],
        data: { betweenness: bp, isArticulationPoint: isArticulation, dependents: dependentsCutOff(undirected.adj, node) },
      });
    }
    return findings;
  },
};
