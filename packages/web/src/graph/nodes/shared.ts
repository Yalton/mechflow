import type { CSSProperties } from "react";

/**
 * Shared styling for custom React Flow node bodies. Each node kind composes
 * {@link nodeBody} with {@link tierFill} so subsystem tier tints the border.
 */

export type NodeShape = "circle" | "rounded" | "square";

/** Base container style; `shape` controls the corner radius. */
export function nodeBody(shape: NodeShape = "rounded"): CSSProperties {
  const radius = shape === "circle" ? "50%" : shape === "rounded" ? "12px" : "4px";
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "3px",
    padding: "8px 10px",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: radius,
    boxShadow: "0 1px 3px rgba(2, 8, 23, 0.12)",
    textAlign: "center",
    fontSize: "12px",
    color: "var(--text)",
    userSelect: "none",
  };
}

/** Subsystem-tier border tint: core blue, support green, flavor purple. */
export function tierFill(tier?: string): CSSProperties {
  switch (tier) {
    case "core":
      return { borderColor: "#2563eb" };
    case "support":
      return { borderColor: "#16a34a" };
    case "flavor":
      return { borderColor: "#9333ea" };
    default:
      return { borderColor: "var(--border-strong)" };
  }
}

// Wraps to at most two lines and stays inside its node, so a long name never
// spills over a circular pool's edge.
export const nodeLabel: CSSProperties = {
  fontWeight: 600,
  lineHeight: 1.2,
  maxWidth: "min(120px, 100%)",
  overflow: "hidden",
  overflowWrap: "anywhere",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

export const nodeMeta: CSSProperties = {
  fontSize: "10px",
  color: "var(--text-2)",
  lineHeight: 1.3,
  maxWidth: "130px",
};

export const nodeChip: CSSProperties = {
  fontSize: "10px",
  padding: "1px 5px",
  borderRadius: "999px",
  background: "var(--accent-soft)",
  color: "var(--violet-text)",
  border: "1px solid var(--violet-border)",
};

/**
 * Polarity badge shown on a node when a depth trace marks the node's cumulative
 * polarity sign. `+` signs are tinted support-green; `-` signs, inverted-red.
 * Rendered only when `data.tracePolarity` is set by {@link applyTrace}.
 */
export function nodePolarity(polarity: "+" | "-"): CSSProperties {
  return {
    ...nodeChip,
    fontVariant: "normal",
    fontWeight: 700,
    minWidth: "14px",
    textAlign: "center",
    color: polarity === "+" ? "#16a34a" : "#dc2626",
    borderColor: polarity === "+" ? "var(--ok-border)" : "var(--danger-border)",
    background: polarity === "+" ? "var(--ok-soft)" : "var(--danger-soft)",
  };
}
