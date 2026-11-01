import { useEffect, useState } from "react";
import type { Model } from "@mechflow/core";
import { describeWave, firstWave, nextWave, type Wave } from "./mechanicRun.js";

/** Milliseconds between waves while playing. */
export const WAVE_INTERVAL_MS = 1200;

/**
 * Run controls for a mechanics-only map (see mechanicRun.ts): Step, Play and
 * Reset over waves of mechanics firing. The current wave is owned by
 * GraphView, which draws it; editing the model drops it. Playing past a
 * settled map starts over from the first wave.
 */
export function MechanicRunControls({
  model,
  wave,
  onWave,
}: {
  model: Model;
  wave: Wave | null;
  onWave: (wave: Wave | null) => void;
}): JSX.Element {
  const [playing, setPlaying] = useState(false);
  const advance = (current: Wave | null): Wave | null =>
    current === null || current.fired.length === 0 ? firstWave(model) : nextWave(model, current);

  // One wave per tick while playing; the timer restarts with each new wave.
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => onWave(advance(wave)), WAVE_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [playing, wave]);

  return (
    <div data-testid="mechanic-run" style={panel} role="group" aria-label="Mechanic run">
      <div style={bar}>
        <button type="button" data-testid="wave-step" onClick={() => onWave(advance(wave))} style={button}
          title="Fire the next wave of mechanics">
          ⏭ Step
        </button>
        <button type="button" data-testid="wave-play" onClick={() => setPlaying(!playing)}
          style={playing ? activeButton : primaryButton}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button type="button" data-testid="wave-reset" style={button} title="Back to the start"
          onClick={() => { setPlaying(false); onWave(null); }}>
          ↺ Reset
        </button>
        <span data-testid="wave-label" style={label}>
          {wave === null ? "Not started" : describeWave(model, wave)}
        </span>
      </div>
    </div>
  );
}

// Matches RunControls: a bar centred over the bottom of the canvas.
const panel: React.CSSProperties = {
  position: "absolute",
  bottom: "12px",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 10,
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
const label: React.CSSProperties = {
  minWidth: "90px",
  color: "var(--text)",
  fontWeight: 600,
  textAlign: "center",
};
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
