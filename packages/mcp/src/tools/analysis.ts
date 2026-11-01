import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  analyzeModel,
  buildInteractionMatrix,
  findGhostEdges,
  parseModelYaml,
  traceEffects,
  type Model,
  type Report,
} from "@mechflow/core";
import { PathEscapeError, readModelFile, resolveWithin } from "../paths.js";

/**
 * Analysis tool handlers. Each handler resolves its path against the models
 * root, reads and parses the model on disk, and returns the corresponding
 * `@mechflow/core` analysis result as JSON. An invalid model returns its
 * validation errors (not a crash); a path that escapes the root or a node that
 * does not exist returns a clean error.
 */

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function jsonResult(value: unknown, isError = false): CallToolResult {
  return textResult(JSON.stringify(value, null, 2), isError);
}

/** Raised when a model file fails to parse; carries the validation errors. */
class ModelValidationError extends Error {
  constructor(
    readonly path: string,
    readonly errors: { path: string; message: string }[],
  ) {
    super("model is invalid");
  }
}

/** Raised for a request-level problem (unknown node, bad argument). */
export class ToolError extends Error {}

/**
 * Resolve, read, and parse the model at `rel` under `modelsRoot`. Throws
 * `PathEscapeError`, `ModelValidationError`, or `ToolError` on failure.
 */
export function loadModel(modelsRoot: string, rel: string): { model: Model; text: string } {
  const abs = resolveWithin(modelsRoot, rel);
  const text = readModelFile(abs);
  const parsed = parseModelYaml(text);
  if (!parsed.ok) {
    throw new ModelValidationError(rel, parsed.errors);
  }
  return { model: parsed.model, text };
}

/** Map any thrown error to a client-visible text/json error result. */
export function handleError(err: unknown): CallToolResult {
  if (err instanceof PathEscapeError) return textResult(err.message, true);
  if (err instanceof ToolError) return textResult(err.message, true);
  if (err instanceof ModelValidationError) {
    return jsonResult({ path: err.path, valid: false, errors: err.errors }, true);
  }
  if (err instanceof Error) return textResult(err.message, true);
  return textResult(String(err), true);
}

/**
 * Register the four analysis tools on `server`, all bound to `modelsRoot`.
 *
 * - `analyze_model`     — combined `analyzeModel` report.
 * - `trace_effects`     — depth-bounded effect trace from a node.
 * - `list_ghost_edges`  — related-but-unconnected mechanic/entity pairs.
 * - `get_interaction_matrix` — the mechanic/entity interaction matrix.
 */
export function registerAnalysisTools(server: McpServer, modelsRoot: string): void {
  server.registerTool(
    "analyze_model",
    {
      title: "Analyze model",
      description:
        "Run the full analysis over a model and return the combined report: summary counts per check, all findings, the interaction matrix, and ghost edges. `path` is relative to the models root. `checks` optionally restricts which checks run by id.",
      inputSchema: {
        path: z.string().min(1),
        checks: z.array(z.string()).optional(),
      },
    },
    async ({ path: rel, checks }) => {
      try {
        const { model } = loadModel(modelsRoot, rel);
        const report: Report = analyzeModel(model, checks ? { checks } : undefined);
        return jsonResult(report);
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.registerTool(
    "trace_effects",
    {
      title: "Trace effects",
      description:
        "Depth-bounded trace of a node's effects: outgoing flow/state/interaction edges and property links (a mechanic writing a property reaches every mechanic that reads it). Each node is recorded once at its shallowest depth with the cumulative polarity. `path` is relative to the models root; `node` must be an existing node id; `maxDepth` defaults to 3.",
      inputSchema: {
        path: z.string().min(1),
        node: z.string().min(1),
        maxDepth: z.number().int().positive().optional(),
      },
    },
    async ({ path: rel, node, maxDepth }) => {
      try {
        const { model } = loadModel(modelsRoot, rel);
        if (!model.nodes.some((n) => n.id === node)) {
          throw new ToolError(`unknown node "${node}"`);
        }
        const result = traceEffects(model, node, maxDepth);
        return jsonResult(result);
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.registerTool(
    "list_ghost_edges",
    {
      title: "List ghost edges",
      description:
        "Return mechanic/entity pairs that appear related (shared properties or a shared neighbour) but have no interaction edge and no intentional-none record, sorted by relevance. `path` is relative to the models root.",
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path: rel }) => {
      try {
        const { model } = loadModel(modelsRoot, rel);
        return jsonResult(findGhostEdges(model));
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.registerTool(
    "get_interaction_matrix",
    {
      title: "Interaction matrix",
      description:
        "Return the interaction matrix over mechanic and entity nodes: the sorted node ids and every pair with an interaction edge or an intentional-none record. `path` is relative to the models root.",
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path: rel }) => {
      try {
        const { model } = loadModel(modelsRoot, rel);
        return jsonResult(buildInteractionMatrix(model));
      } catch (err) {
        return handleError(err);
      }
    },
  );
}
