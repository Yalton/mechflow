import { useState } from "react";
import type { Model } from "@mechflow/core";
import { chartedPools, useRunStore } from "../state/run.js";
import { LineChart, OVERFLOW_COLOR, SERIES_COLORS, type Series } from "./LineChart.js";

/**
 * Simulation charts for the open model: pool amounts per step for the active
 * run, and a Monte Carlo view with the median and p5–p95 band per pool. Which
 * pools are shown is shared with the graph, where clicking a pool toggles it.
 */
export function ChartPanel({ model }: { model: Model }): JSX.Element {
  const run = useRunStore((s) => (s.model === model ? s.run : null));
  const record = useRunStore((s) => s.record);
  const batch = useRunStore((s) => (s.model === model ? s.batch : null));
  const batchError = useRunStore((s) => s.batchError);
  const chartPools = useRunStore((s) => s.chartPools);
  const seed = useRunStore((s) => s.seed);
  const [view, setView] = useState<"run" | "batch">("run");
  const [runs, setRuns] = useState(100);
  const [steps, setSteps] = useState(50);

  const pools = model.nodes.filter((n) => n.kind === "pool");
  const poolIds = pools.map((n) => n.id).sort();
  const shown = chartedPools(chartPools, poolIds);
  const name = (id: string): string => pools.find((n) => n.id === id)?.name ?? id;
  // Color follows the pool: its slot is its place among all pools by id.
  const color = (id: string): string => SERIES_COLORS[poolIds.indexOf(id)] ?? OVERFLOW_COLOR;

  const runSeries: Series[] = run
    ? shown.map((id) => ({
        id,
        label: name(id),
        color: color(id),
        values: [run.trace.initial.amounts[id]!, ...run.trace.steps.map((s) => s.amounts[id]!)],
      }))
    : [];
  const batchSeries: Series[] = batch
    ? shown.map((id) => {
        const spread = batch.pools[id]!;
        return {
          id,
          label: name(id),
          color: color(id),
          values: spread.map((s) => s.p50),
          band: { low: spread.map((s) => s.p5), high: spread.map((s) => s.p95) },
        };
      })
    : [];

  return (
    <section data-testid="chart-panel" style={panel} aria-label="Simulation charts">
      <div style={row}>
        <div role="tablist" style={row}>
          <button
            type="button"
            role="tab"
            data-testid="chart-view-run"
            aria-selected={view === "run"}
            onClick={() => setView("run")}
            style={view === "run" ? activeTab : tab}
          >
            Run
          </button>
          <button
            type="button"
            role="tab"
            data-testid="chart-view-batch"
            aria-selected={view === "batch"}
            onClick={() => setView("batch")}
            style={view === "batch" ? activeTab : tab}
          >
            Monte Carlo
          </button>
        </div>
        <span style={muted}>
          {poolIds.length === 0
            ? "This model has no pools to chart."
            : "Click a pool on the graph to show or hide it."}
        </span>
      </div>

      {view === "run" &&
        (run && run.trace.steps.length > 0 && record ? (
          shown.length > 0 ? (
            <LineChart title={`Pool amounts, seed ${run.trace.seed}`} series={runSeries} />
          ) : (
            <p style={muted}>No pools selected.</p>
          )
        ) : (
          <p data-testid="chart-run-empty" style={muted}>
            Step the model with the run controls on the graph to chart it.
          </p>
        ))}

      {view === "batch" && (
        <>
          <form
            style={row}
            onSubmit={(e) => {
              e.preventDefault();
              useRunStore.getState().runBatch(model, { seed, runs, steps });
            }}
          >
            <label style={row}>
              <span style={muted}>Runs</span>
              <input
                type="number"
                data-testid="batch-runs"
                min={1}
                max={10000}
                value={runs}
                onChange={(e) => setRuns(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                style={input}
              />
            </label>
            <label style={row}>
              <span style={muted}>Steps</span>
              <input
                type="number"
                data-testid="batch-steps"
                min={1}
                value={steps}
                onChange={(e) => setSteps(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                style={input}
              />
            </label>
            <span style={muted}>Seed {seed} (set it in the run controls)</span>
            <button type="submit" data-testid="batch-run" style={tab}>
              Run batch
            </button>
          </form>
          {batchError && (
            <p data-testid="batch-error" style={errorText}>
              {batchError}
            </p>
          )}
          {batch && shown.length > 0 && (
            <LineChart
              title={`Median and p5–p95 over ${batch.runs.length} runs, seed ${batch.seed}`}
              series={batchSeries}
              bandLabel="p5–p95"
            />
          )}
        </>
      )}
    </section>
  );
}

const panel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  marginTop: "12px",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--surface)",
};
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap",
};
const muted: React.CSSProperties = { color: "var(--text-2)", fontSize: "11px", margin: 0 };
const errorText: React.CSSProperties = {
  color: "var(--danger-text)",
  fontSize: "11px",
  margin: 0,
  whiteSpace: "pre-wrap",
};
const input: React.CSSProperties = {
  fontSize: "11px",
  padding: "2px 4px",
  width: "64px",
  borderRadius: "4px",
  border: "1px solid var(--border-strong)",
};
const tab: React.CSSProperties = {
  fontSize: "11px",
  padding: "3px 10px",
  borderRadius: "6px",
  border: "1px solid var(--border-strong)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
};
const activeTab: React.CSSProperties = {
  ...tab,
  background: "var(--violet-soft)",
  borderColor: "var(--violet-border)",
  color: "var(--violet-text)",
};
