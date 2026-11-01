import type { EdgeKind } from "@mechflow/core";

/**
 * Small popover shown when a connection is made, letting the user pick the edge
 * kind. Rendered by {@link GraphView} as an `absolute` overlay (centered) while a
 * connection is pending. Each option is a labelled button with a stable
 * `data-testid` so tests can assert the chosen kind.
 */
export function EdgeKindPopover({
  onSelect,
}: {
  onSelect: (kind: EdgeKind) => void;
}): JSX.Element {
  return (
    <div data-testid="edge-kind-popover" style={popover}>
      <div style={title}>Edge kind</div>
      <div style={options}>
        {KINDS.map((kind) => (
          <button
            key={kind.kind}
            type="button"
            data-testid={`edge-kind-${kind.kind}`}
            title={kind.title}
            onClick={() => onSelect(kind.kind)}
            style={option}
          >
            {kind.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const KINDS: Array<{ kind: EdgeKind; label: string; title: string }> = [
  { kind: "flow", label: "Flow", title: "Economy flow (resource flow)" },
  { kind: "state", label: "State", title: "State edge (condition/trigger)" },
  { kind: "interaction", label: "Interaction", title: "Mechanic interaction" },
];

const popover: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  zIndex: 20,
  background: "var(--surface)",
  border: "1px solid var(--border-strong)",
  borderRadius: "10px",
  boxShadow: "0 6px 24px rgba(2, 8, 23, 0.18)",
  padding: "10px 12px",
  minWidth: "160px",
};

const title: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-2)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: "8px",
};

const options: React.CSSProperties = { display: "flex", gap: "6px" };

const option: React.CSSProperties = {
  flex: 1,
  fontSize: "12px",
  fontWeight: 600,
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid var(--border-strong)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
};
