import { getSmoothStepPath } from "reactflow";
import type { EdgeProps } from "reactflow";

/**
 * Thin edge from a node to a property hub, styled by relation (reads / writes /
 * has). Rendered only when the property layer toggle is on.
 */
const RELATION_STYLE: Record<string, { stroke: string; dash: string }> = {
  reads: { stroke: "var(--cyan)", dash: "2 3" },
  writes: { stroke: "var(--warning-text)", dash: "5 4" },
  has: { stroke: "var(--lime)", dash: "1 3" },
};
/** Default when a relation is unknown; matches `reads`. Definite under `noUncheckedIndexedAccess`. */
const DEFAULT_STYLE: { stroke: string; dash: string } = { stroke: "var(--cyan)", dash: "2 3" };

export function PropertyLink({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<{ relation: string }>): JSX.Element {
  const relation = data?.relation ?? "reads";
  const style: { stroke: string; dash: string } = RELATION_STYLE[relation] ?? RELATION_STYLE.reads ?? DEFAULT_STYLE;
  const { stroke, dash } = style;
  const markerId = `property-arrow-${id}`;
  const [d] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <svg style={{ ...overlay, opacity: 0.7 }}>
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L7,4 L0,8 z" fill={stroke} />
        </marker>
      </defs>
      <path
        data-testid="property-link"
        data-edge-id={id}
        data-relation={relation}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeDasharray={dash}
        strokeLinecap="round"
        d={d}
        markerEnd={`url(#${markerId})`}
      />
    </svg>
  );
}

const overlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  width: "100%",
  height: "100%",
};
