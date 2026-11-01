import { useState } from "react";
/**
 * Graph toolbar, behind the View button: the ghost-edge score threshold
 * slider, the property-layer toggle, and resource chain colours (chains.ts),
 * which are on by default; off, economy nodes take their subsystem colour. Display controls for the viewer, owned here so the graph can react to
 * them. Styled to sit over the graph corner like the Re-layout button.
 */

export function Toolbar({
  ghostThreshold,
  showPropertyLayer,
  chainColours = true,
  onThresholdChange,
  onPropertyLayerChange,
  onChainColoursChange,
}: {
  ghostThreshold: number;
  showPropertyLayer: boolean;
  chainColours?: boolean;
  onThresholdChange: (value: number) => void;
  onPropertyLayerChange: (on: boolean) => void;
  onChainColoursChange?: (on: boolean) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
    <button
      type="button"
      data-testid="view-menu"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      style={{ boxShadow: "var(--shadow)", ...(open ? activeButton : {}) }}
      title="Ghost edges and the property layer"
    >
      View ▾
    </button>
    <div data-testid="graph-toolbar" style={open ? bar : { display: "none" }} role="toolbar" aria-label="Graph options" hidden={!open}>
      <label
        style={row}
        title="Ghost edges are dashed hints between mechanics or entities that share properties but have no interaction edge. Higher scores mean more shared properties; only hints scoring at least the slider's value show."
      >
        <input
          type="range"
          data-testid="ghost-threshold"
          min={0}
          max={6}
          step={0.5}
          value={ghostThreshold}
          onChange={(e) => onThresholdChange(Number(e.target.value))}
          style={slider}
        />
        {/* Fixed width, so the popover does not resize under the slider as it moves. */}
        <span data-testid="ghost-threshold-value" style={{ ...muted, minWidth: "105px", fontVariantNumeric: "tabular-nums" }}>
          Ghost edges ≥ {ghostThreshold.toFixed(1)}
        </span>
      </label>
      <button
        type="button"
        data-testid="property-layer-toggle"
        aria-pressed={showPropertyLayer}
        onClick={() => onPropertyLayerChange(!showPropertyLayer)}
        style={showPropertyLayer ? activeButton : button}
      >
        Property layer {showPropertyLayer ? "on" : "off"}
      </button>
      {onChainColoursChange && (
        <button
          type="button"
          data-testid="chain-colours-toggle"
          aria-pressed={chainColours}
          onClick={() => onChainColoursChange(!chainColours)}
          style={chainColours ? activeButton : button}
          title="Colour each resource chain; off shows subsystem colours"
        >
          Chain colours {chainColours ? "on" : "off"}
        </button>
      )}
    </div>
    </div>
  );
}

// A popover under the View button in GraphView's top-right bar.
const bar: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  minWidth: "200px",
  boxShadow: "var(--shadow)",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--surface)",
  fontSize: "11px",
};

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px" };
const slider: React.CSSProperties = { width: "110px", verticalAlign: "middle" };
const muted: React.CSSProperties = { color: "var(--text-2)", whiteSpace: "nowrap", fontSize: "11px" };
const button: React.CSSProperties = {
  fontSize: "11px",
  padding: "3px 8px",
  borderRadius: "6px",
  border: "1px solid var(--border-strong)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
};
const activeButton: React.CSSProperties = {
  ...button,
  background: "var(--violet-soft)",
  borderColor: "var(--violet-border)",
  color: "var(--violet-text)",
};
