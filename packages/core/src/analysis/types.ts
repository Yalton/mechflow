import type { Model } from "../model/types.js";

export type Severity = "info" | "warning" | "error";

export interface Finding {
  /**
   * Stable id derived from the check id plus the involved node/edge ids. The
   * same model must always produce the same id so the UI can track dismissed
   * findings across re-analyses.
   */
  id: string;
  check: string;
  severity: Severity;
  title: string;
  detail: string;
  nodes: string[];
  edges: string[];
  data?: Record<string, unknown>;
}

export interface AnalysisIndex {
  model: Model;
  nodeById: Map<string, import("../model/types.js").Node>;
  edgeById: Map<string, import("../model/types.js").Edge>;
  nodeToSubsystem: Map<string, string>;
  properties: Map<string, import("../model/types.js").Property>;
}

export interface Check {
  id: string;
  name: string;
  run(model: Model, index: AnalysisIndex): Finding[];
}
