import { useCallback, useMemo } from "react";
import type {
  GhostEdge,
  InteractionMatrix,
  MatrixCell,
  Report,
} from "@mechflow/core";

/**
 * MatrixView: renders the interaction matrix as a grid over mechanic/entity ids.
 *
 * The grid's rows and columns are {@link Report.matrix.ids} (mechanic + entity
 * nodes, sorted). Each cell reports the relationship between the row and column
 * pair: cells with an interaction edge show the edge labels; cells with a
 * `noInteraction` record show a neutral mark and the reason on hover; ghost-edge
 * cells (related but unconnected) are highlighted; empty cells stay blank.
 *
 * Clicking a cell selects the pair on the graph (both nodes, plus the
 * interaction edge where one exists), mirroring the canvas-click selection that
 * the Inspector reads. The panel renders inside the React Flow provider so it
 * can reach the store; the selection state is owned by the parent, as always.
 */

/** React Flow store shape as captured by {@link GraphView}. */
type MatrixFlowStoreLike = {
  getState: () => {
    addSelectedNodes: (ids: string[]) => void;
    setEdgesSelected?: (ids: string[], selected: boolean) => void;
  };
};

/** Stable key for a pair, order-insensitive, matching the core matrix builder. */
const CELL_KEY = (a: string, b: string): string =>
  [a, b].sort().join("\u0000");

type CellKind = "edges" | "intentionalNone" | "ghost" | "empty";

interface CellState {
  kind: CellKind;
  /** Interaction edge ids shown as labels; empty for other kinds. */
  labels: string[];
  /** `noInteraction` reason (hover title) or undefined. */
  reason?: string;
}

/**
 * Resolve a grid cell's relationship from the matrix and ghost-edge sets. Both
 * are keyed by the order-insensitive {@link CELL_KEY} so `(a,b)` and `(b,a)`
 * resolve identically — the grid is symmetric.
 */
function resolveCell(
  a: string,
  b: string,
  cells: Map<string, MatrixCell>,
  ghosts: Map<string, GhostEdge>,
): CellState {
  const key = CELL_KEY(a, b);
  const cell = cells.get(key);
  if (cell) {
    return {
      kind: cell.intentionalNone ? "intentionalNone" : "edges",
      labels: [...cell.edges],
      reason: cell.intentionalNone,
    };
  }
  const ghost = ghosts.get(key);
  if (ghost) {
    const r = ghost.reasons?.[0];
    return {
      kind: "ghost",
      labels: [],
      reason: r?.property ?? r?.kind,
    };
  }
  return { kind: "empty", labels: [], reason: undefined };
}

const panel: React.CSSProperties = {
  width: "320px",
  padding: "12px 12px 16px",
  boxSizing: "border-box",
  fontSize: "12px",
  borderLeft: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const headerStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: "14px",
  marginBottom: "2px",
};

const cornerTh: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--surface)",
  padding: "4px 6px",
  minWidth: "26px",
};

const axisTh: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
  padding: "4px 6px",
  fontWeight: 600,
  textAlign: "left",
  whiteSpace: "nowrap",
};

const cellBase: React.CSSProperties = {
  border: "1px solid var(--border)",
  padding: "4px 6px",
  textAlign: "left",
  maxWidth: "96px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Distinct visual treatment per cell kind. */
function cellStyle(kind: CellKind): React.CSSProperties {
  switch (kind) {
    case "ghost":
      return { ...cellBase, background: "var(--warning-soft)", borderColor: "var(--warning-border)" };
    case "intentionalNone":
      return { ...cellBase, background: "var(--surface-2)" };
    case "edges":
      return { ...cellBase, background: "var(--accent-soft)", cursor: "pointer" };
    default:
      return { ...cellBase, background: "var(--surface)" };
  }
}

/** Cell body per kind: edge labels, a neutral mark, or a ghost tilde. */
function cellContent(state: CellState): React.ReactNode {
  switch (state.kind) {
    case "edges":
      return (
        <span data-testid="matrix-edge-labels">
          {state.labels.join(", ") || "—"}
        </span>
      );
    case "intentionalNone":
      return <span data-testid="matrix-intentional">—</span>;
    case "ghost":
      return <span data-testid="matrix-ghost">~</span>;
    default:
      return <span />;
  }
}

export interface MatrixViewProps {
  /** The analysis report; carries the interaction matrix and ghost edges. */
  report: Report;
}

/**
 * Rendered inside the React Flow provider so {@link MatrixView}'s click can set
 * canvas selection. The store is captured on `globalThis` by {@link GraphView}.
 */
export function MatrixView({ report }: MatrixViewProps): JSX.Element {
  const matrix: InteractionMatrix = report.matrix;

  /** Matrix cells keyed by order-insensitive pair, for symmetric lookup. */
  const cells = useMemo<Map<string, MatrixCell>>(() => {
    const map = new Map<string, MatrixCell>();
    for (const c of matrix.cells) {
      map.set(CELL_KEY(c.a, c.b), c);
    }
    return map;
  }, [matrix]);

  /** Ghost edges keyed by order-insensitive pair, for symmetric lookup. */
  const ghosts = useMemo<Map<string, GhostEdge>>(() => {
    const map = new Map<string, GhostEdge>();
    for (const g of report.ghostEdges) {
      map.set(CELL_KEY(g.a, g.b), g);
    }
    return map;
  }, [report.ghostEdges]);

  /** Select the pair on the graph; also select the interaction edge if present. */
  const selectPair = useCallback((a: string, b: string, edgeIds: string[]) => {
    const rf = (globalThis as { __rfStore?: MatrixFlowStoreLike }).__rfStore;
    const state = rf?.getState();
    state?.addSelectedNodes([a, b]);
    if (edgeIds.length && state?.setEdgesSelected) {
      state.setEdgesSelected(edgeIds, true);
    }
  }, []);

  return (
    <section data-testid="matrix-panel" style={panel}>
      <h3 style={headerStyle}>Interaction</h3>
      <div
        data-testid="matrix-grid"
        role="grid"
        style={{ overflowX: "auto" }}
      >
        <table style={{ borderCollapse: "collapse", fontSize: "11px" }}>
          <thead>
            <tr>
              <th style={cornerTh} />
              {matrix.ids.map((b) => (
                <th key={b} style={axisTh} data-id={b}>
                  {b}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.ids.map((a) => (
              <tr key={a} data-row={a}>
                <th style={axisTh} data-id={a}>
                  {a}
                </th>
                {matrix.ids.map((b) => {
                  const state = resolveCell(a, b, cells, ghosts);
                  const edgeIds = state.kind === "edges" ? state.labels : [];
                  return (
                    <td
                      key={b}
                      data-testid="matrix-cell"
                      data-a={a}
                      data-b={b}
                      data-kind={state.kind}
                      title={state.reason}
                      role="gridcell"
                      tabIndex={0}
                      onClick={() => selectPair(a, b, edgeIds)}
                      style={cellStyle(state.kind)}
                    >
                      {cellContent(state)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default MatrixView;
