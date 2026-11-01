import { useMemo, useState } from "react";
import type { Finding, Severity } from "@mechflow/core";

/**
 * Findings panel: lists analysis findings grouped by severity then check, with
 * per-check counts. Clicking a finding selects it (highlighting its nodes/edges
 * on the graph via the parent); hovering previews its detail and involved
 * nodes/edges. Findings can be dismissed per-browser via `localStorage`, and the
 * list can be filtered by check and severity.
 *
 * Dismissal state lives here (it is a UI concern); the selected-finding id is
 * owned by the parent so the graph can react to it.
 */

/** localStorage key for the dismissed finding ids, best-effort wrapped. */
const DISMISS_KEY = "mechflow:dismissed-findings";

/** Display order: most urgent first. */
const SEVERITY_ORDER: Severity[] = ["error", "warning", "info"];

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string")
      ? (parsed as string[])
      : [];
  } catch {
    // Corrupt or unavailable storage (private mode, quota) — start clean.
    return [];
  }
}

function saveDismissed(ids: string[]): void {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(ids));
  } catch {
    // Dismissal is best-effort; failing to persist just re-shows the finding.
  }
}

/** Severity label shown in the summary pill. */
const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

export interface FindingsPanelProps {
  /** All findings for the current report (panel applies dismissal + filters). */
  findings: Finding[];
  /** Id of the currently highlighted finding, or null. */
  highlightedId: string | null;
  /** Called when a finding is clicked; parent highlights it on the graph. */
  onSelect: (id: string) => void;
  /** Severity filter to start with; remount (key) to apply a new one. */
  initialSeverity?: string;
}

export function FindingsPanel({
  findings,
  highlightedId,
  onSelect,
  initialSeverity = "all",
}: FindingsPanelProps): JSX.Element {
  const [dismissed, setDismissed] = useState<string[]>(loadDismissed);
  const [checkFilter, setCheckFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>(initialSeverity);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  /** Distinct check ids, sorted, for the check filter dropdown. */
  const checks = useMemo(
    () => [...new Set(findings.map((f) => f.check))].sort(),
    [findings],
  );

  /** Findings surviving dismissal + filters. */
  const visible = useMemo(() => {
    return findings.filter((f) => {
      if (dismissed.includes(f.id)) return false;
      if (checkFilter !== "all" && f.check !== checkFilter) return false;
      if (severityFilter !== "all" && f.severity !== severityFilter) return false;
      return true;
    });
  }, [findings, dismissed, checkFilter, severityFilter]);

  /** Group visible findings by severity, then by check, keeping counts. */
  const groups = useMemo(() => {
    const result: { severity: Severity; byCheck: Map<string, Finding[]> }[] = [];
    for (const severity of SEVERITY_ORDER) {
      const byCheck = new Map<string, Finding[]>();
      for (const f of visible) {
        if (f.severity !== severity) continue;
        const list = byCheck.get(f.check) ?? [];
        list.push(f);
        byCheck.set(f.check, list);
      }
      if (byCheck.size > 0) result.push({ severity, byCheck });
    }
    return result;
  }, [visible]);

  const hovered = hoveredId ? findings.find((f) => f.id === hoveredId) : undefined;

  const dismiss = (id: string): void => {
    const next = [...dismissed, id];
    setDismissed(next);
    saveDismissed(next);
  };

  return (
    <section data-testid="findings-panel" style={section}>
      <h3 style={sectionTitle}>Findings ({visible.length})</h3>

      <div style={filters}>
        <label style={filterLabel}>
          Check
          <select
            data-testid="filter-check"
            value={checkFilter}
            onChange={(e) => setCheckFilter(e.target.value)}
            style={select}
          >
            <option value="all">All checks</option>
            {checks.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label style={filterLabel}>
          Severity
          <select
            data-testid="filter-severity"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            style={select}
          >
            <option value="all">All severities</option>
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        <p data-testid="no-findings-matching" style={muted}>
          No findings match the current filters.
        </p>
      ) : (
        groups.map(({ severity, byCheck }) => (
          <div key={`${severity}-group`} data-testid="severity-group">
            <div style={severityHeader}>
              <span data-testid="severity-label" data-severity={severity}>
                {SEVERITY_LABEL[severity]}
              </span>
            </div>
            {[...byCheck.entries()].map(([check, list]) => (
              <div key={check} data-testid="check-group">
                <div style={checkHeader}>
                  <span data-testid="check-name">{check}</span>
                  <span data-testid="check-count" style={muted}>
                    ({list.length})
                  </span>
                </div>
                <ul data-testid="finding-list">
                  {list.map((f) => (
                    <li
                      key={f.id}
                      data-testid="finding"
                      data-severity={f.severity}
                      data-highlighted={f.id === highlightedId ? "true" : "false"}
                      className={
                        f.id === highlightedId ? "finding finding-active" : "finding"
                      }
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelect(f.id)}
                      onMouseEnter={() => setHoveredId(f.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      style={findingRow(f.id === highlightedId)}
                    >
                      <span style={findingTitle}>
                        <span data-testid="finding-title">{f.title}</span>
                      </span>
                      <span style={findingCheck}>{f.check}</span>
                      <button
                        type="button"
                        data-testid="dismiss-finding"
                        aria-label={`Dismiss ${f.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          dismiss(f.id);
                        }}
                        style={dismissButton}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))
      )}

      {hovered && (
        <div data-testid="finding-preview" style={preview}>
          <div style={previewTitle}>{hovered.title}</div>
          <div style={previewMeta}>
            {hovered.check} · {SEVERITY_LABEL[hovered.severity]}
          </div>
          <div style={previewDetail}>{hovered.detail}</div>
          <div style={previewMeta}>
            Nodes: {hovered.nodes.join(", ") || "—"}
          </div>
          <div style={previewMeta}>
            Edges: {hovered.edges.join(", ") || "—"}
          </div>
        </div>
      )}
    </section>
  );
}

const section: React.CSSProperties = { marginTop: "8px" };
const sectionTitle: React.CSSProperties = { fontSize: "15px", margin: 0 };
const filters: React.CSSProperties = {
  display: "flex",
  gap: "12px",
  marginBottom: "8px",
};
const filterLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  fontSize: "11px",
  color: "var(--text-2)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const select: React.CSSProperties = {
  marginTop: "2px",
  padding: "2px 4px",
  fontSize: "13px",
  border: "1px solid var(--border-strong)",
  borderRadius: "6px",
};
const muted: React.CSSProperties = { color: "var(--text-2)", fontSize: "13px" };
const severityHeader: React.CSSProperties = {
  marginTop: "8px",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text)",
};
const checkHeader: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-2)",
  marginBottom: "2px",
};
const findingRow: (active: boolean) => React.CSSProperties = (active) => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "6px 8px",
  marginBottom: "4px",
  border: `1px solid ${active ? "var(--accent-border)" : "var(--border)"}`,
  borderRadius: "6px",
  background: active ? "var(--accent-soft)" : "var(--surface)",
  cursor: "pointer",
});
const findingTitle: React.CSSProperties = { flex: 1, fontWeight: 600, fontSize: "13px", textAlign: "left" };
const findingCheck: React.CSSProperties = { fontSize: "11px", color: "var(--text-3)", textAlign: "left" };
const dismissButton: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--text-3)",
  cursor: "pointer",
  fontSize: "12px",
  padding: "0 4px",
};
const preview: React.CSSProperties = {
  marginTop: "12px",
  padding: "10px 12px",
  border: "1px solid var(--border-strong)",
  borderRadius: "8px",
  background: "var(--surface-2)",
};
const previewTitle: React.CSSProperties = { fontWeight: 700, fontSize: "14px" };
const previewMeta: React.CSSProperties = { fontSize: "12px", color: "var(--text-2)", marginTop: "4px" };
const previewDetail: React.CSSProperties = {
  fontSize: "13px",
  color: "var(--text)",
  marginTop: "4px",
  whiteSpace: "pre-wrap",
};
