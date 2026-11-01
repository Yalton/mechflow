# Search and stress testing design

This document designs search: searching a model for the
strategies its design actually rewards, and pushing it to its limits. It covers
how a player strategy is written in a model, how search explores combinations
of choices, and what each analysis reports. It builds on the simulation engine,
run API and Monte Carlo runner in `docs/simulation-semantics.md`, and keeps
that spec's rules: every run takes an explicit seed, results never depend on
YAML order, and `packages/core` stays free of IO.

**Status:** implemented in `packages/core/src/search`. Choices marked
**Decision** record the trade-offs made along the way.

## Why

It targets three classic balance failures:

- **Hidden dominant combinations.** Choices that are each reasonable alone can
  be extreme together.
- **System dominance.** One subsystem can make the others obsolete.
- **Boundary testing.** Run the model at 0 and at maximum resources, with every
  modifier stacked, and with maximum times maximum.
- **Viable possibility space.** Count how many strategies come within X% of
  the best.
- **Players as optimisers.** Players find what the design actually rewards,
  which may not be what was intended.
- **Robust versus specialist strategies.** Some strategies do well everywhere,
  others only in one setting.

Milestone 2 can run a model, but only under a fixed schedule of interactive
fires. It cannot say which choices a player should make, or whether the answer
is healthy.

## Goals

- **Find the problems without a designer driving.** A designer or an agent
  names an objective, and the tools report dominant combinations, obsolete
  subsystems, narrow possibility spaces and broken boundaries as findings.
- **Make every result replayable.** Each reported strategy, parameter setting
  and seed can be run again with `simulate`, or stepped in the web app.
- **Keep the cost bounded and visible.** Every search has an evaluation budget
  that the caller can see and raise.
- **Use the formats we already have.** Problems are reported as `Finding`s in
  the existing findings panel. Ranked results are reported as plain JSON data,
  which the MCP tools return and the web views plot.

## Non-goals

- **Game-tree search against opponents.** There is no minimax and no
  multi-agent equilibrium. The model has one player, and other actors are
  modelled as random or scheduled behaviour.
- **Learning players.** There is no reinforcement learning and no neural
  policy. The optimiser is a greedy player with a rollout lookahead.
- **Searching over structure.** Search never adds or removes nodes or edges.
  It varies only strategies and parameter values.
- **Simulating the mechanic map.** As in milestone 2, `mechanic` and `entity`
  nodes, `interaction` edges and properties take no part.

## Core concepts

### Choices a player makes: interactive nodes

In milestone 2, a player's only lever is firing interactive nodes, and the
engine already handles that through the activation phase. Search keeps it that
way, so a strategy is a rule for which interactive nodes to fire in each step.

Buying an upgrade, choosing a build path, or spending on one system rather
than another are all modelled as interactive converters and sources. Their
costs are the flow edges into them.

### Strategies

**Decision: a strategy is an ordered list of rules with a per-step action
budget.** Strategies are a new optional model field:

```yaml
strategies:
  - id: rush_army
    description: Spend everything on soldiers, build barracks when affordable.
    intended: true          # a strategy the designer means to be viable
    actionsPerStep: 1       # default 1
    rules:
      - fire: build_barracks
        when: "gold >= 50 && barracks < 3"
      - fire: train_soldier # no `when`: always try
```

These are the semantics:

1. At the start of each step, which is the same point at which conditions are
   evaluated, the rules are walked in list order.
2. A rule is *eligible* when its `when` holds (it has no `when`, or the `when`
   is non-zero and not NaN) and its node would be active if fired. That means
   all of the node's conditions hold.
3. The first `actionsPerStep` eligible rules fire their nodes. A node is
   counted at most once per step.
4. The fires go through the engine exactly as hand fires do. They appear in
   the trace as `fired` and in a new `firedByStrategy` list.

Rule order is the strategy's priority, so here list order carries meaning on
purpose. This does not break the order-independence goal, because that goal is
about nodes and edges.

Why rules and not schedules: schedules are open-loop. A schedule cannot say
"buy the upgrade when I can afford it", and most of the interesting dominant
strategies in a game economy are closed-loop. Why not a general expression
language for policies: ordered condition-and-action rules are the shape
designers already write ("if X, do Y, otherwise Z"). Search can also generate
and mutate them mechanically.

A run takes either `interactive` schedules or a `strategy`, not both. That
keeps a trace explainable. The strategy can be the id of a model strategy or
an inline object, so search can run strategies it generated without writing
them into the model.

`intended: true` marks the strategies the designer believes should be
competitive. The optimiser and possibility-space reports compare against them.

### Parameters

Sweeps need named knobs with intended ranges. **Decision: parameters are a new
optional model field, and every formula can read them.**

```yaml
parameters:
  - id: barracks_cost
    description: Gold cost of one barracks.
    value: 50
    min: 20
    max: 120
    integer: true   # sweeps only try whole numbers
```

A parameter id is resolved like a node id inside formulas: edge `rate` and
`multiplier`, register `formula`, conditions, `when` rules, invariants, end
conditions and objectives. A run option `parameters: { id: value }` overrides
values for that run. Ids share one namespace with node ids, and the schema
rejects clashes. As with node ids, a parameter that a formula reads needs an
id that is a formula identifier: letters, digits and underscores. A hyphen is
read as a minus sign.

Plain numeric fields (pool `start` and `capacity`, source and drain `rate`)
stay numbers. Search reaches them through **field overrides** instead, which
use the paths `nodes.<id>.start`, `nodes.<id>.capacity` and `nodes.<id>.rate`.
This means milestone 1 and 2 models can be swept without edits. A parameter
gives a knob a name and a range. A field override needs the range in the
request.

### Objectives

Search needs to know what "best" means. **Decision: objectives are a new
optional model field, and every search names one.**

```yaml
objectives:
  - id: wealth
    description: Gold at the end of the run.
    expr: "gold"
    measure: final      # final | mean | endStep
    sense: max          # max | min
```

The measures:

- `final` evaluates `expr` after the last step.
- `mean` averages `expr` over steps 1 to N, which rewards getting there early.
- `endStep` ignores `expr` and scores the step at which an end condition first
  held. A run that never ends scores `steps + 1`. Use it with `sense: min` for
  "win as fast as possible".

A candidate's **score** is the mean of the measure over a Monte Carlo batch,
using `runs` runs with seeds derived as in milestone 2. Its spread (p5, p50 and
p95) is reported alongside, and the robustness analysis uses it. A search with
no objective, or one naming an unknown objective, is an error.

### Evaluations and budgets

One **evaluation** is a Monte Carlo batch of one candidate. A candidate is a
strategy plus parameter values. Every search takes:

- `seed`;
- `runs` per evaluation (default 20);
- `steps`;
- `maxEvaluations` (default 500).

Each search reports how many evaluations it used. A search that would need
more evaluations than the budget allows switches from exhaustive to sampled,
as each analysis describes, and says so in its report.

All evaluations in one search use the **same derived seeds** (common random
numbers). Differences between candidates are then differences in strategy, not
in luck.

## The analyses

Each analysis is a pure function in `packages/core/src/search/` that returns
`{ findings: Finding[], report: <analysis-specific JSON> }`. Finding ids follow
the existing `<check>:<subject>` pattern. Thresholds are options with defaults,
like the simulation checks.

### Boundary sweep (`search-boundary`)

This analysis finds what breaks at the edges of the design space.

- **Knobs:** all parameters, plus any field overrides the caller names with
  ranges.
- **Settings tried:**
  - the defaults;
  - each knob alone at its min and at its max ("0 and max");
  - all knobs at max together, and all at min together ("max times max");
  - each pair of knobs at (max, max), when there are at most 8 knobs.
- **Strategy:** the named strategy, or by default the **stack-everything**
  strategy, which fires every interactive node every step it can. That
  strategy is "every modifier stacked".
- **Findings:** for each setting, the simulation checks and invariants run
  over its batch. A `search-boundary` finding is reported for each check
  finding or invariant violation that appears at a boundary setting but not at
  the defaults. Its `data` names the setting, so it can be replayed. A
  non-finite or exploding pool counts as well: one that passes `1e9`, or
  grows past `10×` its default-setting final.
- **Report:** a table of settings by score and by the number of findings.

**Decisions (c8m.6).**
- **One finding per problem.** The sweep reports one finding per problem,
  with the id `search-boundary:<problem>`. The problem is the underlying
  check finding's id, `invariant:<id>`, or `explosion:<pool>`.
  `data.settings` lists every boundary setting where the problem appears.
- **Explosion test.** It compares each pool's largest final amount across
  the batch's runs with that pool's largest final at the defaults. The
  default figure is floored at 1, so a pool that starts empty can still
  explode.
- **Duplicate settings.** A pair that equals "all max" (for example, when
  there are only two knobs) is tried once.
- **Budget.** Settings are tried in order: defaults, singles, all max, all
  min, then pairs. Those the budget does not allow are listed in
  `report.skipped`.

### Dominant combinations (`search-dominant`)

This analysis finds choices that are reasonable alone and extreme together.

- **Candidates:**
  - A *focus strategy* for a set S of interactive nodes fires the nodes of S
    in id order whenever it can, with `actionsPerStep: |S|`.
  - The search scores the baseline (fire nothing), every singleton and every
    set up to size `k` (default 3).
- **Exploring:** when the number of sets up to size k fits the budget, the
  search tries them all. Otherwise it samples sets at random with the search
  seed, then improves the best few by local search: swap one member in or
  out, and keep the change if the score improves. **Decision: no genetic
  algorithm in the first version.** Local search from samples is simpler to
  explain and replay. A genetic algorithm can be a follow-up if the example
  models show local optima.
- **Synergy:** the gain of S is `score(S) − score(baseline)`, with signs
  flipped for `sense: min`. The synergy of S is `gain(S)` divided by the sum
  of the gains of its members alone.
- **Finding:** a `search-dominant` finding is reported when the best set has
  synergy of at least `minSynergy` (default 1.5) and beats the best singleton
  by at least `minMargin` (default 20%). Its nodes are the members of S.
- **Report:** the candidates ranked by score, each with gain, synergy and
  spread.

**Decisions (c8m.7).**
- **The margin** is measured on the oriented scores:
  `best − bestSingle ≥ minMargin × |bestSingle|`.
- **Synergy is null** for single nodes, and when the members' gains alone
  sum to zero or less. A null synergy never raises a finding.
- **Sampled mode.**
  - All singletons are scored first.
  - Random sets of 2 to k members are then sampled until half the remaining
    budget is spent. Sampling uses the search seed.
  - Local search finishes the job. It starts from the 3 best sets and takes
    the first neighbour that improves.
- **Ties** are ranked by score, then by smaller set, then by node ids.
- **Free actions inflate larger sets.** A focus strategy fires all its
  members each step, so adding a member costs nothing. When firing has no
  cost in the model, the best set can therefore be a superset of the truly
  synergistic pair. Models should make firing cost something, which is also
  what makes a choice a real choice.

### System dominance (`search-system-dominance`)

This analysis finds a subsystem that makes the others obsolete.

- It groups interactive nodes by `subsystem`. Nodes with no subsystem form one
  group of their own.
- It runs the dominant-combination search restricted to each subsystem's
  nodes, and once unrestricted.
- **Finding:** a `search-system-dominance` finding is reported when the best
  strategy restricted to subsystem X scores at least `dominance` (default
  0.95) of the unrestricted best, and adding the best set from any other
  subsystem gains less than `minMargin` (default 5%).
- **Report:** each subsystem's best score as a share of the overall best, and
  each subsystem's share of the fires in the top 10 strategies.

**Decisions (c8m.8).**
- **Shares are gains.** They measure gain over the fire-nothing baseline,
  not raw scores, so a large baseline does not make every subsystem look
  dominant.
- **Budget split.** The budget is split evenly between the unrestricted
  search and one search per subsystem. One evaluation per other subsystem is
  held back for the "add their best set" checks.
- **The overall best** is the best set any of those searches found.
- **Fire shares** count set members in the unrestricted top 10. This is a
  proxy for fires.
- **When nothing is reported.** A model with fewer than two subsystems that
  have interactive nodes raises no finding. So does a check that runs out
  of budget.

### Optimiser player (`search-unintended-optimum`)

This analysis shows what the design actually rewards.

- **The player:** a greedy player chooses its fires each step by rollout.
  1. For each available action (fire one eligible interactive node, or do
     nothing), it copies the state, applies the action, and plays `horizon`
     steps ahead (default 10) using the do-nothing policy.
  2. It does this for `rollouts` seeds (default 4), with seeds derived from
     the step and the action, so the result stays reproducible.
  3. It takes the action with the best mean objective.
  4. With `actionsPerStep > 1`, it repeats steps 1–3 greedily on the updated
     choice.
- **Cost:** actions × rollouts × horizon engine steps per real step. The
  budget counts that work in equivalent evaluations.
- **Output:** a played trace and a fire frequency per node. The fire
  frequency is turned into a rule strategy: the nodes the player fired, in
  order of how often, each with no `when`. That strategy can be saved into the
  model and replayed.
- **Finding:** a `search-unintended-optimum` finding is reported when the
  optimiser's score beats every `intended` strategy by at least `minMargin`
  (default 20%). Its nodes are the nodes it fired most. When no strategy is
  marked intended, the report shows the comparison but raises no finding.

**Decisions (c8m.9).**
- **Games.** The player plays `runs` games, seeded with the same derived
  seeds as an evaluation. Its score is the mean of the objective's measure
  over those games.
- **Rollout seeds.** Each rollout is seeded from the game seed, the step and
  the rollout index. Every action is compared on the same rollout seeds.
- **Actions.** Each round tries every interactive node and doing nothing.
  Firing a node a condition blocks does nothing, so it scores the same as
  doing nothing. Ties go to doing nothing, then to the lowest id, and a
  round that prefers doing nothing ends the step's choices.
- **The played trace** is the first game, made with `createRun`. Its fires
  appear as `firedByHand`.
- **Budget.** The cost is `(interactive nodes + 1) × rollouts × horizon ×
  actionsPerStep` evaluations for the games, plus one each for the derived
  strategy and every intended strategy. A request over `maxEvaluations` is
  refused with an error before any work is done, rather than cut short.
- **The derived strategy** lists the fired nodes, most fired first, with no
  `when`. Its own score is reported, because it can differ from the
  player's.

### Viable possibility space (`search-narrow-space`)

This analysis measures how many strategies are good enough. It also sorts
strategies into robust and specialist.

- **Viable count:** it uses every candidate the dominant-combination search
  evaluated, plus any model strategies. It counts how many are within
  `viable` (default 10%) of the best.
- **Finding:** a `search-narrow-space` finding is reported when fewer than
  `minViable` (default 3) candidates, or under 5% of them, are viable.
- **Robustness:** the top candidates (default 10) are re-scored under the
  boundary sweep's single-knob settings. Each candidate gets a worst-case
  score (its p5 across settings) and a best-case score (its p95).
  - *Robust* candidates have the highest worst case.
  - *Specialist* candidates have a best case in the top 3 and a worst case in
    the bottom half.
- **Report:** the viable list, and the robust and specialist lists with the
  setting each specialist depends on.

**Decisions (c8m.10).**
- **Viable.** A candidate is viable when its oriented score is within
  `viable × |best|` of the best.
- **When to flag.** The finding needs more than `minViable` candidates,
  because a space with fewer cannot be called narrow.
- **Budget order.** The robustness pass is budgeted first:
  `min(top, budget / 2 / settings)` candidates times the settings. Then one
  evaluation goes to each model strategy. The candidate search gets the
  rest.
- **Settings** are the defaults plus each knob alone at its min and max.
  These are the boundary sweep's single-knob settings, built with the same
  helper. A model with no knobs skips the robustness pass.
- **Robust** lists the 3 best worst cases that are not specialists.
- **Specialists** are the top 3 by best case whose worst case is in the
  bottom half of the re-scored candidates. `dependsOn` is the setting where
  a specialist scores best.

## Where it runs

- **Core:** `packages/core/src/search/` holds the evaluator, the analyses and
  the strategy compiler. Strategy and parameter support live in the engine
  and run API in `packages/core/src/sim/`. All of it stays pure.
- **MCP:** one tool per analysis:
  - `sweep_boundaries`;
  - `find_dominant_combinations`;
  - `compare_systems`;
  - `optimize_player`;
  - `possibility_space`.

  Each takes the path, the objective, a seed, the budget options and the
  thresholds, and returns `{ findings, report, evaluationsUsed }`, with a
  summary by default and `detail: "full"` for the whole report. This mirrors
  `simulate`. **Decision: separate tools, not one `search` tool with a mode.**
  Separate tools give each one a small, documented input schema, which agents
  call more reliably.
- **Web:** **Decision: search runs in a Web Worker.** A search can take
  seconds, and the existing Monte Carlo tab runs on the main thread only
  because it is capped. A "Search" panel next to the charts has:
  - an objective picker and a budget field;
  - a tab per analysis;
  - ranked tables with a "Load strategy" button that steps the strategy in the
    run controls.

  Its findings join the findings panel, as the simulation checks do.

  **Decisions (c8m.12).**
  - **One worker, one search at a time.** `runSearch` in
    `packages/web/src/search/analyses.ts` is the single entry point. The
    worker calls it, and so do the tests and browsers without `Worker`,
    which run it on the main thread after a tick. Starting a search cancels
    the one running. Cancelling terminates the worker, and the next search
    starts a new one.
  - **The panel offers the shared options only:** objective, steps, runs and
    budget, with the seed taken from the run controls. Thresholds and `k`
    keep their defaults; the MCP tools expose them. A model without
    objectives gets a typed formula, scored at the end of the run (`final`),
    with a max/min choice.
  - **Results belong to one model object,** like a Monte Carlo batch. An
    edit hides them and their findings until the search is run again. Each
    analysis keeps its latest result, so switching tabs does not lose any.
  - **Loading a strategy** sets `strategy` in the run store and starts the
    stepped run over. The strategy survives edits, and "Play by hand"
    clears it.
  - **Saving a strategy (ypg.10).** A row whose strategy the search built
    (not a model strategy) also has "Save to model", which adds it to the
    model's strategies as one undoable edit. Its id is the found id made a
    formula identifier (`focus:drill+pray` becomes `focus_drill_pray`),
    numbered when taken. Saving is an edit, so the results clear until the
    next search, like any other edit.
  - **Run settings (kj1.10).** The run controls have a number input per
    model parameter, limited to its `[min, max]` and to whole numbers when
    `integer`; typing the model's own value back stores no change. Field
    overrides have no inputs: they arrive only from a boundary row and show
    as a note with a "Clear overrides" button. Each boundary row has "Load
    setting", which loads the sweep's strategy, the setting's parameter
    values and its overrides together. The strategy, parameters and
    overrides apply to the stepped run and the Monte Carlo batch alike, so
    changing any of them starts both over. Like the seed they survive
    edits; values for parameters the model no longer has are dropped when a
    run starts.
  - **Tables show the top 10 rows.**
- **Server:** no change. The browser and the MCP server both call core
  directly.

## Example models

Each analysis has an example under `models/examples/` that triggers its
finding:

- `combo.yaml`: two upgrades that each add +20% alone and multiply together.
- `obsolete.yaml`: a trade subsystem that out-earns combat and crafting
  combined.
- `exploit.yaml`: an intended "build then fight" strategy that loses to
  farming a cheap converter forever.
- `boundary.yaml`: a capacity-free pool that explodes when two rates are both
  at max.
- `narrow.yaml`: one build path is viable, and the rest trail by more than 30%.

The healthy `economy.yaml` should raise no search findings at the default
thresholds, apart from what the defaults are tuned against.

## Left to the builder

- Exact report field names, which should follow the existing `MonteCarloResult`
  style.
- How to print a summary for each MCP tool.
- Web table layout and the empty states.
- Whether the strategy compiler caches parsed `when` expressions. It should
  if profiling shows parsing in the hot loop.
