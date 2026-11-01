# mechflow MCP server

`packages/mcp` is a stdio MCP server that lets agents build and analyse
[mechflow](../README.md) models. It exposes its tools over a single models
root: read/inspect models, edit them (write/patch), run the core analysis
(ghost edges, effect traces, interaction matrix), simulate, and search for
strategies that break the design.

Every tool path is resolved against the models root and rejected if it escapes
it. Every write is validated with the core schema before it hits disk, so an
invalid model is refused rather than written.

## Build

```bash
pnpm install
pnpm --filter @mechflow/mcp build   # -> packages/mcp/dist
```

The CLI entry point is `packages/mcp/dist/bin.js` (the `mechflow-mcp` bin). It
takes one argument:

```bash
node packages/mcp/dist/bin.js --models /path/to/models
```

- `--models, -m <dir>` — models root directory the server operates on.
- `--help, -h` — show usage.

## Register the server

### Claude Code

Point `claude mcp add` at the built binary with `--models` set to a project
folder. Use `--scope user` to make it available to every project, or omit it
for a project-local (`local`) registration:

```bash
claude mcp add mechflow -- \
  node /abs/path/to/mechflow/packages/mcp/dist/bin.js \
  --models /abs/path/to/your-project/models
```

If you have linked the package onto your PATH (for example with `pnpm link --global` in `packages/mcp`), the bare `mechflow-mcp` works too:

```bash
claude mcp add mechflow -- mechflow-mcp --models ./models
```

### Other clients

Register the same stdio command in your client's MCP config. For example, a
`~/.config/mcp.json`-style entry:

```json
{
  "mcpServers": {
    "mechflow": {
      "command": "node",
      "args": ["/abs/path/to/mechflow/packages/mcp/dist/bin.js", "--models", "/abs/path/to/models"]
    }
  }
}
```

The server uses newline-delimited JSON framing on stdio; no other transport is
needed.

## Tools

| Tool | One-liner |
| --- | --- |
| `list_models` | List every `*.yaml` model file under the models root as a JSON array of paths. |
| `read_model` | Read a model file: return its YAML text plus a validation result. |
| `write_model` | Create or overwrite a model file from YAML. Invalid models are refused. |
| `patch_model` | Apply a list of structural operations to a model, re-validate, and write it back. |
| `mark_no_interaction` | Record that two nodes deliberately do not interact, silencing the matching ghost-edge finding. Idempotent. |
| `add_interaction` | Add an interaction edge between two nodes (id generated from the endpoints), validate, and write it back. |
| `analyze_model` | Run the full analysis and return the combined report (summary, findings, matrix, ghost edges). |
| `trace_effects` | Depth-bounded trace of a node's effects on downstream nodes. |
| `list_ghost_edges` | List mechanic/entity pairs that look related but have no interaction edge. |
| `get_interaction_matrix` | Return the mechanic/entity interaction matrix. |
| `simulate` | Run a model for a number of steps with a seed and return per-pool series, totals and a per-step summary (or the full trace). |
| `sweep_boundaries` | Run the model at the edges of its parameters and report problems that appear there but not at the defaults. |
| `find_dominant_combinations` | Find sets of interactive nodes far stronger together than alone. |
| `compare_systems` | Find a subsystem that makes the others obsolete. |
| `optimize_player` | Play the model with a greedy lookahead player and compare it with the intended strategies. |
| `possibility_space` | Count how many strategies are viable, and which of the best are robust or specialists. |

### The `simulate` tool

`simulate` takes `{ path, seed, steps, interactive?, pools?, detail? }` and
runs the model as described in
[simulation-semantics.md](simulation-semantics.md). `seed` is any whole
number, and the same seed always gives the same run. `steps` is at most
100,000. The run stops early at the first step where one of the model's
`endConditions` holds. `interactive` schedules interactive nodes by id:
`"never"` (the default), `"always"`, a probability from 0 to 1, or a list of
step numbers.

```json
{
  "name": "simulate",
  "arguments": { "path": "examples/economy.yaml", "seed": 1, "steps": 3, "pools": ["treasury", "market"] }
}
```

returns a summary:

```json
{
  "path": "examples/economy.yaml",
  "seed": 1,
  "stepsRun": 3,
  "end": { "reason": "steps", "step": 3 },
  "pools": { "treasury": [1000, 890, 780, 680], "market": [0, 0, 10, 10] },
  "registers": {},
  "totals": {
    "moved": { "market_to_treasury": 10, "treasury_to_reserve": 30, "treasury_to_workshop": 300, "workshop_to_market": 20 },
    "arrived": { "market_to_treasury": 10, "treasury_to_reserve": 30, "treasury_to_workshop": 300, "workshop_to_market": 20 },
    "activations": {},
    "capacityLoss": {},
    "gateLoss": {}
  },
  "invariantViolations": [],
  "warnings": [],
  "steps": [{ "step": 1, "inTransit": 0 }, { "step": 2, "inTransit": 0 }, { "step": 3, "inTransit": 0 }]
}
```

Each series starts with the initial value, followed by the value after each
step. `pools` limits the series to those pools, and naming something that is
not a pool is an error. A step summary lists only what happened in that step:
`failed` all-mode nodes, `fired` interactive nodes, `triggered` nodes,
`capacityLoss` and `gateLoss` totals, `invariantViolations` and `ended`
conditions. `end.reason` is `steps`, `endCondition` (with the `conditions`)
or `error`, when a formula could not be evaluated mid-run (with the
`message`). `detail: "full"` returns the complete trace instead: every edge's
wanted, moved and arrived amounts in every step, and `pools` is ignored.

### The search tools

The five search tools run the analyses in
[search-design.md](search-design.md). Each takes the same core inputs:

- `path`: the model, relative to the models root.
- `objective`: a model objective id, or an inline objective
  `{id, description, expr, measure: final|mean|endStep, sense: max|min}`.
- `seed` and `steps`: as for `simulate`. The same seed always gives the same
  result.
- `runs`: Monte Carlo runs per evaluation (default 20).
- `maxEvaluations`: the most evaluations to spend (default 500).
- `detail`: `"summary"` (the default) or `"full"`, the whole report.

Each returns `{ path, findings, report, evaluationsUsed }`. The findings use
the shared Finding shape, and their `data` carries what is needed to replay
them with `simulate`: the seed, and the setting or strategy. Tool-specific
options:

- `sweep_boundaries`:
  - `strategy`: a strategy id or inline strategy. The default fires every
    interactive node every step.
  - `fields`: extra knobs, as `{path: "nodes.<id>.start|capacity|rate", min,
    max}`.
- `find_dominant_combinations`: `k` (largest set size, default 3), `nodes`
  (limit the search), `minSynergy` (default 1.5), `minMargin` (default 0.2).
- `compare_systems`: `k`, `dominance` (default 0.95), `minMargin` (default
  0.05).
- `optimize_player`:
  - `horizon` (default 10), `rollouts` (default 4), `actionsPerStep`
    (default 1).
  - `minMargin` (default 0.2).
  - `parameters` and `overrides`: as in a run.
  - The summary leaves out the played trace; `detail: "full"` includes it.
- `possibility_space`: `k`, `viable` (default 0.1), `minViable` (default 3),
  `minViableShare` (default 0.05), `top` (default 10), `fields`.

```json
{
  "name": "find_dominant_combinations",
  "arguments": { "path": "examples/combo.yaml", "objective": "wealth", "seed": 1, "steps": 30, "runs": 2, "k": 2 }
}
```

returns (finding `data` trimmed):

```json
{
  "path": "examples/combo.yaml",
  "findings": [
    {
      "id": "search-dominant:pray+sharpen",
      "check": "search-dominant",
      "severity": "warning",
      "title": "pray + sharpen dominate together",
      "detail": "Firing pray, sharpen together scores 1880 on wealth, 5.85× the sum of their gains alone and ahead of the best single choice (drill, 435). Replay it with the strategy in data.",
      "nodes": ["pray", "sharpen"],
      "edges": [],
      "data": { "...": "..." }
    }
  ],
  "report": {
    "objective": "wealth",
    "mode": "exhaustive",
    "baseline": 300,
    "best": [
      { "nodes": ["pray", "sharpen"], "score": 1880, "gain": 1580, "synergy": 5.85 },
      { "nodes": ["drill", "pray"], "score": 570, "gain": 270, "synergy": 1 },
      { "nodes": ["drill", "sharpen"], "score": 570, "gain": 270, "synergy": 1 },
      { "nodes": ["drill"], "score": 435, "gain": 135, "synergy": null },
      { "nodes": ["pray"], "score": 435, "gain": 135, "synergy": null },
      { "nodes": ["sharpen"], "score": 435, "gain": 135, "synergy": null }
    ],
    "setsScored": 6
  },
  "evaluationsUsed": 7
}
```

The example models `boundary.yaml`, `combo.yaml`, `obsolete.yaml`,
`exploit.yaml` and `narrow.yaml` each trigger one of the five findings.

### The `patch_model` operations

`patch_model` takes `{ path, operations }` where each operation is one of:

- `add_node {node}` · `update_node {id, node}` · `remove_node {id}`
- `add_edge {edge}` · `update_edge {id, edge}` · `remove_edge {id}`
- `add_property {property}` · `add_subsystem {subsystem}` · `add_no_interaction {a, b, reason}`

Removing a node also removes its edges. The whole model is re-validated before
writing; invalid results are refused.

### Model format (quick reference)

A mechflow model is a YAML map:

```yaml
version: 1
name: Campfire
description: optional
properties:
  - id: temperature
    kind: number            # number | flag | tag
subsystems:
  - id: core
    name: Core
    tier: core              # core | support | flavor
nodes:
  - id: fire
    kind: mechanic          # pool | source | drain | converter | gate |
    reads: []               # register | mechanic | entity
    writes: [temperature]
  - id: wood
    kind: entity
    has: [flammable]
edges:
  - id: fire_to_wood
    kind: interaction       # flow | state | interaction
    from: fire
    to: wood
    label: ignites
    polarity: "+"           # "+" | "-" (optional)
    strength: modifier      # modifier | gate (optional)
noInteraction:              # optional; silences a ghost edge
  - a: fire
    b: wood
    reason: unrelated
invariants: []              # optional
```

## Error handling

Invalid models return validation errors, never a crash:

- A path that escapes the models root returns a clean text error.
- A model that fails to parse returns `{ valid: false, errors }` (write/patch)
  or a text error (read).
- A structural patch problem (e.g. adding a node that already exists) or a
  patch that produces an invalid model returns
  `{ valid: false, written: false, errors, message }`.
- Analysis tools reject an unknown `node` and return validation errors for an
  invalid model.
- `simulate` returns `{ path, errors }` for options the model cannot run with,
  such as an interactive schedule for a node that is not interactive.
- The search tools return `{ path, errors }` the same way, for example for an
  unknown objective or an optimiser run that does not fit `maxEvaluations`.

All error results set `isError: true`.

## Worked example

An agent builds a small mechanic map and resolves the ghost edges the core
analysis flags.

### 1. Build and register

```bash
pnpm --filter @mechflow/mcp build

claude mcp add mechflow -- \
  node /abs/path/to/mechflow/packages/mcp/dist/bin.js \
  --models /abs/path/to/your-project/models
```

### 2. Write a small model

The map has `rain` feeding `river` (both touch `wetness`), but no edge yet — so
the analysis will flag them as a ghost edge.

```json
{
  "name": "write_model",
  "arguments": {
    "path": "watershed.yaml",
    "yaml": "version: 1\nname: Watershed\ndescription: Rain feeds a river.\nproperties:\n  - id: wetness\n    kind: number\nsubsystems:\n  - id: core\n    name: Core\n    tier: core\nnodes:\n  - id: rain\n    kind: mechanic\n    reads: []\n    writes: [wetness]\n  - id: river\n    kind: mechanic\n    reads: [wetness]\n    writes: [wetness]\nedges: []\nnoInteraction: []\ninvariants: []\n"
  }
}
```

### 3. Inspect the ghost edges

```json
{ "name": "list_ghost_edges", "arguments": { "path": "watershed.yaml" } }
```

Returns the unconnected pair:

```json
[
  {
    "a": "rain",
    "b": "river",
    "reasons": [
      { "kind": "sharedWrite", "property": "wetness" },
      { "kind": "readWrite", "property": "wetness" }
    ],
    "score": 5
  }
]
```

`rain` writes `wetness` and `river` reads it — they are related but have no edge.

### 4. Resolve the ghost

Two options:

- **Connect them** with an interaction edge (id generated from the endpoints):

  ```json
  {
    "name": "add_interaction",
    "arguments": {
      "path": "watershed.yaml",
      "from": "rain",
      "to": "river",
      "label": "feeds",
      "polarity": "+",
      "strength": "modifier"
    }
  }
  ```

- **Or silence it** if the relationship is genuinely out of scope (idempotent):

  ```json
  {
    "name": "mark_no_interaction",
    "arguments": {
      "path": "watershed.yaml",
      "a": "rain",
      "b": "river",
      "reason": "River is modelled at a different timescale."
    }
  }
  ```

### 5. Confirm

Re-run `list_ghost_edges` — the pair is now gone:

```json
[]
```

The written model now carries the edge (or the `noInteraction` record), and
`analyze_model` no longer reports it.
