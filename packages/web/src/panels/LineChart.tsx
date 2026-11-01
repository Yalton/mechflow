import { useState } from "react";

/**
 * A small hand-rolled SVG line chart: one 2px line per series over steps, an
 * optional shaded band per series (Monte Carlo p5 to p95), recessive grid, a
 * hover crosshair with a tooltip of every series' value at that step, a legend
 * for two or more series, and a table view. See AGENTS.md for why it is not a
 * library.
 */

/**
 * Categorical slots, in fixed order (the dataviz reference palette, light
 * mode). A series keeps its slot by pool, not by how many are shown.
 */
export const SERIES_COLORS = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
];
/** Pools past the eighth by id share a neutral ink; the legend tells them apart. */
export const OVERFLOW_COLOR = "#8a8985";

export interface Series {
  id: string;
  label: string;
  color: string;
  /** One value per step, from step 0. */
  values: number[];
  /** Optional band around the line, one low and one high per step. */
  band?: { low: number[]; high: number[] };
}

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 12, right: 16, bottom: 28, left: 52 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

/** About `count` round tick values covering [0, max]. */
function ticks(max: number, count: number): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const format = (v: number): string =>
  Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1);

export function LineChart({
  series,
  title,
  bandLabel,
}: {
  series: Series[];
  title: string;
  /** What the band means, for the tooltip and table (e.g. "p5–p95"). */
  bandLabel?: string;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const steps = Math.max(0, ...series.map((s) => s.values.length - 1));
  const yTicks = ticks(
    Math.max(0, ...series.flatMap((s) => [...s.values, ...(s.band?.high ?? [])])),
    4,
  );
  const yMax = yTicks.at(-1)! || 1;
  const x = (step: number): number => PAD.left + (steps === 0 ? 0 : (step / steps) * PLOT_W);
  const y = (value: number): number => PAD.top + PLOT_H - (value / yMax) * PLOT_H;
  const xTicks = ticks(steps, 5).filter((t) => t <= steps);
  const path = (values: number[]): string =>
    values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const onMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const step = Math.round(((px - PAD.left) / PLOT_W) * steps);
    setHover(Math.min(steps, Math.max(0, step)));
  };

  return (
    <figure data-testid="line-chart" style={figure}>
      <figcaption style={caption}>
        <span>{title}</span>
        <button
          type="button"
          data-testid="chart-table-toggle"
          aria-pressed={table}
          onClick={() => setTable(!table)}
          style={toggle}
        >
          {table ? "Chart" : "Table"}
        </button>
      </figcaption>
      {series.length >= 2 && (
        <ul data-testid="chart-legend" style={legend}>
          {series.map((s) => (
            <li key={s.id} style={legendItem}>
              <span style={{ ...swatch, background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {table ? (
        <ChartTable series={series} steps={steps} bandLabel={bandLabel} />
      ) : (
        <div style={{ position: "relative" }}>
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            width="100%"
            role="img"
            aria-label={`${title}: ${series.map((s) => s.label).join(", ")} over ${steps} steps`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            style={{ display: "block" }}
          >
            {yTicks.map((t) => (
              <g key={`y${t}`}>
                <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} />
                <text
                  x={PAD.left - 6}
                  y={y(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  style={tick}
                >
                  {format(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={`x${t}`} x={x(t)} y={HEIGHT - 8} textAnchor="middle" style={tick}>
                {t}
              </text>
            ))}
            {series.map(
              (s) =>
                s.band && (
                  <path
                    key={`band-${s.id}`}
                    data-testid={`chart-band-${s.id}`}
                    d={`${path(s.band.high)}${s.band.low
                      .map((v, i) => [i, v] as const)
                      .reverse()
                      .map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
                      .join("")}Z`}
                    fill={s.color}
                    fillOpacity={0.15}
                    stroke="none"
                  />
                ),
            )}
            {series.map((s) => (
              <path
                key={s.id}
                data-testid={`chart-line-${s.id}`}
                d={path(s.values)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {hover !== null && (
              <g data-testid="chart-crosshair">
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PAD.top}
                  y2={PAD.top + PLOT_H}
                  stroke={AXIS}
                />
                {series.map((s) => (
                  <circle
                    key={s.id}
                    cx={x(hover)}
                    cy={y(s.values[hover] ?? 0)}
                    r={4}
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                ))}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div
              data-testid="chart-tooltip"
              style={{
                ...tooltip,
                left: `${(x(hover) / WIDTH) * 100}%`,
                transform: hover > steps / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
              }}
            >
              <div style={{ fontWeight: 600 }}>Step {hover}</div>
              {series.map((s) => (
                <div key={s.id} style={legendItem}>
                  <span style={{ ...swatch, background: s.color }} />
                  {s.label}: {format(s.values[hover] ?? 0)}
                  {s.band && bandLabel && (
                    <span style={{ color: MUTED }}>
                      {" "}
                      ({bandLabel} {format(s.band.low[hover]!)}–{format(s.band.high[hover]!)})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

function ChartTable({
  series,
  steps,
  bandLabel,
}: {
  series: Series[];
  steps: number;
  bandLabel?: string;
}): JSX.Element {
  return (
    <div style={{ maxHeight: "220px", overflow: "auto" }}>
      <table data-testid="chart-table" style={tableStyle}>
        <thead>
          <tr>
            <th style={cell}>Step</th>
            {series.map((s) => (
              <th key={s.id} style={cell}>
                {s.label}
                {s.band && bandLabel ? ` (median, ${bandLabel})` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: steps + 1 }, (_, step) => (
            <tr key={step}>
              <td style={cell}>{step}</td>
              {series.map((s) => (
                <td key={s.id} style={cell}>
                  {format(s.values[step] ?? 0)}
                  {s.band ? ` (${format(s.band.low[step]!)}–${format(s.band.high[step]!)})` : ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const GRID = "var(--border)";
const AXIS = "var(--text-3)";
const MUTED = "var(--text-2)";
const figure: React.CSSProperties = {
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};
const caption: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text)",
};
const toggle: React.CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "6px",
  border: "1px solid var(--border-strong)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
};
const legend: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  listStyle: "none",
  margin: 0,
  padding: 0,
  fontSize: "11px",
  color: "var(--text-2)",
};
const legendItem: React.CSSProperties = { display: "flex", alignItems: "center", gap: "4px" };
const swatch: React.CSSProperties = {
  width: "10px",
  height: "10px",
  borderRadius: "2px",
  flex: "none",
};
const tick: React.CSSProperties = { fontSize: "10px", fill: MUTED };
const tooltip: React.CSSProperties = {
  position: "absolute",
  top: "8px",
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "var(--surface)",
  fontSize: "11px",
  color: "var(--text)",
  pointerEvents: "none",
  whiteSpace: "nowrap",
  boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
};
const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  fontSize: "11px",
  width: "100%",
};
const cell: React.CSSProperties = {
  borderBottom: "1px solid var(--border)",
  padding: "2px 6px",
  textAlign: "right",
  whiteSpace: "nowrap",
};
