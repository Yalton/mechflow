import type { EdgeKind, Polarity } from "../model/types.js";
import { adjacencyFor, simpleCycles, subsystemOf } from "./graph.js";
import type { Check, Finding } from "./types.js";

const KINDS: EdgeKind[] = ["flow", "state", "interaction"];

function edgeBetween(
  index: import("./types.js").AnalysisIndex,
  from: string,
  to: string,
  kinds: EdgeKind[],
): import("../model/types.js").Edge | undefined {
  return index.model.edges.find((e) => e.from === from && e.to === to && kinds.includes(e.kind));
}

export const feedbackLoopsCheck: Check = {
  id: "feedback-loops",
  name: "Signed feedback loops",
  run(model, index) {
    const adj = adjacencyFor(index, KINDS);
    const cycles = simpleCycles(adj);
    const balancingNodeSets = new Set<string>();
    for (const cycle of cycles) {
      if (cycleSign(cycle, index, KINDS) === "balancing") {
        balancingNodeSets.add(cycle.join(","));
      }
    }
    const findings: Finding[] = [];
    for (const cycle of cycles) {
      const sign = cycleSign(cycle, index, KINDS);
      const subsys = new Set<string>();
      for (const nodeId of cycle) {
        const s = subsystemOf(index, nodeId);
        if (s) subsys.add(s);
      }
      const subsystems = Array.from(subsys).sort();
      const crossSubsystem = subsystems.length > 1;
      const nodes = cycle.slice().sort();
      const id = `feedback-loops:${nodes.join(",")}`;
      const sharesBalancing = cycle.some((nodeId) =>
        Array.from(balancingNodeSets).some((key) => key.split(",").includes(nodeId)),
      );
      let severity: "info" | "warning" | "error" = "info";
      if (sign === "balancing") {
        severity = "info";
      } else if (!sharesBalancing) {
        severity = "warning";
      } else {
        severity = "info";
      }
      findings.push({
        id,
        check: "feedback-loops",
        severity,
        title: `${sign} feedback loop of length ${cycle.length}` + (crossSubsystem ? " crossing subsystems" : ""),
        detail:
          `Loop ${cycle.join(" -> ")} is ${sign}` +
          (crossSubsystem ? ` across subsystems ${subsystems.join(", ")}` : "."),
        nodes: nodes.slice(),
        edges: [],
        data: { sign, length: cycle.length, subsystems, crossSubsystem },
      });
    }
    return findings;
  },
};

function cycleSign(
  cycle: string[],
  index: import("./types.js").AnalysisIndex,
  kinds: EdgeKind[],
): "reinforcing" | "balancing" {
  let minus = 0;
  for (let i = 0; i < cycle.length; i++) {
    const from = cycle[i]!;
    const to = cycle[(i + 1) % cycle.length]!;
    const edge = edgeBetween(index, from, to, kinds);
    const polarity: Polarity | undefined = edge?.polarity;
    if (polarity === "-") minus++;
  }
  return minus % 2 === 0 ? "reinforcing" : "balancing";
}
