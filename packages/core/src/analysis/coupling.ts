import type { Model } from "../model/types.js";
import type { AnalysisIndex, Check, Finding } from "./types.js";

interface ItemMap {
  writers: Set<string>;
  readers: Set<string>;
}

/**
 * Coupling map: for each property and pool, the subsystems that read or write
 * it. Mechanics read/write properties, entities "have" properties (counted as
 * readers), and pools are fed/consumed by flow edges.
 */
export function buildCouplingMap(model: Model, index: AnalysisIndex): Map<string, ItemMap> {
  const subsystemOf = (nodeId: string | undefined): string => {
    if (!nodeId) return "";
    return index.nodeById.get(nodeId)?.subsystem ?? "";
  };
  const map = new Map<string, ItemMap>();
  const get = (id: string): ItemMap => {
    let entry = map.get(id);
    if (!entry) {
      entry = { writers: new Set(), readers: new Set() };
      map.set(id, entry);
    }
    return entry;
  };

  for (const property of model.properties) {
    const entry = get(property.id);
    for (const node of model.nodes) {
      if (node.kind === "mechanic") {
        if (node.writes.includes(property.id)) entry.writers.add(subsystemOf(node.id));
        if (node.reads.includes(property.id)) entry.readers.add(subsystemOf(node.id));
      } else if (node.kind === "entity" && node.has.includes(property.id)) {
        entry.readers.add(subsystemOf(node.id));
      }
    }
  }

  for (const pool of model.nodes.filter((n) => n.kind === "pool")) {
    const entry = get(pool.id);
    for (const edge of model.edges) {
      if (edge.kind !== "flow") continue;
      if (edge.to === pool.id) entry.writers.add(subsystemOf(edge.from));
      if (edge.from === pool.id) entry.readers.add(subsystemOf(edge.to));
    }
  }
  return map;
}

export const couplingCheck: Check = {
  id: "coupling",
  name: "Coupling through shared properties and pools",
  run(model, index) {
    const map = buildCouplingMap(model, index);
    const findings: Finding[] = [];
    for (const [item, { writers, readers }] of map) {
      const subsystems = Array.from(new Set([...writers, ...readers])).filter(Boolean).sort();
      if (subsystems.length < 2) continue;
      const writerList = Array.from(writers).filter(Boolean).sort();
      const readerList = Array.from(readers).filter(Boolean).sort();
      findings.push({
        id: `coupling:${item}`,
        check: "coupling",
        severity: "info",
        title: `${item} is shared across ${subsystems.length} subsystems`,
        detail:
          `${item} is written by subsystems ${writerList.length ? writerList.join(", ") : "(none)"} ` +
          `and read by subsystems ${readerList.length ? readerList.join(", ") : "(none)"}.`,
        nodes: [],
        edges: [],
        data: { item, readers: readerList, writers: writerList, subsystems },
      });
      if (writerList.length >= 3) {
        findings.push({
          id: `coupling:${item}:universal-bottleneck`,
          check: "coupling",
          severity: "warning",
          title: `${item} is written by ${writerList.length} subsystems (universal bottleneck risk)`,
          detail: `A property or pool written by 3+ subsystems is a shared resource that is hard to keep consistent.`,
          nodes: [],
          edges: [],
          data: { item, writers: writerList, subsystems },
        });
      }
    }
    return findings;
  },
};
