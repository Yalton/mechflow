import { useMemo } from "react";
import type { EdgeProps } from "reactflow";
import { clipBadge } from "../toFlow.js";
import { polyline } from "./floating.js";
import { placeLabel } from "./labelPlacement.js";
import { useFloatingPath } from "./useFloatingPath.js";
import { startTokens } from "./FlowEdge.js";

/** React Flow edge type for a mechanic run's links (mechanicRun.ts). */
export const WAVE_EDGE_TYPE = "mechflow-wave-edge";

export interface WaveEdgeData {
  /** Properties carried from the firing mechanic to the one it sets off. */
  properties: string[];
  /** The wave's step, so each step restarts the tokens. */
  step: number;
}

/** Tokens sent along a link each step, and how long each takes (s). */
const TOKENS = 3;
const TOKEN_SECONDS = 0.9;

/**
 * One link of a mechanic run: an amber curve from a mechanic that just fired
 * to a mechanic it sets off, with tokens running along it and a badge naming
 * the properties carried. Drawn on top of the map, like a moving flow edge.
 */
export function WaveEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<WaveEdgeData>): JSX.Element {
  const { path, cards } = useFloatingPath(source, target, { x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const badge = clipBadge((data?.properties ?? []).join(", "));
  const labelW = badge.length * 6.5 + 12;
  const { x: labelX, y: labelY } = useMemo(
    () => placeLabel(polyline(path.points), { width: labelW, height: 18 }, cards, path.mid),
    [path, cards, labelW],
  );
  const markerId = `wave-arrow-${id}`;
  return (
    <svg style={overlay}>
      <defs>
        <marker id={markerId} markerWidth="14" markerHeight="14" refX="11" refY="7" orient="auto"
          markerUnits="userSpaceOnUse">
          <path d="M0,1 L12,7 L0,13 z" fill="var(--moving)" />
        </marker>
      </defs>
      <path data-testid="wave-edge" data-edge-id={id} fill="none" stroke="var(--moving)" strokeWidth={3}
        d={path.d} markerEnd={`url(#${markerId})`} />
      <path className="flow-pulse" fill="none" stroke="var(--moving-pulse)" strokeWidth={2}
        strokeLinecap="round" strokeDasharray="1 15" d={path.d} />
      <g key={data?.step ?? 0} ref={startTokens} className="flow-tokens" data-testid="wave-tokens">
        {Array.from({ length: TOKENS }, (_, i) => (
          <circle key={i} r="5" fill="var(--moving)" stroke="var(--surface)" strokeWidth="1.5" opacity="0">
            <animateMotion data-delay={(i * TOKEN_SECONDS) / TOKENS} dur={`${TOKEN_SECONDS}s`}
              begin="indefinite" fill="freeze" path={path.d} />
            <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.85;1"
              data-delay={(i * TOKEN_SECONDS) / TOKENS} dur={`${TOKEN_SECONDS}s`} begin="indefinite" fill="freeze" />
          </circle>
        ))}
      </g>
      <g transform={`translate(${labelX}, ${labelY})`} data-testid="wave-badge">
        <rect x={-labelW / 2} y="-9" width={labelW} height="18" rx="9" fill="var(--surface)"
          stroke="var(--moving)" strokeWidth="1" />
        <text textAnchor="middle" dominantBaseline="central" fontSize="11" fontWeight={600} fill="var(--moving)">
          {badge}
        </text>
      </g>
    </svg>
  );
}

const overlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "visible",
  pointerEvents: "none",
  width: "100%",
  height: "100%",
};
