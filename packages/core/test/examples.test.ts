import { describe, expect, it } from "vitest";
import { parseModelYaml } from "../src/model/io.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES_DIR, listExamples } from "./helpers.js";

describe("example models (jas.5)", () => {
  it("loads and validates every example fixture", () => {
    const files = listExamples();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(EXAMPLES_DIR, file), "utf8");
      const r = parseModelYaml(text);
      expect(r.ok).toBe(true);
    }
  });

  it("validates a specific named example", () => {
    const r = parseModelYaml(readFileSync(join(EXAMPLES_DIR, "elements.yaml"), "utf8"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.name).toBe("Elements");
  });
});
