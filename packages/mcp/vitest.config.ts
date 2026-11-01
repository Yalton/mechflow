import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The mcp source uses bundler-style `.js` import specifiers that resolve to the
 * sibling `.ts` files on disk. Vite/Vitest does not rewrite `.js` -> `.ts` on its
 * own, so this pre-resolver mirrors that resolution and lets tests import
 * straight from `src/` with no build step.
 */
function tsSourceResolve() {
  return {
    name: "mechflow-mcp-ts-source",
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

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [tsSourceResolve()],
  resolve: {
    // Resolve the workspace packages to their source so mcp tests run without
    // a prior `pnpm -r build`.
    alias: {
      "@mechflow/core": resolve(here, "../core/src/index.ts"),
      "@mechflow/files": resolve(here, "../files/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
