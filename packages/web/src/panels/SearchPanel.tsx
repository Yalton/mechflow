import { useState } from "react";
import { focusStrategy, type Model, type Objective, type Strategy } from "@mechflow/core";
import {
  ANALYSES,
  ANALYSIS_LABELS,
  type Analysis,
  type SearchResponse,
} from "../search/analyses.js";
import { useEditorStore } from "../state/editor.js";
import { useRunStore } from "../state/run.js";
import { useSearchStore } from "../state/search.js";

/** Rows each ranked table shows. */
export const TABLE_ROWS = 10;

/** The objective picker's value for a typed-in objective. */
const CUSTOM = "__custom__";

/**
 * The search panel (docs/search-design.md, "Where it runs"): pick an
 * objective and a budget, run one of the five analyses in the search worker,
 * and read its ranked table. "Load strategy" hands a found strategy to the
 * run controls, which then step it.
 */
export function SearchPanel({ model }: { model: Model }): JSX.Element {
  const objectives = model.objectives ?? [];
  const [analysis, setAnalysis] = useState<Analysis>("dominant");
  const [picked, setPicked] = useState<string>(objectives[0]?.id ?? CUSTOM);
  const [expr, setExpr] = useState("");
  const [sense, setSense] = useState<"max" | "min">("max");
  const [steps, setSteps] = useState(30);
  const [runs, setRuns] = useState(10);
  const [budget, setBudget] = useState(200);
  const seed = useRunStore((s) => s.seed);
  const running = useSearchStore((s) => s.running);
  const error = useSearchStore((s) => s.error);
  const result = useSearchStore((s) => (s.model === model ? s.results[analysis] : undefined));

  // A picked objective the model no longer has falls back to the first one.
  const objectiveId = objectives.some((o) => o.id === picked)
    ? picked
    : (objectives[0]?.id ?? CUSTOM);
  const objective: string | Objective | null =
    objectiveId !== CUSTOM
      ? objectiveId
      : expr.trim()
        ? {
            id: "custom",
            description: "Typed into the search panel.",
            expr: expr.trim(),
            measure: "final",
            sense,
          }
        : null;

  const start = (): void => {
    if (!objective) return;
    void useSearchStore
      .getState()
      .run(model, { analysis, objective, seed, steps, runs, maxEvaluations: budget });
  };

  return (
    <section data-testid="search-panel" style={panel} aria-label="Search">
      <div role="tablist" style={row}>
        {ANALYSES.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            data-testid={`search-tab-${a}`}
            aria-selected={analysis === a}
            onClick={() => setAnalysis(a)}
            style={analysis === a ? activeTab : tab}
          >
            {ANALYSIS_LABELS[a]}
          </button>
        ))}
      </div>
      <form
        style={row}
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <label style={row}>
          <span style={muted}>Objective</span>
          <select
            data-testid="search-objective"
            value={objectiveId}
            onChange={(e) => setPicked(e.target.value)}
            style={{ ...input, width: "auto" }}
          >
            {objectives.map((o) => (
              <option key={o.id} value={o.id}>
                {o.sense === "max" ? "Most" : "Least"} {o.id}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
        </label>
        {objectiveId === CUSTOM && (
          <>
            <select
              aria-label="Custom objective sense"
              data-testid="search-sense"
              value={sense}
              onChange={(e) => setSense(e.target.value as "max" | "min")}
              style={{ ...input, width: "auto" }}
            >
              <option value="max">Most</option>
              <option value="min">Least</option>
            </select>
            <input
              aria-label="Custom objective formula"
              data-testid="search-expr"
              placeholder="a formula, e.g. gold"
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              style={{ ...input, width: "140px" }}
            />
            <span style={muted}>at the end of the run</span>
          </>
        )}
        <NumberField label="Steps" testId="search-steps" value={steps} onChange={setSteps} />
        <NumberField label="Runs" testId="search-runs" value={runs} onChange={setRuns} />
        <NumberField label="Budget" testId="search-budget" value={budget} onChange={setBudget} />
        <span style={muted}>Seed {seed}</span>
        {/* Distinct keys keep these separate elements: reusing one would turn
            Cancel back into a submit button before its click's default action,
            and the click would start the search again. */}
        {running ? (
          <button
            key="cancel"
            type="button"
            data-testid="search-cancel"
            onClick={() => useSearchStore.getState().cancel()}
            style={tab}
          >
            Cancel
          </button>
        ) : (
          <button
            key="run"
            type="submit"
            data-testid="search-run"
            disabled={!objective}
            style={tab}
          >
            Search
          </button>
        )}
      </form>
      {running && (
        <p data-testid="search-running" style={muted}>
          Running {ANALYSIS_LABELS[running].toLowerCase()}…
        </p>
      )}
      {error && !running && (
        <p data-testid="search-error" style={errorText}>
          {error}
        </p>
      )}
      {result ? (
        <Results result={result} />
      ) : (
        !running && (
          <p data-testid="search-empty" style={muted}>
            {objectiveId === CUSTOM && objectives.length === 0
              ? "This model has no objectives: type a formula to search on, or add one to the model."
              : "Run a search to rank strategies for this objective."}
          </p>
        )
      )}
    </section>
  );
}

function NumberField(props: {
  label: string;
  testId: string;
  value: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label style={row}>
      <span style={muted}>{props.label}</span>
      <input
        type="number"
        min={1}
        data-testid={props.testId}
        value={props.value}
        onChange={(e) => props.onChange(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
        style={input}
      />
    </label>
  );
}

const round = (n: number): string => String(Math.round(n * 100) / 100);
const percent = (n: number | null): string => (n === null ? "–" : `${Math.round(n * 100)}%`);

/** One table row: its cells, and the strategy "Load strategy" plays, if any. */
interface Row {
  key: string;
  cells: string[];
  strategy?: Strategy | string | null;
  /** A boundary setting: the row loads these with its strategy. */
  setting?: { parameters: Record<string, number>; overrides: Record<string, number> };
}

function Results({ result }: { result: Extract<SearchResponse, { ok: true }> }): JSX.Element {
  const findings = result.findings.length;
  return (
    <div
      data-testid="search-results"
      style={{ ...row, flexDirection: "column", alignItems: "stretch" }}
    >
      <p data-testid="search-summary" style={muted}>
        {findings === 0 ? "No findings" : `${findings} finding${findings === 1 ? "" : "s"}`},{" "}
        {result.evaluationsUsed} evaluations.
      </p>
      <ResultTables result={result} />
    </div>
  );
}

function ResultTables({ result }: { result: Extract<SearchResponse, { ok: true }> }): JSX.Element {
  switch (result.analysis) {
    case "dominant": {
      const { report } = result;
      return (
        <Table
          caption={`Best sets of interactive nodes (baseline ${round(report.baseline.score)}, ${report.mode})`}
          headers={["Nodes", "Score", "Gain", "Synergy"]}
          rows={report.ranked.map((r) => ({
            key: r.nodes.join("+"),
            cells: [
              r.nodes.join(" + "),
              round(r.score),
              round(r.gain),
              r.synergy === null ? "–" : `${round(r.synergy)}×`,
            ],
            strategy: focusStrategy(r.nodes),
          }))}
        />
      );
    }
    case "systems": {
      const { report } = result;
      return (
        <Table
          caption={
            report.overall
              ? `Best overall: ${report.overall.nodes.join(" + ")} (${round(report.overall.score)})`
              : "Each subsystem's best set"
          }
          headers={["Subsystem", "Best set", "Score", "Share of best gain", "Share of top sets"]}
          rows={report.subsystems.map((s) => ({
            key: s.subsystem,
            cells: [
              s.subsystem,
              s.best ? s.best.nodes.join(" + ") : "–",
              s.best ? round(s.best.score) : "–",
              percent(s.share),
              percent(s.topShare),
            ],
            strategy: s.best ? focusStrategy(s.best.nodes) : null,
          }))}
        />
      );
    }
    case "optimizer": {
      const { report } = result;
      return (
        <>
          <Table
            caption={`Greedy player: ${round(report.score)} (p5 ${round(report.p5)}, p95 ${round(report.p95)})`}
            headers={["Strategy", "Score"]}
            rows={[
              ...(report.strategy
                ? [
                    {
                      key: "optimizer",
                      cells: [
                        "Derived from the player's fires",
                        report.strategyScore === null ? "–" : round(report.strategyScore),
                      ],
                      strategy: report.strategy,
                    },
                  ]
                : []),
              ...report.intended.map((s) => ({
                key: `intended:${s.id}`,
                cells: [`${s.id} (intended)`, round(s.score)],
                strategy: s.id,
              })),
            ]}
          />
          <Table
            caption="What the player fired"
            headers={["Node", "Fires", "Per step"]}
            rows={report.fires.map((f) => ({
              key: f.node,
              cells: [f.node, String(f.count), round(f.perStep)],
            }))}
          />
        </>
      );
    }
    case "space": {
      const { report } = result;
      const entries = [
        ...report.robust.map((r) => ({ ...r, kind: "robust" })),
        ...report.specialists.map((r) => ({ ...r, kind: `specialist, best at ${r.dependsOn}` })),
      ];
      return (
        <>
          <Table
            caption={`${report.viableCount} of ${report.candidates.length} strategies are viable`}
            headers={["Strategy", "Score", "Viable"]}
            rows={report.candidates.map((c) => ({
              key: c.label,
              cells: [c.label, round(c.score), c.viable ? "yes" : "no"],
              strategy: c.strategy,
            }))}
          />
          {entries.length > 0 && (
            <Table
              caption={`Across ${report.settings.join(", ")}`}
              headers={["Strategy", "Kind", "Worst case", "Best case"]}
              rows={entries.map((r) => ({
                key: `${r.kind}:${r.label}`,
                cells: [r.label, r.kind, round(r.worstCase), round(r.bestCase)],
                strategy: r.strategy,
              }))}
            />
          )}
        </>
      );
    }
    case "boundary": {
      const { report } = result;
      return (
        <Table
          caption={
            report.knobs.length === 0
              ? "This model has no parameters to sweep."
              : `Settings of ${report.knobs.map((k) => k.id).join(", ")}${
                  report.skipped.length > 0
                    ? ` (${report.skipped.length} skipped by the budget)`
                    : ""
                }`
          }
          headers={["Setting", "Score", "Problems"]}
          rows={report.settings.map((s) => ({
            key: s.label,
            cells: [s.label, round(s.score), s.problems.join(", ") || "–"],
            strategy: report.strategy,
            setting: { parameters: s.parameters, overrides: s.overrides },
          }))}
        />
      );
    }
  }
}

/**
 * An id for saving `strategy` into `model`: its own id made a formula
 * identifier (so "focus:drill+pray" becomes "focus_drill_pray"), with a
 * number added when a model strategy already has it.
 */
export function freshStrategyId(strategy: Strategy, model: Model): string {
  let base = strategy.id.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "strategy";
  if (/^[0-9]/.test(base)) base = `s_${base}`;
  const taken = new Set((model.strategies ?? []).map((s) => s.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Add a strategy a search found to the open model, as an undoable edit. */
function saveStrategy(strategy: Strategy): void {
  const { model, updateModel } = useEditorStore.getState();
  if (!model) return;
  const saved: Strategy = {
    ...strategy,
    id: freshStrategyId(strategy, model),
    description: strategy.description || "Found by search",
  };
  updateModel({ strategies: [...(model.strategies ?? []), saved] });
}

function Table(props: { caption: string; headers: string[]; rows: Row[] }): JSX.Element {
  const loadable = props.rows.some((r) => r.strategy || r.setting);
  return (
    <table data-testid="search-table" style={table}>
      <caption style={{ ...muted, textAlign: "left" }}>{props.caption}</caption>
      <thead>
        <tr>
          {props.headers.map((h) => (
            <th key={h} style={cell}>
              {h}
            </th>
          ))}
          {loadable && <th style={cell} />}
        </tr>
      </thead>
      <tbody>
        {props.rows.slice(0, TABLE_ROWS).map((r) => (
          <tr key={r.key} data-testid="search-row">
            {r.cells.map((c, i) => (
              <td key={i} style={cell}>
                {c}
              </td>
            ))}
            {loadable && (
              <td style={cell}>
                {r.setting ? (
                  <button
                    type="button"
                    data-testid="search-load-setting"
                    onClick={() =>
                      useRunStore.getState().loadSetting({ strategy: r.strategy ?? null, ...r.setting! })
                    }
                    style={tab}
                    title="Step this setting's parameters, overrides and strategy with the run controls on the graph"
                  >
                    Load setting
                  </button>
                ) : r.strategy && (
                  <>
                  <button
                    type="button"
                    data-testid="search-load"
                    onClick={() => useRunStore.getState().loadStrategy(r.strategy!)}
                    style={tab}
                    title="Step this strategy with the run controls on the graph"
                  >
                    Load strategy
                  </button>
                  {typeof r.strategy === "object" && (
                    <button
                      type="button"
                      data-testid="search-save-strategy"
                      onClick={() => saveStrategy(r.strategy as Strategy)}
                      style={tab}
                      title="Add this strategy to the model's strategies. Saving is an edit, so the results clear until the next search."
                    >
                      Save to model
                    </button>
                  )}
                  </>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
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
const table: React.CSSProperties = { borderCollapse: "collapse", fontSize: "11px", width: "100%" };
const cell: React.CSSProperties = {
  textAlign: "left",
  padding: "3px 6px",
  borderBottom: "1px solid var(--border)",
};
