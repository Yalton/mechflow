# Agent Instructions

Conventions for anyone, human or agent, changing this repository. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and the quality gates.

## Project Conventions

- **Package layout.** `packages/core` holds the model format, formula parser, static analysis, simulation, and search — no UI. Simulation follows the spec in `docs/simulation-semantics.md`; change the spec in the same change as the engine. `packages/mcp` is the stdio MCP server. `packages/server` is the local Node server that serves the web app and watches the models folder. `packages/files` holds the model file IO shared by the server and the MCP server (content hashes, compare-and-swap writes). `packages/web` is the Vite + React + React Flow browser app. Models are YAML files under `models/`; example models live in `models/examples/`. Tests read their own copies in `fixtures/examples/`, never `models/`, which users edit through the app.
- **`core` stays clean.** `packages/core` must stay free of DOM, filesystem, and network code. Its only IO is YAML parse/serialize. Preserve that boundary.
- **Tests.** All tests run with Vitest. Run the whole suite with `pnpm -r test`, or one package with `pnpm --filter @mechflow/<pkg> test`.
- **Formulas.** Formula expressions are never evaluated with `eval` or `Function`. Use the evaluator in `packages/core/src/formula/evaluate.ts`.
- **Simulations.** Every simulation run takes an explicit seed; never rely on `Math.random()` for a reproducible run.
- **Analysis findings.** Every analysis check returns findings in the shared `Finding` shape defined in `packages/core/src/analysis/types.ts`.
- **Charts are hand-rolled SVG.** The web simulation charts (`packages/web/src/panels/LineChart.tsx`) draw lines, p5–p95 bands, a hover crosshair and a table view in plain SVG and React, with no chart library. The app needs only one chart form, the series are small (at most a few thousand points), and a library would add more bundle weight than the whole chart while fighting the hover, legend and colour rules we want. Series colours are a fixed categorical palette assigned by pool id, so a pool keeps its colour when others are hidden. Reach for a library only if a second, substantially different chart form is needed.

## Model editing protocol (concurrent edits)

The browser and the MCP agent can edit the same model file. To avoid
silently clobbering a remote edit, the server uses HTTP `If-Match`:

- `GET /api/models/<path>` returns `{ yaml, model, errors, hash }`, where
  `hash` is `sha1` of the YAML text (see `packages/server/src/hash.ts`); the
  editor stores it as the If-Match for its next save.
- `PUT /api/models/<path>` accepts an `If-Match` header. Matching hash ->
  writes (200, returns the new `hash`). Changed-on-disk hash -> **409** with
  `{ conflict: true, loaded, hash, yaml }` (the server's current YAML). A
  missing `If-Match` writes unconditionally (backward compatible). Invalid
  input 422s before the hash is checked.
- The PUT body is YAML text by default. A client that cannot write YAML (an
  engine plugin, say) can instead send `content-type: application/json` with
  `{ "model": <the model object GET returned> }`; the server serializes it
  with `serializeModelYaml` and then validates and writes it exactly like a
  YAML body. Malformed JSON or a missing `model` 400s.
- The watcher (`packages/server/src/watch.ts`) emits the same `hash` on
  `model-changed`, so a live-updated browser keeps a valid If-Match.
- Client helper `packages/web/src/api/models.ts`: `fetchModel` + `saveModel`,
  which throws a `ConflictError` (carrying `remoteYaml`) on a 409.
- Every writer goes through `packages/files` (`@mechflow/files`). The server's
  If-Match PUT and the MCP read-modify-write tools (`updateModelFile`) use
  `compareAndSwapFileSync`: it moves the current file aside with `rename`,
  checks its hash, and publishes with `link` (never replacing a file another
  writer created meanwhile), so the check and the write are atomic across
  processes with no lock files. The file is briefly absent during a swap, so
  read model files with `readModelText` / `isModelFileSync`, which retry
  through that window; a plain `readFileSync` or `stat` can see a spurious
  ENOENT. `write_model` stays an unconditional overwrite. A writer that
  crashes mid-swap leaves the model only as `.<name>.aside-<pid>-<uuid>`;
  those readers, model listings and export restore such a file once it is
  stale (`recoverStaleModel` / `recoverStaleModels`). Anything else that moves
  a model aside must use `asidePath`, not `tempPath`, so it can be recovered.

**Browser behaviour on a 409:** if the editor has **no unsaved edits**, it
applies the server's current YAML and notifies the user; if it **has unsaved
edits**, it shows a banner offering **Reload** (take remote) or **Overwrite**
(keep local, re-PUT). Neither side is ever lost silently.

