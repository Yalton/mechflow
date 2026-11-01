import { useState } from "react";
import { NODE_KINDS } from "./nodeFactory.js";
import { SymbolIcon, type SymbolShape } from "./nodes/Symbol.js";

/** The symbol each economy kind is drawn with (nodes/*Node.tsx). */
const SHAPES: Record<string, SymbolShape> = {
  source: "triangle",
  pool: "circle",
  drain: "triangle-down",
  converter: "converter",
  gate: "diamond",
  register: "square",
};

/**
 * Drag-and-drop palette of node kinds, as a strip of symbol icons. Each item is a native HTML5 draggable
 * that stamps its kind onto the `dataTransfer`; the {@link GraphView} React Flow
 * panel reads it on `onDrop` to create a node at the drop point.
 *
 * It sits over the top-left of the canvas, so it collapses to one button to
 * uncover the nodes and zoom controls beneath it. It starts collapsed when
 * the canvas already has nodes (`startCollapsed`) and open on an empty one,
 * where it is the way to begin.
 *
 * Presentational only: it knows nothing about the editor store, so it is trivial
 * to render in isolation and test.
 */
export function Palette({ startCollapsed = false }: { startCollapsed?: boolean }): JSX.Element {
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const groups = grouped();
  return (
    <div data-testid="palette" data-collapsed={String(collapsed)} style={collapsed ? collapsedPalette : palette}>
      <button
        type="button"
        data-testid="palette-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        style={toggle}
        title={collapsed ? "Show the node palette" : "Hide the node palette"}
      >
        {collapsed ? "+ Add node" : "✕"}
      </button>
      {!collapsed && groups.map((group, index) => (
        <div key={group.label} style={groupBlock} role="group" aria-label={group.label}>
          {index > 0 && <span style={divider} />}
          {group.kinds.map((kind) => (
            <PaletteItem key={kind.kind} kind={kind} />
          ))}
        </div>
      ))}
    </div>
  );
}

function grouped(): Array<{ label: string; kinds: typeof NODE_KINDS }> {
  const order: readonly string[] = ["Economy", "Mechanics"];
  return order.map((label) => ({ label, kinds: NODE_KINDS.filter((k) => k.group === label) }));
}

function PaletteItem({ kind }: { kind: typeof NODE_KINDS[number] }): JSX.Element {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/mechflow-node-kind", kind.kind);
        // Firefox needs an effect set or the drag is ignored.
        event.dataTransfer.effectAllowed = "copy";
      }}
      data-testid={`palette-item-${kind.kind}`}
      data-kind={kind.kind}
      style={item}
      title={`${kind.label}: drag onto the canvas`}
      aria-label={kind.label}
    >
      {SHAPES[kind.kind]
        ? <SymbolIcon shape={SHAPES[kind.kind]!} />
        : <span style={cardIcon}>{kind.label.charAt(0)}</span>}
      <span style={itemLabel}>{kind.label}</span>
    </div>
  );
}

// Placed by GraphView in the canvas's top-left corner.
const palette: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "2px",
  background: "var(--surface-glass)",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  padding: "4px",
  boxShadow: "var(--shadow)",
};

const collapsedPalette: React.CSSProperties = { ...palette, padding: 0, border: "none", background: "none" };

const toggle: React.CSSProperties = { boxShadow: "var(--shadow)" };

const groupBlock: React.CSSProperties = { display: "flex", alignItems: "center", gap: "2px" };

const divider: React.CSSProperties = {
  width: "1px",
  height: "28px",
  margin: "0 4px",
  background: "var(--border)",
};

const item: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "1px",
  width: "52px",
  padding: "4px 2px 3px",
  borderRadius: "6px",
  color: "var(--text-2)",
  cursor: "grab",
};

const itemLabel: React.CSSProperties = { fontSize: "9.5px", lineHeight: 1.1 };

const cardIcon: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "26px",
  height: "20px",
  margin: "1px 0",
  border: "2px solid currentColor",
  borderRadius: "4px",
  fontSize: "10px",
  fontWeight: 700,
};
