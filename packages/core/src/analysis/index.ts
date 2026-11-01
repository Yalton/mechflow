/**
 * Analysis package entry point.
 *
 * Exposes the analysis index, every registered check (via `CHECKS`), the
 * second-order effect trace, and the combined report.
 */
export { buildGraphIndex, adjacencyFor, simpleCycles, stronglyConnectedComponents, subsystemOf } from "./graph.js";
export type { AnalysisIndex } from "./types.js";
export { CHECKS, analyzeModel, hashModel } from "./report.js";
export type {
  Report,
  ReportSummary,
  ReportSummaryByCheck,
} from "./report.js";
export type { Check, Finding, Severity } from "./types.js";
export { feedbackLoopsCheck } from "./feedback-loops.js";
export { infiniteLoopsCheck } from "./infinite-loops.js";
export { ghostEdgesCheck, findGhostEdges } from "./ghost-edges.js";
export type { GhostEdge, GhostReason } from "./ghost-edges.js";
export { interactionMatrixCheck, buildInteractionMatrix } from "./interaction-matrix.js";
export type { InteractionMatrix, MatrixCell } from "./interaction-matrix.js";
export { bottlenecksCheck } from "./bottlenecks.js";
export { couplingCheck, buildCouplingMap } from "./coupling.js";
export { multipliersCheck, findMultiplierChains, evaluateConstantMultiplier } from "./multipliers.js";
export { activationPullsCheck } from "./activation-pulls.js";
export { undeclaredPropertiesCheck } from "./undeclared-properties.js";
export { traceEffects } from "./trace.js";
export type { TraceResult, TraceLevel, TraceNode } from "./trace.js";
