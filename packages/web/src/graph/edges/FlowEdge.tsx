import { useMemo } from "react";
import type { EdgeProps } from "reactflow";
import { clipBadge, type FlowEdgeData } from "../toFlow.js";
import { placeLabel } from "./labelPlacement.js";
import { polyline } from "./floating.js";
import { useFloatingPath } from "./useFloatingPath.js";

/**
 * Single renderer for every mechflow edge.
 *
 * - edges float: each runs border to border between its nodes on the sides
 *   that face each other, as a gentle curve (see floating.ts). Economy nodes
 *   are met at their symbol, treated as a circle.
 * - flow edges in a resource chain take the chain's colour (chains.ts).
 * - flow / interaction: solid stroke; state: dashed. Flow edges carry a slow,
 *   faint drift of dashes from source to target so direction always reads.
 * - interaction: darker ink than economy flow/state.
 * - gate edges are drawn heavier than modifier edges.
 * - flow edges show their rate on a badge (see toFlow's flowRate), with the
 *   edge's name as a hover title; other kinds show polarity and name.
 * - during a run, an edge that moved resources in the latest step is amber
 *   with dots streaming along it and the amount moved on its badge; an edge
 *   that wanted to move resources but moved none is red and dashed, showing 0.
 * - during a run, a state edge whose source changed in the latest step pulses
 *   its dashes from source to target and shows the source's new value beside
 *   its badge, so cause and effect read along the dashed lines.
 * - each step, a moving edge sends one token per resource moved (up to
 *   {@link MAX_TOKENS}) from its source to its target.
 * - the badge moves along the path when its midpoint is under a node card
 *   (see labelPlacement.ts).
 */
const STROKE: Record<FlowEdgeData["kind"], string> = {
  flow: "var(--text-2)",
  state: "var(--cyan)",
  interaction: "var(--text)",
};

const MOVING_STROKE = "var(--moving)";

/** Most tokens drawn per edge per step; larger amounts still show on the badge. */
export const MAX_TOKENS = 6;
/** How long (s) one token takes to travel the edge. */
const TOKEN_SECONDS = 0.6;
const STARVED_STROKE = "var(--danger)";

export function FlowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  data,
}: EdgeProps<FlowEdgeData>): JSX.Element {
  const kind = data?.kind ?? "flow";
  const strength = data?.strength;
  const polarity = data?.polarity;
  const moving = data?.moving ?? false;
  const starved = !moving && (data?.starved ?? false);
  const signal = data?.signal;
  const stroke = moving ? MOVING_STROKE : starved ? STARVED_STROKE : (data?.chain ?? STROKE[kind] ?? "var(--text-2)");
  const width = (strength === "gate" ? 4 : strength === "modifier" ? 2 : 3) + (moving || signal !== undefined ? 1 : 0);
  const markerId = `arrow-${id}`;
  const { path, cards } = useFloatingPath(source, target, { x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const amount = data?.movedAmount;
  // Flow edges show their rate, as Machinations does; the edge's name moves to
  // the hover title. Other kinds keep the name. During a run, what moved shows
  // on a chip beside the badge, so the rate stays readable.
  const name = typeof label === "string" ? label : "";
  const rate = data?.rate;
  const fullBadge = [polarity ?? "", rate ?? name].filter((part) => part !== "").join(" ");
  const moved = moving && amount ? `${amount}` : starved ? "0" : signal !== undefined ? formatSignal(signal) : "";
  const movedW = moved.length * 7 + 12;
  const badge = clipBadge(fullBadge);
  const tooltip = [name, rate !== undefined ? `${rate}/step` : ""].filter((part) => part !== "").join(": ");
  const rectW = badge.length * 7 + 10;
  const { x: labelX, y: labelY } = useMemo(() => {
    if (badge.length === 0) return path.mid;
    return placeLabel(polyline(path.points), { width: rectW, height: 18 }, cards, path.mid);
  }, [badge, path, cards, rectW]);
  // When a finding highlight is active, edges outside the finding are dimmed;
  // `highlighted` is `undefined` when no highlight is active (fully visible).
  const highlighted = data?.highlighted ?? true;
  const dash = kind === "state" || starved ? "6 4" : "0";

  return (
    <svg style={{ ...overlay, opacity: highlighted ? 1 : 0.3 }}>
      <defs>
        <marker
          id={markerId}
          markerWidth="14"
          markerHeight="14"
          refX="11"
          refY="7"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,1 L12,7 L0,13 z" fill={stroke} />
        </marker>
      </defs>
      <path
        data-testid="flow-edge"
        data-edge-id={id}
        data-highlighted={String(highlighted)}
        data-moving={String(moving)}
        data-starved={String(starved)}
        data-kind={kind}
        data-strength={strength ?? ""}
        data-polarity={polarity ?? ""}
        fill="none"
        stroke={stroke}
        strokeWidth={width}
        strokeDasharray={dash}
        className={signal !== undefined ? "signal-pulse" : undefined}
        d={path.d}
        markerEnd={`url(#${markerId})`}
      />
      {(moving || (kind === "flow" && !starved)) && (
        <path
          data-testid={moving ? "flow-pulse" : "flow-drift"}
          className={moving ? "flow-pulse" : "flow-drift"}
          fill="none"
          stroke={moving ? "var(--moving-pulse)" : "var(--surface)"}
          strokeWidth={moving ? width - 1 : 1.5}
          strokeLinecap="round"
          strokeDasharray={moving ? "1 15" : "4 20"}
          d={path.d}
        />
      )}
      {moving && amount !== undefined && amount > 0 && (
        // Keyed on the step so a fresh group (and animation) mounts each step.
        <g key={data?.movedStep ?? 0} ref={startTokens} className="flow-tokens" data-testid="flow-tokens">
          {Array.from({ length: Math.min(Math.ceil(amount), MAX_TOKENS) }, (_, i) => (
            <circle key={i} r="5" fill="var(--moving)" stroke="var(--surface)" strokeWidth="1.5" opacity="0">
              <animateMotion
                data-delay={(i * TOKEN_SECONDS) / (MAX_TOKENS + 2)}
                dur={`${TOKEN_SECONDS}s`}
                begin="indefinite"
                fill="freeze"
                path={path.d}
              />
              <animate
                attributeName="opacity"
                values="1;1;0"
                keyTimes="0;0.85;1"
                data-delay={(i * TOKEN_SECONDS) / (MAX_TOKENS + 2)}
                dur={`${TOKEN_SECONDS}s`}
                begin="indefinite"
                fill="freeze"
              />
            </circle>
          ))}
        </g>
      )}
      {badge.length > 0 && (
        // The badge takes the pointer so its title shows on hover; clicks still
        // bubble to React Flow's edge handler.
        <g transform={`translate(${labelX}, ${labelY})`} style={{ pointerEvents: "auto", cursor: "pointer" }}
          data-testid="edge-badge">
          {tooltip && <title>{tooltip}</title>}
          <rect
            x={-rectW / 2}
            y="-9"
            width={rectW}
            height="18"
            rx="9"
            fill="var(--surface)"
            stroke={stroke}
            strokeWidth="1"
          />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="11"
            fontWeight={600}
            fill={stroke}
          >
            {badge}
          </text>
          {moved && (
            <g transform={`translate(${rectW / 2 + 3 + movedW / 2}, 0)`} data-testid="edge-moved">
              <rect x={-movedW / 2} y="-9" width={movedW} height="18" rx="9" fill={stroke} />
              <text textAnchor="middle" dominantBaseline="central" fontSize="11" fontWeight={700}
                fill="var(--surface)">
                {moved}
              </text>
            </g>
          )}
        </g>
      )}
    </svg>
  );
}

/** A state edge's signal value, short enough for its chip (0.6406 reads 0.64). */
export function formatSignal(value: number): string {
  return `${Math.round(value * 100) / 100}`;
}

/**
 * SMIL `begin` times count from page load, so a token group mounted mid-session
 * would find its animations already over. Start them from now instead.
 */
export function startTokens(group: SVGGElement | null): void {
  group?.querySelectorAll<SVGAnimationElement>("animate, animateMotion").forEach((a) => {
    a.beginElementAt?.(Number(a.dataset.delay ?? 0));
  });
}

const overlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  // Layout positions can be negative; without this the svg clips those edges.
  overflow: "visible",
  pointerEvents: "none",
  width: "100%",
  height: "100%",
};
