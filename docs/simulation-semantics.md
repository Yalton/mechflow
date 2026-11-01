# Simulation semantics

This document defines what one simulation step does to a mechflow model. It is
the spec for the engine in `packages/core/src/sim`, the run API built on it, and
every tool that reports simulated behaviour (the MCP `simulate` tool, the web
run controls, the Monte Carlo runner and the simulation-based checks).

It follows Micro-Machinations (MM), the formalised subset of Dormans'
Machinations language:

- P. Klint and R. van Rozen, *Micro-Machinations: A DSL for Game Economies*,
  SLE 2013 (<https://ir.cwi.nl/pub/21923>). Section 2 defines the node,
  activation, pull/push, any/all, condition and trigger semantics used here;
  section 2.7 defines step priorities and synchronous time.
- R. van Rozen and J. Dormans, *Adapting Game Mechanics with
  Micro-Machinations*, FDG 2014
  (<https://pure.hva.nl/ws/files/5233525/fdg2014_paper_34.pdf>). It restates
  the same core semantics.
- J. Dormans, *Engineering Emergence: Applied Theory for Game Design*, PhD
  thesis, 2012. Machinations' gates, delays, state connections (label and node
  modifiers, triggers, activators) and end conditions.

Where this spec departs from MM, the departure is marked **Departure** with the
reason. Choices the papers leave open, which mechflow has to settle, are marked
**Decision**.

## Goals

- **Reproducible.** A run is a pure function of the model, a seed and the run
  options. The same inputs give the same trace on every machine.
- **Order-independent.** Reordering nodes or edges in the YAML never changes a
  run. No rule may depend on storage order. This is the flaw found in
  dsgarage/machinations-web, where competing pulls were resolved in the order
  the editor happened to store edges.
- **Simultaneous.** Within a step, flows are computed from the state at the
  start of the step, not from the partly updated state.
- **Backward compatible.** Every simulation field is optional. Milestone 1
  models load and run unchanged, with the defaults below.

## Non-goals (for now)

- Simulating the mechanic map. `mechanic` and `entity` nodes, `interaction`
  edges and properties take no part in a run.
- MM modules (type definitions, instances, references, bindings) and instance
  pools.
- Machinations' asynchronous and turn-based time modes. Turns can be modelled
  with pools, conditions and triggers (SLE 2013, section 2.7).
- Queues, colour-coded resources and artificial players. Players and
  strategies are covered by search (`docs/search-design.md`).

## State

A run state holds:

- `step`: the number of completed steps, starting at 0.
- `amount[pool]`: a non-negative integer for every pool.
- `register[id]`: the current value of every register (a number).
- `carry[edge]`: the fractional remainder of every flow edge (see *Rates*).
- `inTransit`: resources on their way, as `(via, to, arrivesAtStep, amount)`,
  where `via` is the delayed edge or the converter they came from.
- `triggered`: the set of nodes that will be activated by a trigger in the
  next step.
- `gateCursor[gate]`: the deterministic-gate counters (see *Gates*).

The initial state (step 0) sets every pool to `start`, every carry to 0, and
leaves `inTransit` and `triggered` empty. Then registers are evaluated once.

Resources are integers, as in MM (pools are "a circle with an integer in it").
A pool `capacity` is an upper bound on its amount. Sources behave as pools with
infinite resources, and drains as pools with infinite room (SLE 2013).

## New model fields

All new fields are optional.

| Where | Field | Values | Default |
|-------|-------|--------|---------|
| pool, source, drain, converter | `activation` | `automatic`, `interactive`, `onStart`, `passive` | `automatic` |
| pool | `act` | `pull`, `push` | `pull` |
| pool, drain | `flowMode` | `any`, `all` | `any` |
| source | `act`, `flowMode` | only `push`, `all` | `push`, `all` |
| drain | `act` | only `pull` | `pull` |
| converter | `act`, `flowMode` | only `pull`, `all` | `pull`, `all` |
| flow edge | `delay` | integer steps, at least 0 | `0` |
| state edge | `strength` | adds `trigger` to `modifier`, `gate` | unchanged (`modifier`) |
| model | `endConditions` | list of `{ id, description, expr }` | none |

Where a value is fixed, the schema accepts only that value, so a model can
state it but not contradict it. `delay` is rejected on edges that are not flow
edges, and end condition ids must be unique. The schema validates these. Static
analysis ignores them unless a check is taught to use them.

**Departure: default activation.** In MM nodes are passive by default. In
mechflow they are `automatic`, so that milestone 1 models (which have rates
but no activation markers) run without edits. With automatic pulling pools,
every flow edge into a pool fires once per step, which is the classic
stock-and-flow reading of those models. Set `activation: passive` to get MM
behaviour.

## Activation

A node is *active* in a step when all of the following hold:

1. It is selected by its activation mode:
   - `automatic`: every step.
   - `onStart`: step 1 only (MM's "start" modifier).
   - `interactive`: only in steps where the run options ask for it (see
     *Interactive nodes*). MM: user actions "activate a node to act in the
     next state".
   - `passive`: never by itself.
2. Or, instead of 1, it was triggered in the previous step.
3. Every condition on it holds (see *State edges*), evaluated on the state at
   the start of the step. "A node can only be active if all of its conditions
   are true."

"The start of the step" means after phase 1 arrivals, with the step's
register values, which is the same state rates are evaluated on. An inactive
node can still be pulled from or pushed into by an active neighbour (MM), so a
condition on a source stops it pushing but not a pool pulling from it. A
condition on a gate is the exception: an inactive gate takes nothing in, though
it still routes resources a delay delivers to it.

Each active node acts at most once per step (MM synchronous time). A converter
is the exception: it acts up to `maxActivationsPerStep` times (default 1).

Gates and registers never act. Gates route resources as they pass through (see
*Gates*), and registers are recomputed every step.

## Rates

Every flow edge has a rate formula (`rate`, default `"1"`). It is evaluated on
the start-of-step state, with `self` bound to the edge's source amount. Dice
expressions draw from the run RNG. In any formula, a pool reads as its amount
and a register as its value; every other node (a source, drain, gate,
converter, mechanic or entity) reads as 0, and so does `self` when the edge's
source is not a pool.

If a source or drain has a node `rate`, that rate is used for each of its edges
that has no `rate` of its own.

**Decision: fractional rates.** Resources are integers, but rate formulas can
be fractional (`"1/3"`, `"income * 0.1"`). Each flow edge keeps a carry:
`want = floor(rate + carry)`, `carry = rate + carry - want`. A rate of 1/3 moves
one resource every third step. The floor allows a slack of 1e-9 so that summed
binary fractions such as 1/3 + 1/3 + 1/3 count as a whole. The rate, and with
it the carry, advances in every step the edge is driven, whether or not the
full amount could move; it does not advance in steps nobody drives the edge. This gives Machinations' "fires every n steps"
behaviour without a separate interval notation. A rate below 0 is treated as 0
and reported once per run as a warning.

The `multiplier` on a flow edge scales what arrives: the target receives
`floor(moved * multiplier)`, and the source loses `moved`. A multiplier other
than 1 therefore creates or destroys resources, which is what the milestone 1
multiplier check warns about. A multiplier that is negative or not finite is
treated as 0 and reported once per run, like a rate.

## Pull, push, any, all

An active node moves resources along its edges:

- **Pull** (the default) moves along its inputs, from each input's source into
  the node.
- **Push** moves along its outputs, from the node to each output's target.
- **Any** (the default) treats each edge's rate as an upper bound and moves as
  much as is available, edge by edge.
- **All** treats the rates as strict requirements. Either every edge moves its
  full amount or none does.

Sources always push and are always `all` (they cannot run short). Drains pull
by default. A converter pulls `all` on its inputs.

**Decision: one driver per edge.** If an edge's source pushes and its target
pulls, and both are active, MM would let both act on it and move it twice. In
mechflow each flow edge is driven at most once per step: by its source if that
is active and pushes, otherwise by its target if that is active and pulls.
Without this rule the default model (a source pushing into a pulling pool)
would move every source rate twice.

## Ordering within a step

MM leaves the order in which active nodes act undefined and then adds
priorities to cut down nondeterminism (SLE 2013, section 2.7): "active nodes
... are scheduled in the following order: pull all, pull any, push all, push
any. Groups of nodes from different categories do not compete for resources or
capacity." mechflow uses that order and resolves the competition left inside
each group deterministically.

A step runs these phases in order:

1. **Arrivals.** Delayed resources whose `arrivesAtStep` is this step are added
   to their target pools, up to capacity (the excess is lost and counted).
   Converter outputs from the previous step arrive here too.
2. **Registers.** Every register is recomputed from the start-of-step state in
   dependency order. A cycle among registers is a model error, reported before
   the run starts.
3. **Activation.** The set of active nodes is fixed (see *Activation*).
4. **Flow groups.** The four groups run in MM order: pull-all, pull-any,
   push-all, push-any. Each group sees the amounts left after the earlier
   groups have taken their share. Inside a group, competition is resolved as
   described in *Competing flows*.
5. **Commit.** All inflows of the step are credited at once. Resources taken in
   this step do not become available again until the next step, so a resource
   moves at most one edge per step (gates excepted).
6. **Modifiers and triggers.** Node modifiers are applied, and the trigger set
   for the next step is computed (see *State edges*).
7. **Checks.** Invariants and end conditions are evaluated on the new state.

## Competing flows

MM identifies two sources of nondeterminism (SLE 2013, figures 5 and 6):
several nodes competing for a pool that has too few resources, and several
nodes competing for a pool that has too little capacity. **Decision:** mechflow
resolves both without looking at storage order.

**Any-mode requests** in the same group share the scarce side in proportion to
their demands. If edges ask for `d1 … dn` from a pool with `a < Σd`, edge `i`
gets `floor(a * di / Σd)`, and the leftover units go one each to the edges with
the largest fractional parts. Equal fractional parts are ordered by the step's
seeded shuffle (below), then by edge id. Capacity shortage on a target is
shared the same way, and so is one any-mode node whose own edges ask for more
than it has (a push pool with several outputs).

Supply is shared first, then room. A pool's room is its capacity less its
amount at the start of phase 4 less what has already been sent to it this
step; its own outflows do not free room until the next step. Resources a full
target refuses stay at their source and are not offered to other edges in the
same step.

**All-mode requests** in the same group cannot be split. The group's
all-mode nodes are ordered by the step's seeded shuffle. Each node in turn
succeeds if every one of its edges can still move its full amount (resources
and capacity), and fails otherwise. A failed node moves nothing.

**The step's seeded shuffle** is a permutation of the competing node ids,
sorted by id and then shuffled with the run RNG. Over many steps no node is
favoured, a given seed always gives the same result, and moving a node in the
file changes nothing.

Proportional sharing is fair on average and keeps outcomes smooth, which
matters for the variance and starvation checks. A pure priority order would
make the same consumer starve every time.

## Converters

MM treats a converter as a drain, a trigger and a source, and so "converters
take two steps to complete". mechflow keeps that two-step timing:

- In step *t*, an active converter pulls `all` on its `inputs`: each
  `{resource, amount}` takes `amount` from the pool `resource`. It does this up
  to `maxActivationsPerStep` times, one activation at a time, while all inputs
  are available.
- The `outputs` for those activations are added in phase 1 of step *t + 1*.

A converter's inputs compete in the pull-all group with every other pull-all
node: it takes its place in that group's seeded shuffle, and when its turn
comes it activates as many times as its inputs and its limit allow. It fails
(and is listed in the step's `failed`) only if it cannot activate even once.
Outputs that do not fit when they arrive are a capacity loss.

A converter's `inputs` and `outputs` name pools directly. Flow edges into or
out of a converter carry nothing in a run. Amounts must be whole numbers of at
least 0, and `maxActivationsPerStep` at least 1; otherwise the model cannot be
simulated.

## Gates

A gate holds nothing. On its inputs it acts like an automatic pull-any node
(as an automatic Machinations gate does), so it draws from pools without the
pools having to push. Its outputs are routes: they are never driven, and
resources that reach the gate are routed along them at once, in the same step.
This is the only case where a resource moves more than one edge in a step.

**Decision: routing order.** Gates route after the four flow groups, so their
deliveries get whatever room the flows left. A gate that feeds another routes
first (ties by id), and a cycle made only of gates is a model error. Resources
a delay delivers to a gate in phase 1 are routed with that step's other input.

Every gate output formula is evaluated with `self` bound to the number of
resources passing through the gate this step. An output with no `rate` has
weight 1, or, for a condition gate, a condition that always holds. Output
multipliers apply as on any flow edge, and an output can be delayed.

- **`random`.** Each output edge's `rate` is a weight. Each resource chooses an
  output with probability weight / total weight, drawn from the run RNG. (In
  Machinations the weights are percentages; here they are relative.)
- **`deterministic`.** Outputs get resources in smooth weighted round-robin
  order. The gate's cursor persists across steps, so over time each output
  gets its weighted share exactly.
- **`condition`.** Each output edge's `rate` is a boolean formula, with `self`
  bound to the number of resources passing through this step. The resources
  are shared equally among the outputs whose condition holds, as with a
  deterministic gate.

A resource that has nowhere to go (no true condition, or a full target) is
destroyed and counted as gate loss in the step trace. **Decision:**
Machinations also destroys resources a gate cannot route. Counting the loss
makes it visible to the checks.

## Delays

A flow edge with `delay: n` (n ≥ 1) takes resources from its source in step
*t* and adds them to its target in phase 1 of step *t + n*. Capacity is checked
on arrival. Resources in transit belong to no pool and are reported separately
in the trace.

## State edges

State edges carry no resources. What they do depends on `strength`:

- **`gate` (an activator or condition).** The target node is active only if the
  condition holds at the start of the step. The condition is the edge's `rate`
  read as a boolean formula, with `self` bound to the source's amount (MM:
  "its source node is a pool that forms an implicit argument in the
  expression"). Without a formula, polarity `+` means `self > 0` and `-` means
  `self == 0`.
- **`trigger`.** MM: the source activates the target "when for each resource
  connection the source works on, there is a flow in the transition that is
  greater or equal to that of the associated flow rate expression". In other
  words, a trigger fires when its source acted in full this step. The target
  then acts in the next step. Automatic pulling nodes with no inputs, and
  automatic pushing nodes with no outputs, always fire their triggers.
- **`modifier`** (the default). Machinations' node and label modifiers,
  adapted to mechflow's node-to-node edges:
  - If the target is a pool, it is a node modifier. After the commit, the
    target changes by `polarity × multiplier × Δsource`, where `Δsource` is
    how much the source changed this step. The result is clamped to
    `[0, capacity]`.
  - If the target is a source, drain or converter, it is a label modifier.
    Each of the target's rates becomes
    `rate + polarity × multiplier × source`, evaluated at the start of the
    step.

  `multiplier` defaults to `"1"`.

**Decisions.**

- A node with several conditions is active only if all of them hold. Every
  condition is evaluated every step, even on nodes that are not selected, so
  that formula draws do not depend on activation.
- With a `rate` formula, polarity is ignored: the formula alone decides.
- A trigger's source "acted in full" when it was active and every flow edge it
  drove moved everything it asked for; for a converter, when it activated at
  least once. A node that drove no edges (MM's no-input or no-output case)
  acted in full whenever it was active. Several triggers on one target count
  once.
- A node modifier's `Δsource` is the source's change from the end of the
  previous step to the end of phase 5 (for a register, the change in its value
  between steps). Changes made by modifiers themselves are not part of any
  `Δsource`, so modifiers do not cascade within or across steps. Each modifier
  keeps its fractional remainder, like a rate's carry, and applies only whole
  resources. All modifiers on one pool are summed before the clamp, which is
  recorded as the step's `modified` amount.
- A label modifier reads its source's current value (a pool's amount, a
  register's value), not its change. On a source it shifts the rate of every
  flow edge out of the source; on a drain, every flow edge into it; on a
  converter, every output amount, rounded down and at least 0. A shifted rate
  that goes negative is treated as 0 with the usual warning.
- A modifier into a gate, register or mechanic, and a condition or trigger on
  a node that never acts, has no effect.

Rate formulas can already reference any node by id, so most dynamic rates are
better written inline (`rate: "10 + market / 4"`). Modifier edges exist so that
diagrams drawn the Machinations way also run.

## Interactive nodes

A run option says when each interactive node fires:

- `"never"` (the default),
- `"always"`,
- a probability `p` in `[0, 1]`, drawn per step from the run RNG, or
- an explicit list of steps.

The web run controls also let a person fire an interactive node by hand while
stepping. That action is recorded in the trace, so the run can be replayed.

**Decisions.** Schedules are an engine option keyed by node id; naming a node
that is not interactive, a probability outside `[0, 1]` or a step below 1 is an
error before the run starts. A fire by hand is a per-step input; firing a node
that is not interactive throws. A probability is drawn every step for every
node that has one, even when the node is also fired by hand, so firing by hand
never shifts later draws. The trace lists every node that fired in `fired` and
those fired by hand in `firedByHand`. A fired node still needs its conditions.

**Decision: the web run controls.** They sit in a panel at the bottom right of
the graph (seed, Step, Play/Pause, Reset, Run N steps, and a Fire button per
interactive node) and run the model in the browser through `createRun`. A Fire
button fires the node and takes one step. While a run is active, pools show
their current amount in amber, and flow edges that moved resources in the
latest step are drawn in amber. Any edit to the model, a reload, or a new seed
discards the run; the next step starts again from step 0.

**Decision: the web charts.** A chart panel under the graph plots the active
run's pool amounts per step, and a Monte Carlo tab runs a batch in the browser
(runs, steps, and the run controls' seed) and draws each pool's median with its
p5–p95 band. The browser refuses a batch above 500,000 runs × steps. The
first four pools by id are shown at first; clicking a pool on the graph shows
or hides its series. The single-trace checks over the run and the batch checks
over the batch join the static analysis findings in the findings panel.

## End conditions and invariants

A run stops after `steps` steps (a required run option), or as soon as any
`endConditions[].expr` holds after a step. The trace records which condition
ended the run and at which step.

**Decision.** End conditions are evaluated like invariants: after phase 6, on
the new pool amounts and the step's register values, and they hold when the
value is neither 0 nor NaN. Each step's record lists the ids that hold in
`ended`; the run API stops at the first step with any.

Invariants that have an `expr` are evaluated after every step, on the
committed pool amounts and the register values the step used. An expression
that evaluates to 0 or NaN is a violation. A violation is
recorded with its step and does not stop the run. Invariants without an `expr`
are documentation only.

## Randomness

Every run takes an explicit `seed` (a 32-bit integer). No API has a default
seed or falls back to `Math.random`.

- The generator is sfc32, with its four state words filled by splitmix32 from
  the seed and its first 12 outputs discarded. It lives in
  `packages/core/src/sim/rng.ts` and exposes `next()` in [0, 1), unbiased
  `int(n)` and a Fisher-Yates `shuffle`. A seed is any safe integer, taken
  modulo 2^32.
- Within a step, draws happen in phase order: registers in dependency order
  (ties by id); interactive-probability draws in node-id order; conditions,
  then label-modifier multipliers, in edge-id order; the shuffle for each flow
  group; rates and multipliers in edge-id order; gate routing in gate order;
  node-modifier multipliers in edge-id order; then invariants and end
  conditions in id order. A trace is
  therefore stable for a given seed regardless of storage order.
- Monte Carlo run *i* uses `splitmix32(seed + i)` as its seed. Each run is
  independent and can be replayed alone.

**Decisions: Monte Carlo batches** (`packages/core/src/sim/montecarlo.ts`).
`monteCarlo(model, { seed, runs, steps, interactive?, strategy?, parameters?,
overrides?, keepTraces? })` runs
`runs` (1 to 10,000) independent `simulate` runs, numbered from 0, and returns
each run's seed, length and end reason; per pool and per register, the mean
and p5/p25/p50/p75/p95 at every step from 0 (initial) to `steps`; and per pool,
every run's final amount (sorted) with its spread, min and max. A run that
ends early, at an end condition or on a formula error, keeps its last values
for the remaining steps, so every step has one value per run. Quantiles
interpolate linearly between order statistics. `keepTraces` also returns every
run's full trace for the batch checks. Problems with the model or options are
returned as errors, as with `simulate`.

## Trace

A run returns:

- the amount of every pool and the value of every register after every step,
- per step, what every driven edge asked for, moved and delivered (and what
  every gate output carried), failed all-mode activations (node, step),
  converter activations, phase 1 arrivals, gate losses, capacity losses,
  the total in transit, the interactive nodes that fired (and which by hand
  or by the run's strategy),
  node-modifier changes and the nodes triggered for the next step,
- invariant violations and the end reason.

The trace is plain JSON-serialisable data. It is what the MCP tool returns,
what the web charts plot and what the simulation-based checks read.

**Decisions: the run API** (`packages/core/src/sim/run.ts`).
`simulate(model, { seed, steps, interactive? })` runs to the end and returns
`{ ok: true, trace }`; `createRun(model, options)` returns a run with `step()`,
`fire(nodeId)`, `state` and `trace` for stepping by hand, where `steps` is
optional. A node fired with `fire` acts in the next `step()` only. Both
validate the model and the options first and return problems as
`{ ok: false, errors }`, never by throwing. `steps` must be a whole number from
1 to 100,000 and `seed` a safe integer. The trace holds the seed, the initial
amounts and registers, one record per step, every invariant violation with
its step, and `end`: the step count was reached, an end condition held (named),
or a formula failed to evaluate mid-run (with the message). A failed formula
ends the run with the trace so far instead of discarding it.

**Decisions: strategies and overrides in a run** (docs/search-design.md,
"Strategies" and "Parameters"). `simulate`, `createRun` and `monteCarlo` also
take:
- `strategy`: a model strategy's id, or an inline strategy object;
- `parameters`: values by parameter id;
- `overrides`: plain numeric fields by path (`nodes.<id>.start` and
  `nodes.<id>.capacity` on pools, `nodes.<id>.rate` on sources and drains).

These are applied to a copy of the model; the model passed in is never
changed. A strategy is evaluated in phase 3, after the conditions: rules are
walked in list order, a rule is eligible when no condition blocks its node and
its `when` holds (on the start-of-step state, with `self` bound to the node's
amount), and the first `actionsPerStep` eligible rules fire, each node at most
once. The step record lists them in `firedByStrategy`, in rule order, and they
also appear in `fired`. A fire by hand still works alongside a strategy.

These are errors before the run starts:
- `interactive` together with `strategy`;
- an unknown strategy id;
- an inline strategy whose rule fires a node that is not interactive, whose
  `when` does not parse or reads an unknown id, or whose `actionsPerStep` is
  not a whole number of at least 1;
- an unknown parameter, a value outside its `[min, max]`, or a fraction for an
  `integer` parameter;
- an override path that is malformed or names a field the node does not have,
  or a negative or non-finite override value.

## Simulation-based checks

These implement Lessons 4–6 of the user's notes. Each check reads one trace or
a Monte Carlo batch, and returns standard `Finding`s (stable ids, nodes,
`data`) so the findings panel can show them next to the static findings.

- **Inflation.** A pool grows without bound. Its amount at the end of the run
  is above a threshold multiple of its start, and the growth per step is still
  positive in the last quarter of the run.
- **Starvation.** A node's pulls fail, or move less than asked, for k or more
  consecutive steps because a source pool is empty.
- **Snowballing.** Positive feedback. A pool's growth per step correlates
  positively with its own amount, so the more it has, the faster it grows. The
  check reports the correlation and the feedback loop involved, taken from the
  static loop analysis.
- **Cascading failure.** One pool's starvation is followed within w steps by
  starvation of pools downstream of it.
- **Variance.** Across a Monte Carlo batch, the coefficient of variation of a
  pool's final amount is above a threshold. The finding includes the p5, p50
  and p95 values.
- **Worst-case streaks.** Across a batch, the longest run of failed or short
  activations for each node. The finding includes the worst run's seed so it
  can be replayed.

Every threshold has a default and can be overridden in the check options.

**Decisions: the single-trace checks** (`packages/core/src/sim/checks/`,
entry point `simulationChecks(trace, model, options?)`). Each finding is a
warning with id `<check>:<node>`; findings are sorted by id. Defaults:

| Check | Id | Fires when | Defaults |
| --- | --- | --- | --- |
| Inflation | `sim-inflation` | A pool without a capacity ends at `factor` × max(start, `minReference`) or more, and its average growth over the last quarter of the run is positive. Runs shorter than `minSteps` are not judged. | `factor` 4, `minReference` 10, `minSteps` 8 |
| Starvation | `sim-starvation` | A node is starved for `minStreak` or more consecutive steps. One finding per node, describing its longest episode. | `minStreak` 3 |
| Snowballing | `sim-snowballing` | The Pearson correlation between a pool's amount before a step and its growth in that step is at least `minCorrelation`, and the pool ends above its start. Constant growth has no correlation and never fires. | `minCorrelation` 0.8, `minSteps` 8 |
| Cascading failure | `sim-cascading-failure` | A node's first starvation episode is followed by an episode of a node it feeds by a flow edge starting within `window` steps, and so on down the chain. Reported once per origin; nodes already in a reported chain do not start their own. | `window` 5 |

A node is *starved* in a step when a flow edge into it moved less than it
asked from a pool that held less, at the start of the step, than all edges
together asked of it; or when it is a converter that failed because an input
pool held less than the input amount. The start-of-step amount leaves out
phase 1 arrivals, so the check errs towards reporting. A short flow from a
pool that had enough (because a full target refused it) is not starvation.

Snowballing names every reinforcing loop through the pool found by the static
feedback-loop analysis, in `nodes` and `data.loops`; a pool can snowball with
no loop in the graph when the growth comes from formulas. A snowballing pool
usually inflates too, and both findings are reported.

The examples `inflation.yaml`, `starvation.yaml`, `snowballing.yaml` and
`cascade.yaml` each trigger their check over 50 steps with seed 1.
`economy.yaml` reports three starvations, all real: the treasury pulls 50 a
step from a market that receives 10, and once the treasury runs dry at step
10 the workshop and the reserve go short.

**Decisions: the batch checks** (entry point
`batchChecks(result, model, options?)` over a `monteCarlo` result run with
`keepTraces: true`; the streaks check throws without the traces).

| Check | Id | Fires when | Defaults |
| --- | --- | --- | --- |
| Variance | `sim-variance` | The coefficient of variation (population standard deviation over mean) of a pool's final amount across the runs is above `maxCv`. Pools ending at 0 on average are skipped, and batches under `minRuns` runs are not judged. `data` has the p5, p50 and p95 finals, mean, standard deviation, min and max. | `maxCv` 0.5, `minRuns` 10 |
| Worst-case streaks | `sim-streaks` | A node's longest streak of consecutive short steps, in any run, is `minStreak` or more. A step is short when the node failed an all-mode activation or was starved (as the starvation check defines it). `data` has the worst streak, its first step, the run index and seed (replay it with `simulate`), and how many runs reached `minStreak`. Ties go to the lowest run index. | `minStreak` 5 |

In a deterministic model every run is the same, so the streaks check repeats
the starvation findings for run 0; it earns its keep when randomness makes
shortfalls lumpy. `variance.yaml` (a loot drop that pays out on a natural 20)
triggers the variance check over 50 runs of 50 steps.

## Left to the builder

- Trace storage. Full per-step snapshots are fine for the sizes we expect.
  Optimise only if Monte Carlo batches get slow.
- Default check thresholds. Pick defaults that flag the example models'
  obvious problems and nothing on a balanced economy, then tune.
