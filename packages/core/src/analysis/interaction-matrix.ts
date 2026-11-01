import type { Model } from "../model/types.js";
import type { Check, Finding } from "./types.js";

export interface MatrixCell {
  a: string;
  b: string;
  edges: string[];
  intentionalNone?: string;
}

export interface InteractionMatrix {
  ids: string[];
  cells: MatrixCell[];
}

/**
 * Build the interaction matrix over mechanic and entity nodes. Only pairs with
 * an interaction edge or an intentional-none record are materialised as cells.
 */
export function buildInteractionMatrix(model: Model): InteractionMatrix {
  const ids = model.nodes
    .filter((n) => n.kind === "mechanic" || n.kind === "entity")
    .map((n) => n.id)
    .sort();
  const cellSet = new Map<string, MatrixCell>();
  const put = (cell: MatrixCell): void => {
    const key = [cell.a, cell.b].sort().join("\u0000");
    const existing = cellSet.get(key);
    if (!existing) {
      cellSet.set(key, cell);
    } else {
      existing.edges = [...existing.edges, ...cell.edges];
      if (!existing.intentionalNone && cell.intentionalNone) {
        existing.intentionalNone = cell.intentionalNone;
      }
    }
  };
  for (const edge of model.edges) {
    if (edge.kind !== "interaction") continue;
    put({ a: edge.from, b: edge.to, edges: [edge.id] });
  }
  for (const ni of model.noInteraction) {
    put({ a: ni.a, b: ni.b, edges: [], intentionalNone: ni.reason });
  }
  return { ids, cells: Array.from(cellSet.values()) };
}

export const interactionMatrixCheck: Check = {
  id: "interaction-matrix",
  name: "Interaction matrix and isolated mechanics",
  run(model) {
    const incident = new Map<string, number>();
    for (const edge of model.edges) {
      if (edge.kind !== "interaction") continue;
      incident.set(edge.from, (incident.get(edge.from) ?? 0) + 1);
      incident.set(edge.to, (incident.get(edge.to) ?? 0) + 1);
    }
    const findings: Finding[] = [];
    for (const node of model.nodes) {
      if (node.kind !== "mechanic") continue;
      const count = incident.get(node.id) ?? 0;
      if (count === 0) {
        const links = propertyLinks(model, node.id);
        findings.push({
          id: `interaction-matrix:isolated:${node.id}`,
          check: "interaction-matrix",
          severity: "warning",
          title: links.length === 0
            ? `Mechanic "${node.name}" is isolated (no interaction edges)`
            : `Mechanic "${node.name}" has no declared interactions`,
          detail: links.length === 0
            ? `${node.name} has no interaction edges to any other mechanic or entity.`
            : `${node.name} has no interaction edges, but it is linked through properties: ` +
              `${links.join("; ")}. Add an interaction edge where they affect each other, ` +
              `or a noInteraction record where they do not.`,
          nodes: [node.id],
          edges: [],
          data: { interactions: 0, propertyLinks: links.length },
        });
      } else if (count === 1) {
        findings.push({
          id: `interaction-matrix:single:${node.id}`,
          check: "interaction-matrix",
          severity: "info",
          title: `Mechanic "${node.name}" has a single interaction`,
          detail: `${node.name} participates in exactly one interaction edge.`,
          nodes: [node.id],
          edges: [],
          data: { interactions: 1 },
        });
      }
    }
    return findings;
  },
};

/**
 * How a node is tied to others through properties, one line per link: what it
 * reads that another writes, what it writes that another reads, and what it
 * reads or writes that an entity has. Sorted, for stable output.
 */
function propertyLinks(model: Model, id: string): string[] {
  const node = model.nodes.find((n) => n.id === id);
  if (!node || node.kind !== "mechanic") return [];
  const links: string[] = [];
  for (const other of model.nodes) {
    if (other.id === id) continue;
    if (other.kind === "mechanic") {
      for (const p of node.reads) if (other.writes.includes(p)) links.push(`reads ${p}, which ${other.name} writes`);
      for (const p of node.writes) if (other.reads.includes(p)) links.push(`writes ${p}, which ${other.name} reads`);
    } else if (other.kind === "entity") {
      for (const p of [...new Set([...node.reads, ...node.writes])]) {
        if (other.has.includes(p)) links.push(`uses ${p}, which ${other.name} has`);
      }
    }
  }
  return links.sort();
}
