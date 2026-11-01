import type { NodeProps } from "reactflow";
import type { ConverterNode as ConverterCore } from "@mechflow/core";
import { EconomySymbol } from "./Symbol.js";

/** Converter: a triangle with a bar, turning its inputs into its outputs. */
export function ConverterNode({ data }: NodeProps) {
  const converter = data.node as ConverterCore;
  const inputs = converter.inputs.map((i) => `${i.amount} ${i.resource}`).join(" + ");
  const outputs = converter.outputs.map((o) => `${o.amount} ${o.resource}`).join(" + ");
  return (
    <EconomySymbol
      testId="flow-node-converter"
      shape="converter"
      name={data.name}
      tier={data.tier}
      chain={data.chain}
      interactive={converter.activation === "interactive"}
      tracePolarity={data.tracePolarity}
      meta={<span title={`${inputs || "—"} → ${outputs || "—"}`}>{inputs || "—"} → {outputs || "—"}</span>}
    />
  );
}
