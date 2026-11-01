import type { NodeProps } from "reactflow";
import type { GateNode as GateCore } from "@mechflow/core";
import { EconomySymbol } from "./Symbol.js";

const MODE_MARK: Record<GateCore["mode"], string> = {
  random: "⚄",
  deterministic: "→",
  condition: "?",
};

/** Gate: a diamond that routes resources; its mark shows the trigger mode. */
export function GateNode({ data }: NodeProps) {
  const gate = data.node as GateCore;
  return (
    <EconomySymbol
      testId="flow-node-gate"
      shape="diamond"
      name={data.name}
      tier={data.tier}
      chain={data.chain}
      tracePolarity={data.tracePolarity}
      inside={MODE_MARK[gate.mode] ?? ""}
      meta={gate.mode}
    />
  );
}
