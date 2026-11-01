import { parse, stringify } from "yaml";
import { validateModel, type ValidateResult } from "./schema.js";
import type { Model } from "./types.js";

/**
 * YAML (de)serialization for mechflow models.
 *
 * These functions are pure: they take and return strings and never touch the
 * filesystem, so they are safe to call from the core package (which must stay
 * free of IO side effects beyond YAML parse/serialize).
 */

export function parseModelYaml(text: string): ValidateResult {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    const e = err as { line?: number; column?: number; message?: string };
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: e.message ?? "YAML syntax error",
          line: typeof e.line === "number" ? e.line + 1 : undefined,
        },
      ],
    };
  }
  if (doc === null || typeof doc !== "object") {
    return { ok: false, errors: [{ path: "", message: "top-level YAML value must be a map" }] };
  }
  return validateModel(doc);
}

const KEY_ORDER = [
  "version",
  "name",
  "description",
  "properties",
  "subsystems",
  "nodes",
  "edges",
  "noInteraction",
  "invariants",
  "endConditions",
  "parameters",
  "objectives",
  "strategies",
] as const;

/**
 * Serialize a model to YAML with a stable key order so that repeated serializations
 * of the same model produce byte-identical output (small diffs). Node position
 * data is preserved because it is part of each node object.
 */
export function serializeModelYaml(model: Model): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const value = model[key];
    if (key === "description" && value === undefined) continue;
    if (key === "noInteraction" && Array.isArray(value) && value.length === 0) continue;
    if (key === "invariants" && Array.isArray(value) && value.length === 0) continue;
    const optionalList =
      key === "endConditions" || key === "parameters" || key === "objectives" || key === "strategies";
    if (optionalList && (value === undefined || (Array.isArray(value) && value.length === 0))) {
      continue;
    }
    ordered[key] = value;
  }
  return stringify(ordered, { lineWidth: 0, singleQuote: false });
}
