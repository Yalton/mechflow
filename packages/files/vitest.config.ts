import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The files source uses bundler-style `.js` import specifiers that resolve to the
 * sibling `.ts` files on disk. Vite/Vitest does not rewrite `.js` -> `.ts` on its
 * own, so this pre-resolver mirrors that resolution and lets tests import
 * straight from `src/` with no build step.
 */
function tsSourceResolve() {
  return {
    name: "mechflow-files-ts-source",
    enforce: "pre",
    resolveId(specifier: string, importer: string | undefined) {
      if (!importer || !specifier.endsWith(".js")) return null;
      if (specifier.startsWith("node:") || specifier.startsWith("data:")) return null;
      const importerPath = importer.startsWith("file:") ? fileURLToPath(importer) : importer;
      const asTs = resolve(dirname(importerPath), specifier).slice(0, -3) + ".ts";
      return existsSync(asTs) ? asTs : null;
    },
  };
}

export default defineConfig({
  plugins: [tsSourceResolve()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
