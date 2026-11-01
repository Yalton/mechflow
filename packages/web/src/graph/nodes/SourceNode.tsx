import type { NodeProps } from "reactflow";
import type { SourceNode as SourceCore } from "@mechflow/core";
import { EconomySymbol } from "./Symbol.js";

/** Economy source: a triangle that produces resources each step. */
export function SourceNode({ data }: NodeProps) {
  const source = data.node as SourceCore;
  return (
    <EconomySymbol
      testId="flow-node-source"
      shape="triangle"
      name={data.name}
      tier={data.tier}
      chain={data.chain}
      tracePolarity={data.tracePolarity}
      interactive={source.activation === "interactive"}
      meta={source.activation === "interactive" ? `+${source.rate} per fire` : `+${source.rate}/step`}
    />
  );
}
