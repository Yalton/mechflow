import type { NodeProps } from "reactflow";
import type { EntityNode as EntityCore } from "@mechflow/core";
import { nodeBody, nodeLabel, nodeChip, nodePolarity, tierFill } from "./shared.js";

/** Entity: a box with chips for each property it owns. */
export function EntityNode({ data }: NodeProps) {
  const entity = data.node as EntityCore;
  return (
    <div
      data-testid="flow-node-entity"
      data-tier={data.tier}
      style={{ ...nodeBody("rounded"), ...tierFill(data.tier), width: "170px", alignItems: "flex-start", gap: "5px" }}
    >
      <span style={nodeLabel}>{data.name}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", justifyContent: "center" }}>
        {entity.has.length > 0
          ? entity.has.map((prop) => (
              <span key={prop} style={nodeChip}>
                {prop}
              </span>
            ))
          : <span style={{ fontSize: "10px", color: "var(--text-3)" }}>—</span>}
      </div>
      {data.tracePolarity !== undefined && (
        <span style={nodePolarity(data.tracePolarity)}>{data.tracePolarity}</span>
      )}
    </div>
  );
}
