import { useMemo } from "react";
import type { EdgeProps } from "reactflow";
import { clipBadge } from "../toFlow.js";
import { polyline } from "./floating.js";
import { placeLabel } from "./labelPlacement.js";
import { useFloatingPath } from "./useFloatingPath.js";

/**
 * Faint dashed arc between two nodes that are related by the model but have no
 * interaction edge. Drawn as a floating curve like flow edges (floating.ts),
 * with a short badge naming the property (e.g. "temperature") placed clear of
 * the cards; every reason in full shows on hover.
 * Rendered as an overlay edge; dimmed when a finding highlight is active.
 * The arc and its label take clicks, which {@link GraphView} turns into the
 * resolve popover (ypg.4).
 */
export function GhostEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<{ reason: string; short?: string; reasons?: string[]; score: number }>): JSX.Element {
  const reason = data?.reason ?? "";
  const badge = clipBadge(data?.short ?? reason);
  const tooltip = (data?.reasons?.length ? data.reasons : [reason]).join("\n");
  const score = data?.score ?? 1;
  const { path, cards } = useFloatingPath(source, target, { x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const d = path.d;
  const labelW = badge.length * 6.5 + 12;
  const { x: labelX, y: labelY } = useMemo(
    () => placeLabel(polyline(path.points), { width: labelW, height: 18 }, cards, path.mid),
    [path, cards, labelW],
  );
  // Lower-score ghosts render fainter; weight scales opacity with score.
  const opacity = Math.min(1, 0.4 + score * 0.12);
  const markerId = `ghost-arrow-${id}`;

  return (
    <svg style={{ ...overlay, opacity }}>
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
          <path d="M0,0 L7,4 L0,8 z" fill="var(--violet-muted)" />
        </marker>
      </defs>
      {/* Wide invisible stroke so the thin dashed arc is easy to click. */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} style={clickable} />
      <path
        data-testid="ghost-edge"
        data-edge-id={id}
        data-reason={reason}
        fill="none"
        stroke="var(--violet-muted)"
        strokeWidth={2}
        strokeDasharray="4 5"
        strokeLinecap="round"
        d={d}
        markerEnd={`url(#${markerId})`}
      />
      <g transform={`translate(${labelX}, ${labelY})`} style={clickable} data-testid="ghost-badge">
        <title>{tooltip}</title>
        <rect
          x={-labelW / 2}
          y="-9"
          width={labelW}
          height="18"
          rx="9"
          fill="var(--surface-glass)"
          stroke="var(--violet-muted)"
          strokeWidth="1"
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="10.5"
          fontWeight={500}
          fill="var(--violet)"
        >
          {badge}
        </text>
      </g>
    </svg>
  );
}

const overlay: React.CSSProperties = {
  position: "absolute",
  // Layout positions can be negative; without this the svg clips those edges.
  overflow: "visible",
  inset: 0,
  pointerEvents: "none",
  width: "100%",
  height: "100%",
};

const clickable: React.CSSProperties = { pointerEvents: "all", cursor: "pointer" };
