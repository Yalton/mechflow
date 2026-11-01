import type { Check, Finding } from "./types.js";

/** Flag sources whose limited activation cannot limit an automatic pool's pull. */
export const activationPullsCheck: Check = {
  id: "activation-pulls",
  name: "Limited source activation bypassed by automatic pulls",
  run(model, index) {
    const findings: Finding[] = [];
    for (const edge of model.edges) {
      if (edge.kind !== "flow") continue;
      const source = index.nodeById.get(edge.from);
      const pool = index.nodeById.get(edge.to);
      if (source?.kind !== "source" ||
        (source.activation !== "onStart" && source.activation !== "interactive") ||
        pool?.kind !== "pool" ||
        (pool.activation !== undefined && pool.activation !== "automatic") ||
        (pool.act !== undefined && pool.act !== "pull")) continue;
      findings.push({
        id: `activation-pulls:${edge.id}`,
        check: "activation-pulls",
        severity: "warning",
        title: `"${pool.name}" pulls from "${source.name}" every step`,
        detail: `The pool is automatic and pulls even when the ${source.activation} source is inactive. ` +
          "Make the pool passive or push, or gate this flow edge's rate so it only pays on intended steps.",
        nodes: [source.id, pool.id],
        edges: [edge.id],
      });
    }
    return findings;
  },
};
