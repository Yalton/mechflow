import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAX_STEPS,
  boundarySweep,
  compareSystems,
  dominantCombinations,
  optimizePlayer,
  possibilitySpace,
  type Finding,
  type SimError,
} from "@mechflow/core";
import { handleError, jsonResult, loadModel } from "./analysis.js";

/**
 * The search tools (docs/search-design.md): one per analysis. Each loads the
 * model, runs the analysis in core and returns `{ findings, report,
 * evaluationsUsed }`, with the report trimmed to a summary unless
 * `detail: "full"`.
 */

const objective = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    expr: z.string().min(1),
    measure: z.enum(["final", "mean", "endStep"]),
    sense: z.enum(["max", "min"]),
  }),
]);

const strategy = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    intended: z.boolean().optional(),
    actionsPerStep: z.number().int().min(1).optional(),
    rules: z.array(z.object({ fire: z.string().min(1), when: z.string().min(1).optional() })),
  }),
]);

/** Inputs every search tool takes. */
const common = {
  path: z.string().min(1),
  objective,
  seed: z.number().int(),
  steps: z.number().int().positive().max(MAX_STEPS),
  runs: z.number().int().positive().max(1000).optional(),
  maxEvaluations: z.number().int().positive().max(100_000).optional(),
  detail: z.enum(["summary", "full"]).optional(),
};

const COMMON_DOC =
  "`path` is relative to the models root. `objective` is a model objective id or an inline objective " +
  "{id, description, expr, measure: final|mean|endStep, sense: max|min}. `seed` makes the search " +
  "reproducible; `steps` is the length of each run and `runs` the Monte Carlo runs per evaluation " +
  "(default 20). `maxEvaluations` caps the work (default 500); the result reports `evaluationsUsed`. " +
  'Problems come back as `findings` (the shared Finding shape). `detail: "full"` returns the whole ' +
  "report instead of the summary.";

type Outcome<R> =
  | { ok: true; result: { findings: Finding[]; report: R; evaluationsUsed: number } }
  | { ok: false; errors: SimError[] };

/** Run `analysis` on the model at `rel` and shape the tool result. */
function respond<R>(
  modelsRoot: string,
  rel: string,
  detail: "summary" | "full" | undefined,
  analysis: (model: Parameters<typeof boundarySweep>[0]) => Outcome<R>,
  summarize: (report: R) => unknown,
) {
  try {
    const { model } = loadModel(modelsRoot, rel);
    const outcome = analysis(model);
    if (!outcome.ok) return jsonResult({ path: rel, errors: outcome.errors }, true);
    const { findings, report, evaluationsUsed } = outcome.result;
    return jsonResult({
      path: rel,
      findings,
      report: detail === "full" ? report : summarize(report),
      evaluationsUsed,
    });
  } catch (err) {
    return handleError(err);
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Register the five search tools on `server`, bound to `modelsRoot`. */
export function registerSearchTools(server: McpServer, modelsRoot: string): void {
  server.registerTool(
    "sweep_boundaries",
    {
      title: "Sweep boundaries",
      description: `Run the model at the edges of its knobs and report problems that appear there but not at the defaults (search-boundary findings): each parameter alone at its min and max, all at max, all at min, and pairs at (max, max). \`fields\` adds plain numeric fields as knobs, as {path: "nodes.<id>.start|capacity|rate", min, max}. \`strategy\` (a model strategy id or inline strategy) replaces the default, which fires every interactive node every step. ${COMMON_DOC} The summary lists each setting with its score and problems.`,
      inputSchema: {
        ...common,
        strategy: strategy.optional(),
        fields: z
          .array(z.object({ path: z.string().min(1), min: z.number(), max: z.number() }))
          .optional(),
      },
    },
    async ({ path: rel, detail, ...options }) =>
      respond(
        modelsRoot,
        rel,
        detail,
        (model) => boundarySweep(model, options),
        (report) => ({
          knobs: report.knobs,
          settings: report.settings.map((s) => ({
            label: s.label,
            score: round(s.score),
            problems: s.problems,
          })),
          skipped: report.skipped,
        }),
      ),
  );

  server.registerTool(
    "find_dominant_combinations",
    {
      title: "Find dominant combinations",
      description: `Score focus strategies for sets of interactive nodes (fire every member every step it can) against a baseline that fires nothing, and flag a set far stronger together than its members alone (search-dominant). Every set up to size \`k\` (default 3) is tried when the budget allows; otherwise sets are sampled and improved by local search. \`nodes\` limits the search to those interactive nodes. \`minSynergy\` (default 1.5) and \`minMargin\` (default 0.2) set the thresholds. ${COMMON_DOC} The summary lists the 10 best sets.`,
      inputSchema: {
        ...common,
        k: z.number().int().positive().optional(),
        nodes: z.array(z.string().min(1)).optional(),
        minSynergy: z.number().positive().optional(),
        minMargin: z.number().min(0).optional(),
      },
    },
    async ({ path: rel, detail, ...options }) =>
      respond(
        modelsRoot,
        rel,
        detail,
        (model) => dominantCombinations(model, options),
        (report) => ({
          objective: report.objective.id,
          mode: report.mode,
          baseline: round(report.baseline.score),
          best: report.ranked.slice(0, 10).map((r) => ({
            nodes: r.nodes,
            score: round(r.score),
            gain: round(r.gain),
            synergy: r.synergy === null ? null : round(r.synergy),
          })),
          setsScored: report.ranked.length,
        }),
      ),
  );

  server.registerTool(
    "compare_systems",
    {
      title: "Compare systems",
      description: `Search each subsystem's interactive nodes alone and all of them together, and flag a subsystem that makes the others obsolete (search-system-dominance): its best reaches \`dominance\` (default 0.95) of the best gain, and adding any other subsystem's best set gains under \`minMargin\` (default 0.05). ${COMMON_DOC} The summary lists each subsystem's best set and share.`,
      inputSchema: {
        ...common,
        k: z.number().int().positive().optional(),
        dominance: z.number().positive().max(1).optional(),
        minMargin: z.number().min(0).optional(),
      },
    },
    async ({ path: rel, detail, ...options }) =>
      respond(
        modelsRoot,
        rel,
        detail,
        (model) => compareSystems(model, options),
        (report) => ({
          objective: report.objective.id,
          overall: report.overall && {
            nodes: report.overall.nodes,
            score: round(report.overall.score),
          },
          subsystems: report.subsystems.map((s) => ({
            subsystem: s.subsystem,
            best: s.best && { nodes: s.best.nodes, score: round(s.best.score) },
            share: s.share === null ? null : round(s.share),
            topShare: round(s.topShare),
          })),
        }),
      ),
  );

  server.registerTool(
    "optimize_player",
    {
      title: "Optimise player",
      description: `Play the model as a greedy player that tries every interactive fire, and doing nothing, by rollout before each step (\`horizon\` steps ahead, default 10, over \`rollouts\` seeds, default 4, up to \`actionsPerStep\` fires, default 1). Reports what it fired, a replayable rule strategy and its score, and flags a player that beats every intended model strategy by \`minMargin\` (default 0.2) as search-unintended-optimum. \`parameters\` and \`overrides\` set the model for the games. ${COMMON_DOC} The summary leaves out the played trace.`,
      inputSchema: {
        ...common,
        horizon: z.number().int().positive().optional(),
        rollouts: z.number().int().positive().optional(),
        actionsPerStep: z.number().int().positive().optional(),
        minMargin: z.number().min(0).optional(),
        parameters: z.record(z.number()).optional(),
        overrides: z.record(z.number()).optional(),
      },
    },
    async ({ path: rel, detail, ...options }) =>
      respond(
        modelsRoot,
        rel,
        detail,
        (model) => optimizePlayer(model, options),
        (report) => ({
          objective: report.objective.id,
          score: round(report.score),
          p5: round(report.p5),
          p95: round(report.p95),
          fires: report.fires,
          strategy: report.strategy,
          strategyScore: report.strategyScore === null ? null : round(report.strategyScore),
          intended: report.intended.map((s) => ({ id: s.id, score: round(s.score) })),
        }),
      ),
  );

  server.registerTool(
    "possibility_space",
    {
      title: "Possibility space",
      description: `Count how many strategies (found sets of interactive nodes, plus the model's strategies) score within \`viable\` (default 0.1) of the best, and flag a narrow space (search-narrow-space) with fewer than \`minViable\` (default 3) or under \`minViableShare\` (default 0.05) viable. The best \`top\` (default 10) are re-scored with each knob at its min and max to list robust strategies and specialists. \`fields\` adds plain numeric fields as knobs. ${COMMON_DOC} The summary lists the viable candidates, robust and specialists.`,
      inputSchema: {
        ...common,
        k: z.number().int().positive().optional(),
        viable: z.number().min(0).optional(),
        minViable: z.number().int().positive().optional(),
        minViableShare: z.number().min(0).max(1).optional(),
        top: z.number().int().positive().optional(),
        fields: z
          .array(z.object({ path: z.string().min(1), min: z.number(), max: z.number() }))
          .optional(),
      },
    },
    async ({ path: rel, detail, ...options }) =>
      respond(
        modelsRoot,
        rel,
        detail,
        (model) => possibilitySpace(model, options),
        (report) => {
          const entry = (r: (typeof report.robust)[number]) => ({
            label: r.label,
            worstCase: round(r.worstCase),
            bestCase: round(r.bestCase),
            ...(r.dependsOn ? { dependsOn: r.dependsOn } : {}),
          });
          return {
            objective: report.objective.id,
            candidates: report.candidates.length,
            viableCount: report.viableCount,
            viable: report.candidates
              .filter((c) => c.viable)
              .map((c) => ({ label: c.label, score: round(c.score) })),
            settings: report.settings,
            robust: report.robust.map(entry),
            specialists: report.specialists.map(entry),
          };
        },
      ),
  );
}
