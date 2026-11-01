import type { Check, Finding } from "./types.js";

type Relation = "reads" | "writes" | "has";

/**
 * Flag mechanic `reads`/`writes` and entity `has` entries that name a property
 * missing from the model's `properties:` list. Other checks (ghost edges,
 * coupling, the property layer) only follow declared properties, so an
 * undeclared one is silently ignored everywhere else.
 */
export const undeclaredPropertiesCheck: Check = {
  id: "undeclared-properties",
  name: "References to undeclared properties",
  run(model, index) {
    const findings: Finding[] = [];
    for (const node of model.nodes) {
      const relations: [Relation, string[]][] =
        node.kind === "mechanic" ? [["reads", node.reads], ["writes", node.writes]]
          : node.kind === "entity" ? [["has", node.has]]
            : [];
      for (const [relation, propertyIds] of relations) {
        for (const property of new Set(propertyIds)) {
          if (index.properties.has(property)) continue;
          findings.push({
            id: `undeclared-properties:${node.id}:${relation}:${property}`,
            check: "undeclared-properties",
            severity: "warning",
            title: `"${node.name}" ${relation} undeclared property "${property}"`,
            detail: `"${property}" is not in the model's properties list, so ghost-edge, coupling and ` +
              `property-layer analysis ignore this reference. Declare "${property}" under properties: ` +
              `or fix the name in ${node.id}.${relation}.`,
            nodes: [node.id],
            edges: [],
            data: { relation, property },
          });
        }
      }
    }
    return findings;
  },
};
