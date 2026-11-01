import { Handle, Position, type NodeProps } from "reactflow";
import { nodeBody, nodeLabel, nodeMeta, nodePolarity, tierFill } from "./shared.js";

/** Data attached to a property hub, consumed by its renderer. */
export interface PropertyNodeData {
  name: string;
  kind?: string;
  /**
   * Set by {@link applyTrace} when an effect trace is active: the node's
   * cumulative polarity sign along the trace path. Rendered as a marker.
   */
  tracePolarity?: "+" | "-";
}

/**
 * A property rendered as a small hub node. Thin edges connect it to the nodes
 * that read, write, or have it. Shown only when the property layer toggle is on.
 *
 * The hub carries a hidden, non-connectable target handle. React Flow drops any
 * edge whose target node has no handle, so without it no link would render.
 */
export function PropertyNode({ data }: NodeProps<PropertyNodeData>): JSX.Element {
  const name = data?.name ?? "";
  const kind = data?.kind;

  return (
    <div data-testid="property-node" data-property={name} style={container}>
      <Handle type="target" position={Position.Left} isConnectable={false} style={hiddenHandle} />
      <div style={chip}>{name}</div>
      {kind && <div style={meta}>{kind}</div>}
      {data.tracePolarity !== undefined && (
        <div style={nodePolarity(data.tracePolarity)}>{data.tracePolarity}</div>
      )}
    </div>
  );
}

const container: React.CSSProperties = {
  ...nodeBody("circle"),
  borderRadius: "50%",
  width: "56px",
  height: "56px",
  padding: "6px",
  background: "var(--violet-soft)",
  border: "1px solid var(--violet-border)",
  ...tierFill("core"),
  boxShadow: "0 1px 4px rgba(124, 58, 237, 0.18)",
};

const hiddenHandle: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

const chip: React.CSSProperties = {
  ...nodeLabel,
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--violet-text)",
  maxWidth: "60px",
};

const meta: React.CSSProperties = {
  ...nodeMeta,
  fontSize: "9px",
  color: "var(--violet)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
