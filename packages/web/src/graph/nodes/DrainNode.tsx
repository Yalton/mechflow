import type { NodeProps } from "reactflow";
import type { DrainNode as DrainCore } from "@mechflow/core";
import { EconomySymbol } from "./Symbol.js";

/** Economy drain: an inverted triangle that removes resources each step. */
export function DrainNode({ data }: NodeProps) {
  const drain = data.node as DrainCore;
  return (
    <EconomySymbol
      testId="flow-node-drain"
      shape="triangle-down"
      name={data.name}
      tier={data.tier}
      chain={data.chain}
      tracePolarity={data.tracePolarity}
      interactive={drain.activation === "interactive"}
      meta={drain.activation === "interactive" ? `-${drain.rate} per fire` : `-${drain.rate}/step`}
    />
  );
}
