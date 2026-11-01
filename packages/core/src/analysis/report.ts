import type { Model } from "../model/types.js";
import { buildGraphIndex } from "./graph.js";
import { feedbackLoopsCheck } from "./feedback-loops.js";
import { infiniteLoopsCheck } from "./infinite-loops.js";
import { ghostEdgesCheck } from "./ghost-edges.js";
import { interactionMatrixCheck } from "./interaction-matrix.js";
import { bottlenecksCheck } from "./bottlenecks.js";
import { couplingCheck } from "./coupling.js";
import { multipliersCheck } from "./multipliers.js";
import { activationPullsCheck } from "./activation-pulls.js";
import { undeclaredPropertiesCheck } from "./undeclared-properties.js";
import { buildInteractionMatrix, type InteractionMatrix } from "./interaction-matrix.js";
import { findGhostEdges, type GhostEdge } from "./ghost-edges.js";
import type { Check, Finding, Severity } from "./types.js";

/**
 * Every registered check, in a stable order. This is the single list that
 * analyzeModel runs (unless a subset is requested) and that the web UI and MCP
 * server expose for toggling.
 */
export const CHECKS: Check[] = [
  feedbackLoopsCheck,
  infiniteLoopsCheck,
  ghostEdgesCheck,
  interactionMatrixCheck,
  bottlenecksCheck,
  couplingCheck,
  multipliersCheck,
  activationPullsCheck,
  undeclaredPropertiesCheck,
];

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

const SEVERITY_COUNT_KEY: Record<Severity, "errors" | "warnings" | "infos"> = {
  error: "errors",
  warning: "warnings",
  info: "infos",
};

export interface ReportSummaryByCheck {
  errors: number;
  warnings: number;
  infos: number;
}

export interface ReportSummary {
  errors: number;
  warnings: number;
  infos: number;
  byCheck: Record<string, ReportSummaryByCheck>;
}

/**
 * The report contract shared by the MCP tool and the web UI.
 *
 * - `modelName`: the analyzed model's name.
 * - `generatedFrom`: a hash of the serialized model, so reports can be diffed
 *   and invalidated when the model changes.
 * - `summary`: severity counts overall and per check.
 * - `findings`: all findings, sorted by severity (error first) then check then
 *   id, so output is deterministic for a given model.
 * - `matrix`: the interaction matrix over mechanic/entity nodes.
 * - `ghostEdges`: the related-but-unconnected mechanic/entity pairs.
 */
export interface Report {
  modelName: string;
  generatedFrom: string;
  summary: ReportSummary;
  findings: Finding[];
  matrix: InteractionMatrix;
  ghostEdges: GhostEdge[];
}

/**
 * Run the analysis over a model and return a combined, deterministic report.
 */
export function analyzeModel(model: Model, options?: { checks?: string[] }): Report {
  const checks = options?.checks ? CHECKS.filter((c) => options.checks!.includes(c.id)) : CHECKS;
  const index = buildGraphIndex(model);
  const findings: Finding[] = [];
  for (const check of checks) {
    findings.push(...check.run(model, index));
  }
  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.check < b.check ? -1 : a.check > b.check ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const summary: ReportSummary = { errors: 0, warnings: 0, infos: 0, byCheck: {} };
  for (const finding of findings) {
    const key = SEVERITY_COUNT_KEY[finding.severity];
    summary[key]++;
    const byCheck = (summary.byCheck[finding.check] ??= { errors: 0, warnings: 0, infos: 0 });
    byCheck[key]++;
  }

  return {
    modelName: model.name,
    generatedFrom: hashModel(model),
    summary,
    findings,
    matrix: buildInteractionMatrix(model),
    ghostEdges: findGhostEdges(model),
  };
}

/**
 * A dependency-free FNV-1a 32-bit hash over the canonical serialized model, used
 * as a stable change token. Deterministic and portable across Node and the
 * browser.
 */
export function hashModel(model: Model): string {
  const canonical = JSON.stringify(model);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
