import type { MechanicNode, Model, Node } from "../model/types.js";
import type { Check, Finding } from "./types.js";

export interface GhostReason {
  kind: "sharedWrite" | "sharedRead" | "readWrite" | "sharedTarget";
  property?: string;
  target?: string;
}

export interface GhostEdge {
  a: string;
  b: string;
  reasons: GhostReason[];
  score: number;
}

const WEIGHT: Record<GhostReason["kind"], number> = {
  readWrite: 3,
  sharedWrite: 2,
  sharedTarget: 2,
  sharedRead: 1,
};

function isMechanicOrEntity(node: Node): boolean {
  return node.kind === "mechanic" || node.kind === "entity";
}

/**
 * Find mechanic/entity pairs that are related by the model (shared properties or
 * a shared neighbour) but have no interaction edge and no intentional-none
 * record. Output is sorted by score (descending) then ids, and stable.
 */
export function findGhostEdges(model: Model): GhostEdge[] {
  const agents = model.nodes.filter(isMechanicOrEntity);
  const interactionPairs = new Set<string>();
  for (const edge of model.edges) {
    if (edge.kind !== "interaction") continue;
    interactionPairs.add([edge.from, edge.to].sort().join("\u0000"));
  }
  const ignoredPairs = new Set<string>();
  for (const ni of model.noInteraction) {
    ignoredPairs.add([ni.a, ni.b].sort().join("\u0000"));
  }

  // neighbours reachable through any edge, for the "shared third node" rule
  const neighbours = new Map<string, Set<string>>();
  const addLink = (a: string, b: string): void => {
    if (a === b) return;
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  };
  for (const edge of model.edges) {
    addLink(edge.from, edge.to);
  }

  const result: GhostEdge[] = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i]!;
      const b = agents[j]!;
      const key = [a.id, b.id].sort().join("\u0000");
      if (interactionPairs.has(key) || ignoredPairs.has(key)) continue;

      const reasons = collectReasons(a, b);
      let sharesThirdNode = false;
      const nb = neighbours.get(a.id) ?? new Set<string>();
      for (const shared of nb) {
        if (shared !== b.id && neighbours.get(b.id)?.has(shared)) {
          sharesThirdNode = true;
          break;
        }
      }
      if (reasons.length === 0 && !sharesThirdNode) continue;

      const score = reasons.reduce((sum, r) => sum + WEIGHT[r.kind], 0) + (sharesThirdNode ? 1 : 0);
      result.push({ a: a.id, b: b.id, reasons, score });
    }
  }
  result.sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return result;
}

function collectReasons(a: Node, b: Node): GhostReason[] {
  const reasons: GhostReason[] = [];
  const add = (r: GhostReason): void => {
    if (!reasons.some((e) => e.kind === r.kind && e.property === r.property && e.target === r.target)) {
      reasons.push(r);
    }
  };

  const aMech = a.kind === "mechanic" ? a : undefined;
  const bMech = b.kind === "mechanic" ? b : undefined;
  const aEntity = a.kind === "entity" ? a : undefined;
  const bEntity = b.kind === "entity" ? b : undefined;

  if (aMech && bMech) {
    const writesA = new Set(aMech.writes);
    const writesB = new Set(bMech.writes);
    const readsA = new Set(aMech.reads);
    const readsB = new Set(bMech.reads);
    for (const p of writesA) if (writesB.has(p)) add({ kind: "sharedWrite", property: p });
    for (const p of readsA) if (readsB.has(p)) add({ kind: "sharedRead", property: p });
    for (const p of writesA) if (readsB.has(p)) add({ kind: "readWrite", property: p });
    for (const p of writesB) if (readsA.has(p)) add({ kind: "readWrite", property: p });
  }

  // mechanic acting on (reading or writing) a property the entity has
  for (const [mech, ent] of [[aMech, bEntity], [bMech, aEntity]] as [MechanicNode | undefined, EntityLike?][]) {
    if (!mech || !ent) continue;
    for (const p of ent.has) {
      if (mech.writes.includes(p) || mech.reads.includes(p)) add({ kind: "sharedTarget", target: p });
    }
  }
  return reasons;
}

interface EntityLike {
  has: string[];
}

export const ghostEdgesCheck: Check = {
  id: "ghost-edges",
  name: "Ghost edges (related but unconnected)",
  run(model) {
    const ghosts = findGhostEdges(model);
    const findings: Finding[] = [];
    for (const g of ghosts) {
      const a = model.nodes.find((n) => n.id === g.a);
      const b = model.nodes.find((n) => n.id === g.b);
      const reasonSummary = summarizeReasons(g.reasons);
      findings.push({
        id: `ghost-edges:${[g.a, g.b].sort().join(",")}`,
        check: "ghost-edges",
        severity: "warning",
        title: `${a?.name ?? g.a} and ${b?.name ?? g.b} do not interact but ${reasonSummary}`,
        detail:
          `${a?.name ?? g.a} and ${b?.name ?? g.b} appear related (${reasonSummary}) but have no interaction edge.`,
        nodes: [g.a, g.b],
        edges: [],
        data: { reasons: g.reasons, score: g.score },
      });
    }
    return findings;
  },
};

function summarizeReasons(reasons: GhostReason[]): string {
  if (reasons.length === 0) return "share a neighbour";
  const parts = reasons.map((r) => {
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
  });
  return parts.join(", ");
}
