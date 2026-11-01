import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_STEPS, simulate, type StepRecord, type Trace } from "@mechflow/core";
import { handleError, jsonResult, loadModel, ToolError } from "./analysis.js";

/** What one step adds to the summary: only the parts that happened. */
interface StepSummary {
  step: number;
  inTransit: number;
  failed?: string[];
  fired?: string[];
  triggered?: string[];
  capacityLoss?: number;
  gateLoss?: number;
  invariantViolations?: string[];
  ended?: string[];
}

const sum = (record: Record<string, number>): number =>
  Object.values(record).reduce((total, n) => total + n, 0);

function summarizeStep(record: StepRecord): StepSummary {
  const summary: StepSummary = { step: record.step, inTransit: record.inTransit };
  if (record.failed.length > 0) summary.failed = record.failed;
  if (record.fired.length > 0) summary.fired = record.fired;
  if (record.triggered.length > 0) summary.triggered = record.triggered;
  if (sum(record.capacityLoss) > 0) summary.capacityLoss = sum(record.capacityLoss);
  if (sum(record.gateLoss) > 0) summary.gateLoss = sum(record.gateLoss);
  if (record.invariantViolations.length > 0) {
    summary.invariantViolations = record.invariantViolations;
  }
  if (record.ended.length > 0) summary.ended = record.ended;
  return summary;
}

/** Add up a per-step record field over the whole run. */
function totals(
  trace: Trace,
  field: (r: StepRecord) => Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of trace.steps) {
    for (const [id, n] of Object.entries(field(record))) out[id] = (out[id] ?? 0) + n;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The compact form of a trace: one series per pool and register (the initial
 * value, then the value after each step), totals over the run, and a summary
 * of each step listing only what happened in it.
 */
export function summarizeTrace(trace: Trace, pools?: string[]) {
  const series = (values: Record<string, number>[], ids: string[]): Record<string, number[]> =>
    Object.fromEntries(ids.map((id) => [id, values.map((v) => v[id]!)]));
  const poolIds = pools ?? Object.keys(trace.initial.amounts);
  const warnings = new Map<string, string>();
  for (const record of trace.steps) {
    for (const w of record.warnings) warnings.set(w.message, w.code);
  }
  return {
    seed: trace.seed,
    stepsRun: trace.steps.length,
    end: trace.end,
    pools: series([trace.initial.amounts, ...trace.steps.map((s) => s.amounts)], poolIds),
    registers: series(
      [trace.initial.registers, ...trace.steps.map((s) => s.registers)],
      Object.keys(trace.initial.registers),
    ),
    totals: {
      moved: totals(trace, (r) => r.moved),
      arrived: totals(trace, (r) => r.arrived),
      activations: totals(trace, (r) => r.activations),
      capacityLoss: totals(trace, (r) => r.capacityLoss),
      gateLoss: totals(trace, (r) => r.gateLoss),
    },
    invariantViolations: trace.invariantViolations,
    warnings: [...warnings].map(([message, code]) => ({ code, message })),
    steps: trace.steps.map(summarizeStep),
  };
}

/** Register the `simulate` tool on `server`, bound to `modelsRoot`. */
export function registerSimulateTool(server: McpServer, modelsRoot: string): void {
  server.registerTool(
    "simulate",
    {
      title: "Simulate model",
      description: `Run a model step by step (docs/simulation-semantics.md) and return what happened. \`path\` is relative to the models root. \`seed\` (any whole number) makes the run reproducible; \`steps\` is the most steps to run (1 to ${MAX_STEPS}); the run stops earlier if an end condition holds. \`interactive\` schedules interactive nodes by id: "never", "always", a probability from 0 to 1, or a list of step numbers. By default the result is a summary: per-pool and per-register series (initial value then the value after each step), totals over the run, invariant violations, warnings and a per-step summary listing only what happened. \`pools\` limits the series to those pool ids. \`detail: "full"\` returns the complete trace instead, with every edge's flow every step.`,
      inputSchema: {
        path: z.string().min(1),
        seed: z.number().int(),
        steps: z.number().int().positive().max(MAX_STEPS),
        interactive: z
          .record(z.union([z.enum(["never", "always"]), z.number(), z.array(z.number().int())]))
          .optional(),
        pools: z.array(z.string()).optional(),
        detail: z.enum(["summary", "full"]).optional(),
      },
    },
    async ({ path: rel, seed, steps, interactive, pools, detail }) => {
      try {
        const { model } = loadModel(modelsRoot, rel);
        if (pools) {
          const known = new Set(model.nodes.filter((n) => n.kind === "pool").map((n) => n.id));
          const unknown = pools.filter((id) => !known.has(id));
          if (unknown.length > 0) throw new ToolError(`not a pool: ${unknown.join(", ")}`);
        }
        const result = simulate(model, { seed, steps, ...(interactive ? { interactive } : {}) });
        if (!result.ok) return jsonResult({ path: rel, errors: result.errors }, true);
        if (detail === "full") return jsonResult({ path: rel, ...result.trace });
        return jsonResult({ path: rel, ...summarizeTrace(result.trace, pools) });
      } catch (err) {
        return handleError(err);
      }
    },
  );
}
