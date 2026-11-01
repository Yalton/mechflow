import { useEffect, useState } from "react";
import type { Model } from "@mechflow/core";
import { MAX_BATCH, strategyLabel, useRunStore } from "../state/run.js";

/** Milliseconds between steps while playing. */
export const PLAY_INTERVAL_MS = 400;

/**
 * Run controls over the graph: seed, step, run N steps, play/pause, reset and a
 * fire button per interactive node. The run happens in the browser through
 * `createRun` from @mechflow/core; editing the model resets it.
 */
export function RunControls({ model }: { model: Model }): JSX.Element {
  const { seed, record, end, error, playing, run, strategy, parameters, overrides } = useRunStore();
  const { setSeed, step, fire, setPlaying, reset, sync, loadStrategy, setParameter, clearOverrides } =
    useRunStore.getState();
  const [batch, setBatch] = useState(10);
  const [interval, setInterval_] = useState(PLAY_INTERVAL_MS);
  const modelParameters = model.parameters ?? [];
  // A few parameters show open; more start folded so they do not cover the graph.
  const [showParameters, setShowParameters] = useState(modelParameters.length <= FOLD_PARAMETERS_OVER);
  const changed = modelParameters.filter((p) => parameters[p.id] !== undefined).length;

  // A new model object means the model was edited (or reloaded): drop the run.
  useEffect(() => {
    sync(model);
  }, [model, sync]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => useRunStore.getState().step(model), interval);
    return () => clearInterval(timer);
  }, [playing, model, interval]);

  const interactive = model.nodes
    .filter((n) => "activation" in n && n.activation === "interactive")
    .map((n) => n.id)
    .sort();
  const stepNumber = record?.step ?? 0;
  const over = end !== null;

  // Extra rows (fire buttons, parameters, overrides, strategy, how the run
  // ended) stack above the bar; the bar itself is one row.
  return (
    <div data-testid="run-controls" style={panel} role="group" aria-label="Simulation run">
      <div className="run-extras" style={extras}>
      {interactive.length > 0 && (
        <div style={{ ...row, flexWrap: "wrap" }}>
          {interactive.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`run-fire-${id}`}
              disabled={over}
              onClick={() => fire(model, id)}
              style={button}
              title="Fire this interactive node in the next step"
            >
              Fire {model.nodes.find((n) => n.id === id)?.name ?? id}
            </button>
          ))}
        </div>
      )}
      {modelParameters.length > FOLD_PARAMETERS_OVER && (
        <button
          type="button"
          data-testid="run-parameters-toggle"
          aria-expanded={showParameters}
          onClick={() => setShowParameters(!showParameters)}
          style={foldButton}
        >
          {showParameters ? "▾" : "▸"} Parameters ({modelParameters.length})
          {changed > 0 && <span style={muted}>· {changed} changed</span>}
        </button>
      )}
      {showParameters && modelParameters.length > 0 && (
      <div
        data-testid="run-parameters"
        style={{ ...parameterGrid, gridTemplateColumns: `repeat(${Math.min(modelParameters.length, 3)}, auto)` }}
      >
      {modelParameters.map((p) => (
        <label key={p.id} style={parameterCell} title={p.description}>
          <span style={muted}>{p.id}</span>
          <input
            type="number"
            data-testid={`run-param-${p.id}`}
            min={p.min}
            max={p.max}
            step={p.integer ? 1 : "any"}
            value={parameters[p.id] ?? p.value}
            onChange={(e) => {
              if (e.target.value === "") return;
              const value = Number(e.target.value);
              const fits =
                value >= p.min && value <= p.max && (!p.integer || Number.isInteger(value));
              // The model's own value is stored as no change at all.
              if (fits) setParameter(p.id, value === p.value ? undefined : value);
            }}
            style={{ ...input, width: "64px" }}
          />
        </label>
      ))}
      </div>
      )}
      {Object.keys(overrides).length > 0 && (
        <div style={{ ...row, flexWrap: "wrap" }}>
          <span data-testid="run-overrides" style={{ ...muted, whiteSpace: "normal" }}>
            Overrides:{" "}
            {Object.entries(overrides)
              .map(([path, value]) => `${path} = ${value}`)
              .join(", ")}
          </span>
          <button
            type="button"
            data-testid="run-overrides-clear"
            onClick={clearOverrides}
            style={button}
          >
            Clear overrides
          </button>
        </div>
      )}
      {strategy !== null && (
        <div style={row}>
          <span data-testid="run-strategy" style={muted}>
            Playing strategy {strategyLabel(strategy)}
          </span>
          <button
            type="button"
            data-testid="run-strategy-clear"
            onClick={() => loadStrategy(null)}
            style={button}
          >
            Play by hand
          </button>
        </div>
      )}
      {end && (
        <span data-testid="run-end" style={muted}>
          {end.reason === "endCondition"
            ? `Ended at step ${end.step}: ${end.conditions.join(", ")}`
            : end.reason === "error"
              ? `Stopped at step ${end.step}: ${end.message}`
              : `Finished at step ${end.step}`}
        </span>
      )}
      {error && (
        <span data-testid="run-error" style={errorText}>
          {error}
        </span>
      )}
      </div>
      <div style={bar}>
        <button
          type="button"
          data-testid="run-step-once"
          disabled={over}
          onClick={() => step(model)}
          style={button}
          title="Advance one step"
        >
          <span aria-hidden>⏭</span> Step
        </button>
        <button
          type="button"
          data-testid="run-play"
          disabled={over}
          aria-pressed={playing}
          onClick={() => setPlaying(!playing)}
          style={playing ? activeButton : primaryButton}
        >
          <span aria-hidden>{playing ? "⏸" : "▶"}</span> {playing ? "Pause" : "Play"}
        </button>
        <label style={row} title="Time between steps while playing">
          <select
            data-testid="run-speed"
            value={interval}
            onChange={(e) => setInterval_(Number(e.target.value))}
            style={{ ...input, height: "28px" }}
          >
            <option value={1000}>Slow</option>
            <option value={PLAY_INTERVAL_MS}>Normal</option>
            <option value={150}>Fast</option>
          </select>
        </label>
        <button type="button" data-testid="run-reset" onClick={reset} style={button} title="Back to step 0">
          <span aria-hidden>↺</span> Reset
        </button>
        <span style={divider} />
        <button
          type="button"
          data-testid="run-batch"
          disabled={over}
          onClick={() => step(model, batch)}
          style={button}
          title="Run this many steps at once"
        >
          Run
        </button>
        <input
          type="number"
          aria-label="Steps to run"
          data-testid="run-batch-size"
          min={1}
          max={MAX_BATCH}
          value={batch}
          onChange={(e) => {
            const value = Math.floor(Number(e.target.value));
            if (value >= 1 && value <= MAX_BATCH) setBatch(value);
          }}
          style={{ ...input, width: "64px", height: "28px" }}
        />
        <span style={divider} />
        <span data-testid="run-step" style={stepLabel}>
          {run ? `Step ${stepNumber}` : "Not started"}
        </span>
        <label style={row} title="Random seed for this run">
          <span style={muted}>Seed</span>
          <input
            type="number"
            data-testid="run-seed"
            value={seed}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isSafeInteger(value)) setSeed(value);
            }}
            style={{ ...input, width: "60px", height: "28px" }}
          />
        </label>
      </div>
    </div>
  );
}

// A floating bar at the bottom centre of the canvas, as in Machinations.
const panel: React.CSSProperties = {
  position: "absolute",
  bottom: "12px",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "6px",
  // left: 50% would otherwise cap the width at half the canvas.
  width: "max-content",
  maxWidth: "calc(100% - 24px)",
  fontSize: "12px",
};
const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--surface-glass)",
  boxShadow: "var(--shadow)",
  flexWrap: "wrap",
  justifyContent: "center",
};
/** More parameters than this start folded behind a toggle. */
export const FOLD_PARAMETERS_OVER = 3;

// Parameters sit in columns so many of them stay a short block.
const parameterGrid: React.CSSProperties = {
  display: "grid",
  gap: "4px 12px",
  width: "100%",
};
const parameterCell: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "6px",
};
const foldButton: React.CSSProperties = {
  fontSize: "12px",
  height: "24px",
  border: "none",
  background: "transparent",
  gap: "6px",
};
// Hidden by styles.css while empty.
const extras: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "4px",
  maxWidth: "min(560px, calc(100vw - 24px))",
  padding: "6px 10px",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--surface-glass)",
  boxShadow: "var(--shadow)",
};
const divider: React.CSSProperties = { width: "1px", alignSelf: "stretch", background: "var(--border)" };
const stepLabel: React.CSSProperties = {
  minWidth: "70px",
  color: "var(--text)",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  textAlign: "center",
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px" };
const muted: React.CSSProperties = { color: "var(--text-2)", whiteSpace: "nowrap", fontSize: "11px" };
const errorText: React.CSSProperties = {
  color: "var(--danger-text)",
  whiteSpace: "pre-wrap",
  fontSize: "11px",
};
// Sizes come from the base control styles in styles.css.
const input: React.CSSProperties = { fontSize: "12px" };
const button: React.CSSProperties = { fontSize: "12px" };
const primaryButton: React.CSSProperties = {
  ...button,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "#fff",
};
const activeButton: React.CSSProperties = {
  ...button,
  background: "var(--violet-soft)",
  borderColor: "var(--violet-border)",
  color: "var(--violet-text)",
};
