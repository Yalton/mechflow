import type { CSSProperties, ReactNode } from "react";
import { nodePolarity } from "./shared.js";

/**
 * Economy nodes are drawn the Machinations way: a small symbol whose shape
 * says what the node does, with the name underneath. The React Flow node is
 * {@link SYMBOL_BOX} wide so the name has room; edges attach to the symbol at
 * the top of that box, not to the box (see edges/floating.ts). An
 * interactive node, which acts only when the player fires it, gets a second
 * outline inside the first, as in Machinations.
 */

/** Side (px) of the square the symbol is drawn in. */
export const SYMBOL_SIZE = 34;

/** Width (px) of the whole node: the symbol plus room for its name. */
export const SYMBOL_BOX = 120;

/** Scale of an interactive node's inner outline. */
const INNER = 0.68;

export type SymbolShape = "circle" | "triangle" | "triangle-down" | "diamond" | "converter" | "square";

/** Subsystem-tier colour of the symbol's outline and name. */
export function tierColor(tier?: string): string {
  switch (tier) {
    case "core":
      return "var(--accent)";
    case "support":
      return "var(--ok)";
    case "flavor":
      return "var(--violet)";
    default:
      return "var(--text-2)";
  }
}

function outline(shape: SymbolShape): JSX.Element {
  const s = SYMBOL_SIZE;
  const m = 2; // half the stroke, so the outline stays inside the box
  switch (shape) {
    case "circle":
      return <circle cx={s / 2} cy={s / 2} r={s / 2 - m} />;
    case "triangle":
      return <path d={`M${s / 2},${m} L${s - m},${s - m} L${m},${s - m} Z`} />;
    case "triangle-down":
      return <path d={`M${m},${m} L${s - m},${m} L${s / 2},${s - m} Z`} />;
    case "diamond":
      return <path d={`M${s / 2},${m} L${s - m},${s / 2} L${s / 2},${s - m} L${m},${s / 2} Z`} />;
    case "converter":
      // A triangle pointing right with a bar at its tip, as in Machinations.
      return (
        <>
          <path d={`M${m + 2},${m + 2} L${s - 8},${s / 2} L${m + 2},${s - m - 2} Z`} />
          <path d={`M${s - 5},${m + 2} L${s - 5},${s - m - 2}`} />
        </>
      );
    case "square":
      return <rect x={m} y={m} width={s - 2 * m} height={s - 2 * m} rx="4" />;
  }
}

/** Just the symbol's outline, at `size` px, for the palette. */
export function SymbolIcon({ shape, size = 22 }: { shape: SymbolShape; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${SYMBOL_SIZE} ${SYMBOL_SIZE}`} aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round">
        {outline(shape)}
      </g>
    </svg>
  );
}

export interface EconomySymbolProps {
  testId: string;
  shape: SymbolShape;
  name: string;
  tier?: string;
  /** Resource chain colour; takes the place of the tier colour. */
  chain?: string;
  /** Acts only when fired (activation: interactive); drawn with a double outline. */
  interactive?: boolean;
  /** Text inside the symbol (a pool's amount, a register's fx). */
  inside?: ReactNode;
  /** A short line under the name (a rate, a formula, a capacity). */
  meta?: ReactNode;
  tracePolarity?: "+" | "-";
  /** Extra content inside the symbol's square (a pool's fill). */
  children?: ReactNode;
}

export function EconomySymbol({
  testId,
  shape,
  name,
  tier,
  chain,
  interactive = false,
  inside,
  meta,
  tracePolarity,
  children,
}: EconomySymbolProps): JSX.Element {
  const color = chain ?? tierColor(tier);
  return (
    <div
      data-testid={testId}
      data-tier={tier}
      data-shape={shape}
      data-chain={chain}
      data-interactive={interactive || undefined}
      style={box}
      title={interactive ? `${name} (fires on click)` : name}
    >
      <div style={symbolBox}>
        <svg width={SYMBOL_SIZE} height={SYMBOL_SIZE} style={svg}>
          <g fill="var(--surface)" stroke={color} strokeWidth="2.5" strokeLinejoin="round">
            {outline(shape)}
          </g>
          {interactive && (
            <g
              data-testid="interactive-outline"
              fill="none"
              stroke={color}
              strokeWidth={1.5 / INNER}
              strokeLinejoin="round"
              transform={`translate(${SYMBOL_SIZE / 2} ${SYMBOL_SIZE / 2}) scale(${INNER}) translate(${-SYMBOL_SIZE / 2} ${-SYMBOL_SIZE / 2})`}
            >
              {outline(shape)}
            </g>
          )}
        </svg>
        {children}
        {inside !== undefined && <span style={{ ...insideText, color }}>{inside}</span>}
        {tracePolarity !== undefined && (
          <span style={{ ...nodePolarity(tracePolarity), position: "absolute", top: -6, right: -14 }}>
            {tracePolarity}
          </span>
        )}
      </div>
      <span style={{ ...nameText, color }}>{name}</span>
      {meta !== undefined && <span style={metaText}>{meta}</span>}
    </div>
  );
}

const box: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "2px",
  width: `${SYMBOL_BOX}px`,
  userSelect: "none",
  textAlign: "center",
};

const symbolBox: CSSProperties = {
  position: "relative",
  width: `${SYMBOL_SIZE}px`,
  height: `${SYMBOL_SIZE}px`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const svg: CSSProperties = { position: "absolute", inset: 0, overflow: "visible" };

const insideText: CSSProperties = {
  position: "relative",
  fontSize: "11px",
  fontWeight: 700,
  lineHeight: 1,
  fontVariantNumeric: "tabular-nums",
};

const nameText: CSSProperties = {
  maxWidth: "100%",
  fontSize: "11px",
  fontWeight: 600,
  lineHeight: 1.2,
  overflowWrap: "anywhere",
};

const metaText: CSSProperties = {
  maxWidth: "100%",
  fontSize: "10px",
  lineHeight: 1.2,
  color: "var(--text-3)",
  fontVariantNumeric: "tabular-nums",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
