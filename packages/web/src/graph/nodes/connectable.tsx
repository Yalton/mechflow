import type { CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { SYMBOL_SIZE } from "./Symbol.js";

/**
 * Wrap a node body renderer so it exposes an input (left) and output (right)
 * connect handle. This lets {@link GraphView} add canvas connections without
 * editing each of the eight node components: the node types map applies
 * `connectable()` to every renderer.
 *
 * The wrapped body keeps rendering its own `data-testid`, so selection/highlight
 * tests still find the node body; the handles carry `data-node-id` for tests.
 */
export function connectable(
  Body: React.ComponentType<NodeProps>,
  { symbol = false }: { symbol?: boolean } = {},
): React.ComponentType<NodeProps> {
  // A symbol node's handles sit beside its symbol, not halfway down its name.
  const handleStyle: CSSProperties | undefined = symbol ? { top: SYMBOL_SIZE / 2 } : undefined;
  function Connectable({ id, ...rest }: NodeProps): JSX.Element {
    return (
      <div style={wrapper}>
        <Handle
          type="target"
          position={Position.Left}
          style={handleStyle}
          isConnectable
          data-testid="flow-handle-target"
          data-node-id={id}
        />
        <Body {...rest} id={id} />
        <Handle
          type="source"
          position={Position.Right}
          style={handleStyle}
          isConnectable
          data-testid="flow-handle-source"
          data-node-id={id}
        />
      </div>
    );
  }

  return Connectable;
}

const wrapper: CSSProperties = { position: "relative", display: "flex" };
