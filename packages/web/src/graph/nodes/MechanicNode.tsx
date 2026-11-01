import type { NodeProps } from "reactflow";
import type { MechanicNode as MechanicCore } from "@mechflow/core";
import { nodeBody, nodeLabel, nodeMeta, nodePolarity, tierFill } from "./shared.js";

/**
 * Mechanic: a rounded box listing the properties it reads and writes. It glows
 * while firing in a mechanic run (mechanicRun.ts).
 */
export function MechanicNode({ data }: NodeProps) {
  const mechanic = data.node as MechanicCore;
  return (
    <div
      data-testid="flow-node-mechanic"
      data-tier={data.tier}
      data-firing={data.firing || undefined}
      style={{
        ...nodeBody("rounded"),
        ...tierFill(data.tier),
        width: "170px",
        alignItems: "flex-start",
        ...(data.firing ? firing : {}),
      }}
    >
      <span style={nodeLabel}>{data.name}</span>
      <span style={nodeMeta}>reads: {mechanic.reads.join(", ") || "—"}</span>
      <span style={nodeMeta}>writes: {mechanic.writes.join(", ") || "—"}</span>
      {data.tracePolarity !== undefined && (
        <span style={nodePolarity(data.tracePolarity)}>{data.tracePolarity}</span>
      )}
    </div>
  );
}

const firing: React.CSSProperties = {
  borderColor: "var(--moving)",
  boxShadow: "0 0 0 3px var(--moving-pulse), 0 0 18px var(--moving)",
  transition: "box-shadow 0.2s",
};
