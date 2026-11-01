import type { NodeProps } from "reactflow";
import type { RegisterNode as RegisterCore } from "@mechflow/core";
import { EconomySymbol } from "./Symbol.js";

/** Register: an fx square computing a value from its formula. */
export function RegisterNode({ data }: NodeProps) {
  const register = data.node as RegisterCore;
  return (
    <EconomySymbol
      testId="flow-node-register"
      shape="square"
      name={data.name}
      tier={data.tier}
      chain={data.chain}
      tracePolarity={data.tracePolarity}
      inside={<i>fx</i>}
      meta={<span style={{ fontFamily: "var(--mono)" }} title={register.formula}>{register.formula}</span>}
    />
  );
}
