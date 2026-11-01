import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseModelYaml, serializeModelYaml, validateModel, type Model, type Edge } from "@mechflow/core";
import { recoverStaleModels } from "@mechflow/files";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  PathEscapeError,
  readModelFile,
  resolveWithin,
  updateModelFile,
  writeModelFileAtomic,
} from "./paths.js";
import {
  applyPatchToFile,
  applyOperations,
  ModelParseError,
  ModelValidationError,
  PatchError,
  PatchOperation,
  PatchOperationSchema,
} from "./patch.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerSimulateTool } from "./tools/simulate.js";
import { registerSearchTools } from "./tools/search.js";

/**
 * Brief model-format guide embedded in tool descriptions so an agent can write a
 * valid model without external docs. Mirrors the core schema: version/name/
 * properties/subsystems/nodes/edges, with optional noInteraction/invariants.
 */
const MODEL_FORMAT_DOC = [
  "A mechflow model is a YAML map: `version: 1`, `name`, optional `description`,",
  "`properties: [{id, kind}]` (kind: number|flag|tag), `subsystems: [{id, name, tier}]`",
  "  (tier: core|support|flavor), `nodes: [...]`, `edges: [...]`.",
  "Node kinds: pool{start}, source{rate}, drain{rate},",
  "  converter{inputs:[{resource,amount}],outputs:[...]}, gate{mode},",
  "  register{formula}, mechanic{reads:[],writes:[]}, entity{has:[]}.",
  "Edge: {id, kind: flow|state|interaction, from, to, label?, polarity? (+|-), strength?}.",
  "Optional: `noInteraction: [{a,b,reason}]`, `invariants: [{id,description}]`.",
].join("\n");

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function jsonResult(value: unknown, isError = false): CallToolResult {
  return textResult(JSON.stringify(value, null, 2), isError);
}

/** Recursively collect *.yaml/*.yml paths under `root`, returned relative to it. */
function listYamlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    // A model a crashed writer left moved aside would otherwise vanish.
    recoverStaleModels(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (/\.ya?ml$/i.test(entry.name)) out.push(path.join(dir, entry.name));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Build the MCP server bound to a models root directory. All tool paths are
 * resolved against this root and rejected if they escape it.
 */
export function createMcpServer(
  modelsRoot: string,
  name = "mechflow-mcp",
  version = "0.1.0",
): McpServer {
  const server = new McpServer({ name, version }, { capabilities: { tools: {} } });

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "List every *.yaml model file under the models root as a JSON array of paths relative to the root.",
      inputSchema: {},
    },
    async () => {
      try {
        const files = listYamlFiles(modelsRoot);
        return jsonResult(files.map((f) => path.relative(modelsRoot, f)));
      } catch (err) {
        return textResult(`Failed to list models: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "read_model",
    {
      title: "Read model",
      description:
        "Read a model file and return its YAML text plus a validation result. `path` is relative to the models root.",
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path: rel }) => {
      try {
        const abs = resolveWithin(modelsRoot, rel);
        const text = readModelFile(abs);
        const result = parseModelYaml(text);
        if (!result.ok) {
          return jsonResult({ path: rel, valid: false, errors: result.errors }, true);
        }
        return jsonResult({ path: rel, valid: true, yaml: text, model: result.model });
      } catch (err) {
        return textResult(formatToolError(err), true);
      }
    },
  );

  server.registerTool(
    "write_model",
    {
      title: "Write model",
      description:
        `Create or overwrite a model file from YAML. The YAML is validated with the core schema; ` +
        `invalid models are refused and not written. ` +
        `path is relative to the models root.\n\n${MODEL_FORMAT_DOC}`,
      inputSchema: { path: z.string().min(1), yaml: z.string().min(1) },
    },
    async ({ path: rel, yaml }) => {
      try {
        const abs = resolveWithin(modelsRoot, rel);
        const result = parseModelYaml(yaml);
        if (!result.ok) {
          return jsonResult({ path: rel, valid: false, written: false, errors: result.errors }, true);
        }
        writeModelFileAtomic(abs, yaml);
        return jsonResult({ path: rel, valid: true, written: true });
      } catch (err) {
        return textResult(formatToolError(err), true);
      }
    },
  );

  server.registerTool(
    "patch_model",
    {
      title: "Patch model",
      description:
        "Apply a list of structural operations to an existing model, validate the result, and write it back. " +
        `path is relative to the models root. Operations:\n` +
        `- add_node {node} | update_node {id, node} | remove_node {id}\n` +
        `- add_edge {edge} | update_edge {id, edge} | remove_edge {id}\n` +
        `- add_property {property} | add_subsystem {subsystem} | add_no_interaction {a, b, reason}\n\n` +
        `Removing a node also removes its edges. The whole model is re-validated before writing; ` +
        `invalid results are refused. The returned ` +
        "`serialized` field is the new YAML.\n\n" + MODEL_FORMAT_DOC,
      inputSchema: {
        path: z.string().min(1),
        operations: z.array(PatchOperationSchema),
      },
    },
    async ({ path: rel, operations }) => {
      try {
        const { serialized } = applyPatchToFile(modelsRoot, rel, operations as unknown as PatchOperation[]);
        return jsonResult({ path: rel, valid: true, written: true, serialized });
      } catch (err) {
        return handlePatchError(err, rel);
      }
    },
  );

  server.registerTool(
    "mark_no_interaction",
    {
      title: "Mark no interaction",
      description:
        "Record that two nodes deliberately do not interact, silencing the corresponding ghost-edge finding from " +
        "list_ghost_edges. Idempotent: recording the same pair again is a no-op. `path` is relative to the models root.",
      inputSchema: {
        path: z.string().min(1),
        a: z.string().min(1),
        b: z.string().min(1),
        reason: z.string().min(1),
      },
    },
    async ({ path: rel, a, b, reason }) => {
      try {
        const { serialized } = applyPatchToFile(modelsRoot, rel, [
          { op: "add_no_interaction", a, b, reason },
        ] as unknown as PatchOperation[]);
        return jsonResult({ path: rel, written: true, serialized });
      } catch (err) {
        return handlePatchError(err, rel);
      }
    },
  );

  server.registerTool(
    "add_interaction",
    {
      title: "Add interaction",
      description:
        "Add an interaction edge between two nodes, validate the result, and write it back. An edge id is generated " +
        "from the endpoints (`<from>_to_<to>`, bumped if taken). `path` is relative to the models root.",
      inputSchema: {
        path: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        label: z.string().min(1).optional(),
        polarity: z.union([z.literal("+"), z.literal("-")]).optional(),
        strength: z.union([z.literal("modifier"), z.literal("gate")]).optional(),
      },
    },
    async ({ path: rel, from, to, label, polarity, strength }) => {
      try {
        const abs = resolveWithin(modelsRoot, rel);
        let edge: Edge | undefined;
        updateModelFile(abs, rel, (text) => {
          const parsed = parseModelYaml(text);
          if (!parsed.ok) throw new ModelParseError(rel, parsed.errors);
          // Rebuilt per attempt: a retry sees the newer edges, so the id stays unique.
          edge = buildInteractionEdge(from, to, parsed.model.edges, label, polarity, strength);
          const next = applyOperations(parsed.model, [{ op: "add_edge", edge }] as unknown as PatchOperation[]);
          const result = validateModel(next);
          if (!result.ok) throw new ModelValidationError(rel, result.errors);
          return serializeModelYaml(result.model);
        });
        return jsonResult({ path: rel, written: true, edge });
      } catch (err) {
        return handlePatchError(err, rel);
      }
    },
  );

  registerAnalysisTools(server, modelsRoot);
  registerSimulateTool(server, modelsRoot);
  registerSearchTools(server, modelsRoot);

  return server;
}

/** Map internal errors to a clean, client-visible message. */
function formatToolError(err: unknown): string {
  if (err instanceof PathEscapeError || err instanceof PatchError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Shape any error from the shared patch pipeline into a client-visible result. */
function handlePatchError(err: unknown, rel: string): CallToolResult {
  if (err instanceof ModelParseError) {
    return jsonResult(
      { path: rel, valid: false, written: false, errors: err.errors, message: "Source model is invalid; refusing to patch." },
      true,
    );
  }
  if (err instanceof PatchError) {
    return jsonResult(
      { path: rel, valid: false, written: false, errors: [{ path: "", message: err.message }], message: err.message },
      true,
    );
  }
  if (err instanceof ModelValidationError) {
    return jsonResult(
      { path: rel, valid: false, written: false, errors: err.errors, message: "Patched model failed validation; not written." },
      true,
    );
  }
  return textResult(formatToolError(err), true);
}

/** Generate a unique interaction edge id from the endpoints, bumping on collision. */
function buildInteractionId(from: string, to: string, existing: readonly string[]): string {
  const ids = new Set(existing);
  const base = `${from}_to_${to}`;
  let id = base;
  let n = 2;
  while (ids.has(id)) id = `${base}_${n++}`;
  return id;
}

/** Build an interaction edge with a generated id, omitting optional fields. */
function buildInteractionEdge(
  from: string,
  to: string,
  existing: readonly Edge[],
  label?: string,
  polarity?: "+" | "-",
  strength?: "modifier" | "gate",
): Edge {
  const edge: Edge = { id: buildInteractionId(from, to, existing.map((e) => e.id)), kind: "interaction", from, to };
  if (label !== undefined) edge.label = label;
  if (polarity !== undefined) edge.polarity = polarity;
  if (strength !== undefined) edge.strength = strength;
  return edge;
}

/** Create the server and connect it to a stdio transport (for the CLI). */
export async function startStdioServer(modelsRoot: string): Promise<void> {
  const server = createMcpServer(modelsRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Kept for callers that import the parsed model type without importing core directly.
export type { Model };
