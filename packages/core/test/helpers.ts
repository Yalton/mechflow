import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../src/model/types.js";
import { parseModelYaml } from "../src/model/io.js";

// Resolve the repo root from this file's location (packages/core/test/helpers.ts
// -> three levels up) so the path is correct regardless of the process cwd.
const ROOT = dirname(fileURLToPath(import.meta.url));
export const EXAMPLES_DIR = join(ROOT, "..", "..", "..", "fixtures", "examples");

export function loadExample(name: string): Model {
  const text = readFileSync(join(EXAMPLES_DIR, `${name}.yaml`), "utf8");
  const result = parseModelYaml(text);
  if (!result.ok) throw new Error(`failed to parse example model "${name}"`);
  return result.model;
}

export function listExamples(): string[] {
  return readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".yaml"));
}
