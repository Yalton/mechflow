import type { Model, Node, Polarity } from "../model/types.js";

export interface TraceNode {
  id: string;
  via: string | null;
  polarity: "+" | "-";
}

export interface TraceLevel {
  depth: number;
  nodes: TraceNode[];
}

export interface TraceResult {
  levels: TraceLevel[];
}

interface Lookup {
  byId: Map<string, Node>;
  readsByProperty: Map<string, string[]>;
  writesByProperty: Map<string, string[]>;
}

function buildLookup(model: Model): Lookup {
  const byId = new Map<string, Node>(model.nodes.map((n) => [n.id, n]));
  const readsByProperty = new Map<string, string[]>();
  const writesByProperty = new Map<string, string[]>();
  for (const node of model.nodes) {
    if (node.kind !== "mechanic") continue;
    for (const p of node.reads) push(readsByProperty, p, node.id);
    for (const p of node.writes) push(writesByProperty, p, node.id);
  }
  return { byId, readsByProperty, writesByProperty };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function compose(base: "+" | "-", flip: Polarity | undefined): "+" | "-" {
  return flip === "-" ? (base === "+" ? "-" : "+") : base;
}

/**
 * Depth-bounded trace of a node's effects. Follows outgoing flow/state/interaction
 * edges and property links (a mechanic writing P reaches every mechanic reading
 * P). Each node is recorded once, at its shallowest depth, with the cumulative
 * polarity sign along the path. This is a query, not a check.
 */
export function traceEffects(model: Model, nodeId: string, maxDepth = 3): TraceResult {
  const lookup = buildLookup(model);
  const visited = new Map<string, "+" | "-">([[nodeId, "+"]]);
  const levels: TraceLevel[] = [{ depth: 0, nodes: [{ id: nodeId, via: null, polarity: "+" }] }];

  let current = levels[0]!.nodes;
  for (let depth = 1; depth <= maxDepth && current.length; depth++) {
    const next: TraceNode[] = [];
    const nextSeen = new Set<string>();
    for (const cur of current) {
      const node = lookup.byId.get(cur.id);
      // Outgoing flow/state/interaction edges.
      for (const edge of model.edges) {
        if (!(edge.kind === "flow" || edge.kind === "state" || edge.kind === "interaction")) continue;
        if (edge.from !== cur.id) continue;
        const sign = compose(cur.polarity, edge.polarity);
        if (!visited.has(edge.to)) {
          visited.set(edge.to, sign);
          if (!nextSeen.has(edge.to)) {
            nextSeen.add(edge.to);
            next.push({ id: edge.to, via: edge.id, polarity: sign });
          }
        }
      }
      // Property links: a writing mechanic reaches every mechanic that reads a
      // property it writes.
      if (node && node.kind === "mechanic") {
        for (const p of node.writes) {
          for (const reader of lookup.readsByProperty.get(p) ?? []) {
            if (reader === cur.id) continue;
            if (!visited.has(reader)) {
              visited.set(reader, cur.polarity);
              if (!nextSeen.has(reader)) {
                nextSeen.add(reader);
                next.push({ id: reader, via: `property:${p}`, polarity: cur.polarity });
              }
            }
          }
        }
      }
    }
    if (next.length) {
      levels.push({ depth, nodes: next });
      current = next;
    } else {
      break;
    }
  }
  return { levels };
}
