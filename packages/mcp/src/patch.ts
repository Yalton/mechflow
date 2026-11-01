import { z } from "zod";
import {
  type SchemaError,
  parseModelYaml,
  serializeModelYaml,
  validateModel,
  type Edge,
  type Model,
  type Node,
  type Property,
  type Subsystem,
} from "@mechflow/core";
import { resolveWithin, updateModelFile } from "./paths.js";

/**
 * JSON-Patch-like operations applied to a parsed model by the MCP `patch_model`
 * tool. Each operation is structural; the resulting model is validated as a
 * whole by `validateModel` before it is ever written, so every write is checked.
 */
export type PatchOperation =
  | { op: "add_node"; node: Node }
  | { op: "update_node"; id: string; node: Partial<Omit<Node, "kind">> }
  | { op: "remove_node"; id: string }
  | { op: "add_edge"; edge: Edge }
  | { op: "update_edge"; id: string; edge: Partial<Omit<Edge, "kind">> }
  | { op: "remove_edge"; id: string }
  | { op: "add_property"; property: Property }
  | { op: "add_subsystem"; subsystem: Subsystem }
  | { op: "add_no_interaction"; a: string; b: string; reason: string };

export const PATCH_OP_NAMES = [
  "add_node",
  "update_node",
  "remove_node",
  "add_edge",
  "update_edge",
  "remove_edge",
  "add_property",
  "add_subsystem",
  "add_no_interaction",
] as const;

/**
 * Zod schema for validating operations at the MCP boundary. Node/edge/property/
 * subsystem payloads are left open (`z.any()`) and enforced by the core schema
 * in `validateModel`, so the boundary schema stays small and the core stays the
 * single source of truth for the model format.
 */
export const PatchOperationSchema = z.union([
  z.object({ op: z.literal("add_node"), node: z.any() }),
  z.object({ op: z.literal("update_node"), id: z.string(), node: z.record(z.any()) }),
  z.object({ op: z.literal("remove_node"), id: z.string() }),
  z.object({ op: z.literal("add_edge"), edge: z.any() }),
  z.object({ op: z.literal("update_edge"), id: z.string(), edge: z.record(z.any()) }),
  z.object({ op: z.literal("remove_edge"), id: z.string() }),
  z.object({ op: z.literal("add_property"), property: z.any() }),
  z.object({ op: z.literal("add_subsystem"), subsystem: z.any() }),
  z.object({ op: z.literal("add_no_interaction"), a: z.string().min(1), b: z.string().min(1), reason: z.string().min(1) }),
]);

/** Thrown when an operation is structurally invalid (bad id, duplicate, etc). */
export class PatchError extends Error {
  override name = "PatchError";
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Apply a sequence of operations to a model, returning a new model. Pure and
 * immutable: the input model is never mutated. Structural problems throw
 * {@link PatchError}; shape validation is deferred to `validateModel`.
 */
export function applyOperations(model: Model, operations: readonly PatchOperation[]): Model {
  const next: Mutable<Model> = {
    ...model,
    nodes: [...model.nodes],
    edges: [...model.edges],
    properties: [...model.properties],
    subsystems: [...model.subsystems],
    noInteraction: [...model.noInteraction],
    invariants: [...model.invariants],
  };

  for (const op of operations) {
    switch (op.op) {
      case "add_node": {
        if (next.nodes.some((n) => n.id === op.node.id)) {
          throw new PatchError(`add_node: node "${op.node.id}" already exists`);
        }
        next.nodes.push(op.node as Node);
        break;
      }
      case "update_node": {
        const idx = next.nodes.findIndex((n) => n.id === op.id);
        if (idx === -1) throw new PatchError(`update_node: no node with id "${op.id}"`);
        next.nodes[idx] = { ...next.nodes[idx], ...op.node } as Node;
        break;
      }
      case "remove_node": {
        const idx = next.nodes.findIndex((n) => n.id === op.id);
        if (idx === -1) throw new PatchError(`remove_node: no node with id "${op.id}"`);
        next.nodes.splice(idx, 1);
        // Dropping a node would strand its edges; remove them so the model stays valid.
        next.edges = next.edges.filter((e) => e.from !== op.id && e.to !== op.id);
        break;
      }
      case "add_edge": {
        if (next.edges.some((e) => e.id === op.edge.id)) {
          throw new PatchError(`add_edge: edge "${op.edge.id}" already exists`);
        }
        if (!next.nodes.some((n) => n.id === op.edge.from)) {
          throw new PatchError(`add_edge: edge "${op.edge.id}" references unknown node "${op.edge.from}"`);
        }
        if (!next.nodes.some((n) => n.id === op.edge.to)) {
          throw new PatchError(`add_edge: edge "${op.edge.id}" references unknown node "${op.edge.to}"`);
        }
        next.edges.push(op.edge as Edge);
        break;
      }
      case "update_edge": {
        const idx = next.edges.findIndex((e) => e.id === op.id);
        if (idx === -1) throw new PatchError(`update_edge: no edge with id "${op.id}"`);
        next.edges[idx] = { ...next.edges[idx], ...op.edge } as Edge;
        break;
      }
      case "remove_edge": {
        const idx = next.edges.findIndex((e) => e.id === op.id);
        if (idx === -1) throw new PatchError(`remove_edge: no edge with id "${op.id}"`);
        next.edges.splice(idx, 1);
        break;
      }
      case "add_property": {
        if (next.properties.some((p) => p.id === op.property.id)) {
          throw new PatchError(`add_property: property "${op.property.id}" already exists`);
        }
        next.properties.push(op.property as Property);
        break;
      }
      case "add_subsystem": {
        if (next.subsystems.some((s) => s.id === op.subsystem.id)) {
          throw new PatchError(`add_subsystem: subsystem "${op.subsystem.id}" already exists`);
        }
        next.subsystems.push(op.subsystem as Subsystem);
        break;
      }
      case "add_no_interaction": {
        if (!next.nodes.some((n) => n.id === op.a)) {
          throw new PatchError(`add_no_interaction: no node with id "${op.a}"`);
        }
        if (!next.nodes.some((n) => n.id === op.b)) {
          throw new PatchError(`add_no_interaction: no node with id "${op.b}"`);
        }
        // Idempotent: a recorded pair (order-insensitive) is left as-is.
        const key = [op.a, op.b].sort().join("\u0000");
        const already = next.noInteraction.some((n) => [n.a, n.b].sort().join("\u0000") === key);
        if (!already) {
          next.noInteraction.push({ a: op.a, b: op.b, reason: op.reason });
        }
        break;
      }
    }
  }

  return next as Model;
}

/** Raised when the on-disk model fails to parse. */
export class ModelParseError extends Error {
  override name = "ModelParseError";
  constructor(
    readonly path: string,
    readonly errors: SchemaError[],
  ) {
    super("model is invalid");
  }
}

/** Raised when a patched model fails schema validation. */
export class ModelValidationError extends Error {
  override name = "ModelValidationError";
  constructor(
    readonly path: string,
    readonly errors: SchemaError[],
  ) {
    super("model is invalid");
  }
}

/**
 * Read, patch, validate, and write a model on disk. Shared by `patch_model`
 * and the ghost-resolution tools so every write goes through the same
 * resolve → parse → apply → validate → serialize → write pipeline. The write
 * is a compare-and-swap ({@link updateModelFile}), so a concurrent save is
 * patched on top of rather than overwritten. Throws {@link PathEscapeError},
 * {@link ModelParseError}, {@link PatchError}, {@link ModelValidationError}, or
 * {@link ModelConflictError} so callers can shape the error response.
 */
export function applyPatchToFile(
  modelsRoot: string,
  rel: string,
  operations: readonly PatchOperation[],
): { path: string; serialized: string } {
  const abs = resolveWithin(modelsRoot, rel);
  const serialized = updateModelFile(abs, rel, (text) => {
    const parsed = parseModelYaml(text);
    if (!parsed.ok) throw new ModelParseError(rel, parsed.errors);
    const next = applyOperations(parsed.model, operations);
    const result = validateModel(next);
    if (!result.ok) throw new ModelValidationError(rel, result.errors);
    return serializeModelYaml(result.model);
  });
  return { path: rel, serialized };
}
