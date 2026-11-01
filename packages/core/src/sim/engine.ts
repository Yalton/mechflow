/**
 * The simulation step engine (docs/simulation-semantics.md).
 *
 * `createEngine` compiles a model once (parsing every formula and ordering the
 * registers) and `step` advances a state by one step, following the phases in
 * "Ordering within a step". Nothing here depends on the order of nodes or
 * edges in the model: every loop runs in id order, and competition is settled
 * by proportional sharing or the step's seeded shuffle.
 *
 * Running a model for many steps, stopping at end conditions and collecting
 * the trace is the run API's job; this file only steps.
 */

import { evaluate, references, type EvalContext } from "../formula/evaluate.js";
import { parseFormula, type Expr } from "../formula/parser.js";
import type { Activation, FlowAct, FlowMode, GateNode, Model } from "../model/types.js";
import type { Rng } from "./rng.js";
import type {
  EngineOptions,
  InteractiveSchedule,
  SimError,
  SimState,
  SimWarning,
  StepInput,
  StepRecord,
  Transit,
} from "./types.js";

/** Nodes that flow edges connect in a run. */
type FlowNodeKind = "pool" | "source" | "drain" | "gate";

interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  activation: Activation;
  act: FlowAct;
  flowMode: FlowMode;
  /** Upper bound on a pool's amount; undefined means unbounded. */
  capacity?: number;
  gateMode?: GateNode["mode"];
}

interface FlowEdge {
  id: string;
  from: string;
  to: string;
  /** Parsed `rate`, or null to use `fallbackRate`. */
  rate: Expr | null;
  /** A source's or drain's node rate, else 1. */
  fallbackRate: number;
  multiplier: Expr | null;
  /** Steps before moved resources arrive; 0 means this step. */
  delay: number;
}

/** A converter's pull-all inputs and next-step outputs, by pool. */
interface Converter {
  id: string;
  activation: Activation;
  inputs: { pool: string; amount: number }[];
  outputs: { pool: string; amount: number }[];
  maxActivations: number;
}

interface Register {
  id: string;
  formula: Expr;
}

/** A strategy, compiled (docs/search-design.md, "Strategies"). */
interface CompiledStrategy {
  actionsPerStep: number;
  rules: { fire: string; when: Expr | null }[];
}

/** An invariant or end condition. */
interface Check {
  id: string;
  expr: Expr;
}

/** A state edge, compiled. */
interface StateEdge {
  id: string;
  from: string;
  to: string;
  /** +1 for polarity "+", -1 for "-". */
  sign: number;
  /** A condition's `rate`, or a modifier's `multiplier`. */
  formula: Expr | null;
}

interface StateEdges {
  conditions: StateEdge[];
  triggers: StateEdge[];
  /** Modifiers on pools, applied in phase 6. */
  nodeModifiers: StateEdge[];
  /** Modifiers on sources, drains and converters, applied to their rates. */
  labelModifiers: StateEdge[];
}

export interface Engine {
  /** The state at step 0. Registers are evaluated once, drawing from `rng`. */
  initialState(rng: Rng): SimState;
  /**
   * Advance `state` by one step. `state` is left untouched. Throws if `input`
   * fires a node that is not interactive.
   */
  step(state: SimState, rng: Rng, input?: StepInput): { state: SimState; record: StepRecord };
}

export type CreateEngineResult = { ok: true; engine: Engine } | { ok: false; errors: SimError[] };

/** A group of driven edges, in the MM order the groups run in. */
type GroupKey = "pull-all" | "pull-any" | "push-all" | "push-any";
const GROUP_ORDER: readonly GroupKey[] = ["pull-all", "pull-any", "push-all", "push-any"];

/**
 * Slack when flooring a rate plus its carry, so that accumulated binary
 * fractions such as 1/3 + 1/3 + 1/3 count as a whole resource.
 */
const CARRY_EPSILON = 1e-9;

/** Code-unit order, independent of locale. */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Copy `record` with its keys in id order. */
function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort(byId)) out[key] = record[key]!;
  return out;
}

export function createEngine(model: Model, options: EngineOptions = {}): CreateEngineResult {
  const errors: SimError[] = [];
  const parse = (text: string, path: string): Expr | null => {
    const parsed = parseFormula(text);
    if (parsed.ok) return parsed.ast;
    errors.push({ path, message: `invalid formula: ${parsed.error.message}` });
    return null;
  };

  const nodes = new Map<string, FlowNode>();
  const nodeRates = new Map<string, number>();
  const registers: Register[] = [];
  const converters: Converter[] = [];
  const poolIds = new Set(model.nodes.filter((n) => n.kind === "pool").map((n) => n.id));
  for (const [i, node] of model.nodes.entries()) {
    switch (node.kind) {
      case "pool":
        nodes.set(node.id, {
          id: node.id,
          kind: "pool",
          activation: node.activation ?? "automatic",
          act: node.act ?? "pull",
          flowMode: node.flowMode ?? "any",
          ...(node.capacity !== undefined ? { capacity: node.capacity } : {}),
        });
        break;
      case "source":
        nodes.set(node.id, {
          id: node.id,
          kind: "source",
          activation: node.activation ?? "automatic",
          act: "push",
          flowMode: "all",
        });
        nodeRates.set(node.id, node.rate);
        break;
      case "drain":
        nodes.set(node.id, {
          id: node.id,
          kind: "drain",
          activation: node.activation ?? "automatic",
          act: "pull",
          flowMode: node.flowMode ?? "any",
        });
        nodeRates.set(node.id, node.rate);
        break;
      case "gate":
        // A gate holds nothing and acts like an automatic pull-any node on its
        // inputs; its outputs are routes, never driven.
        nodes.set(node.id, {
          id: node.id,
          kind: "gate",
          activation: "automatic",
          act: "pull",
          flowMode: "any",
          gateMode: node.mode,
        });
        break;
      case "converter": {
        const sides = { inputs: node.inputs, outputs: node.outputs };
        const converter: Converter = {
          id: node.id,
          activation: node.activation ?? "automatic",
          inputs: [],
          outputs: [],
          maxActivations: node.maxActivationsPerStep ?? 1,
        };
        for (const [side, list] of Object.entries(sides) as [
          "inputs" | "outputs",
          typeof node.inputs,
        ][]) {
          for (const [j, { resource, amount }] of list.entries()) {
            const path = `nodes.${i}.${side}.${j}`;
            if (!poolIds.has(resource)) {
              errors.push({
                path: `${path}.resource`,
                message: `converter "${node.id}" ${side.slice(0, -1)} "${resource}" is not a pool`,
              });
            }
            if (!Number.isInteger(amount) || amount < 0) {
              errors.push({
                path: `${path}.amount`,
                message: `converter "${node.id}" amounts must be whole numbers of at least 0 to simulate`,
              });
            }
            converter[side].push({ pool: resource, amount });
          }
        }
        if (converter.maxActivations < 1) {
          errors.push({
            path: `nodes.${i}.maxActivationsPerStep`,
            message: `converter "${node.id}" needs maxActivationsPerStep of at least 1`,
          });
        }
        converters.push(converter);
        break;
      }
      case "register": {
        const formula = parse(node.formula, `nodes.${i}.formula`);
        if (formula) registers.push({ id: node.id, formula });
        break;
      }
      default:
        // Mechanics and entities never take part in a run.
        break;
    }
  }
  converters.sort((a, b) => byId(a.id, b.id));

  const edges: FlowEdge[] = [];
  for (const [i, edge] of model.edges.entries()) {
    if (edge.kind !== "flow" || !nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const rate = edge.rate !== undefined ? parse(edge.rate, `edges.${i}.rate`) : null;
    const multiplier =
      edge.multiplier !== undefined ? parse(edge.multiplier, `edges.${i}.multiplier`) : null;
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      rate,
      fallbackRate: nodeRates.get(edge.from) ?? nodeRates.get(edge.to) ?? 1,
      multiplier,
      delay: edge.delay ?? 0,
    });
  }
  edges.sort((a, b) => byId(a.id, b.id));
  const gateOrder = orderGates(nodes, edges, errors);

  // State edges. Conditions and triggers act on any node that can be active;
  // modifiers act on pools (node modifiers) or on the rates of sources, drains
  // and converters (label modifiers). Others have no effect in a run.
  const kinds = new Map(model.nodes.map((n) => [n.id, n.kind]));
  const activatable = new Set([...nodes.keys(), ...converters.map((c) => c.id)]);
  const stateEdges: StateEdges = {
    conditions: [],
    triggers: [],
    nodeModifiers: [],
    labelModifiers: [],
  };
  for (const [i, edge] of model.edges.entries()) {
    if (edge.kind !== "state" || !kinds.has(edge.from) || !kinds.has(edge.to)) continue;
    const compiled = (formula: string | undefined, field: string): StateEdge => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      sign: edge.polarity === "-" ? -1 : 1,
      formula: formula !== undefined ? parse(formula, `edges.${i}.${field}`) : null,
    });
    const target = kinds.get(edge.to)!;
    switch (edge.strength ?? "modifier") {
      case "gate":
        if (activatable.has(edge.to)) stateEdges.conditions.push(compiled(edge.rate, "rate"));
        break;
      case "trigger":
        if (activatable.has(edge.to)) stateEdges.triggers.push(compiled(undefined, "rate"));
        break;
      case "modifier":
        if (target === "pool") {
          stateEdges.nodeModifiers.push(compiled(edge.multiplier, "multiplier"));
        } else if (target === "source" || target === "drain" || target === "converter") {
          stateEdges.labelModifiers.push(compiled(edge.multiplier, "multiplier"));
        }
        break;
    }
  }
  for (const list of Object.values(stateEdges) as StateEdge[][])
    list.sort((a, b) => byId(a.id, b.id));

  const interactive = new Map<string, InteractiveSchedule>();
  for (const id of Object.keys(options.interactive ?? {}).sort(byId)) {
    const schedule = options.interactive![id]!;
    const path = `options.interactive.${id}`;
    const node = nodes.get(id) ?? converters.find((c) => c.id === id);
    if (node?.activation !== "interactive") {
      errors.push({ path, message: `"${id}" is not an interactive node` });
    } else if (typeof schedule === "number" && !(schedule >= 0 && schedule <= 1)) {
      errors.push({ path, message: `a firing probability must be between 0 and 1` });
    } else if (Array.isArray(schedule) && !schedule.every((s) => Number.isInteger(s) && s >= 1)) {
      errors.push({ path, message: `firing steps must be whole numbers of at least 1` });
    } else {
      interactive.set(id, schedule);
    }
  }

  let strategy: CompiledStrategy | null = null;
  if (options.strategy) {
    const known = new Set([
      ...model.nodes.map((n) => n.id),
      ...(model.parameters ?? []).map((p) => p.id),
      "self",
    ]);
    const rules: CompiledStrategy["rules"] = [];
    for (const [i, rule] of options.strategy.rules.entries()) {
      const path = `options.strategy.rules.${i}`;
      const node = nodes.get(rule.fire) ?? converters.find((c) => c.id === rule.fire);
      if (node?.activation !== "interactive") {
        errors.push({ path: `${path}.fire`, message: `"${rule.fire}" is not an interactive node` });
      }
      const when = rule.when === undefined ? null : parse(rule.when, `${path}.when`);
      for (const ref of when ? references(when) : []) {
        if (!known.has(ref)) {
          errors.push({ path: `${path}.when`, message: `formula references unknown node "${ref}"` });
        }
      }
      rules.push({ fire: rule.fire, when });
    }
    const actions = options.strategy.actionsPerStep ?? 1;
    if (!(Number.isInteger(actions) && actions >= 1)) {
      errors.push({
        path: "options.strategy.actionsPerStep",
        message: "actionsPerStep must be a whole number of at least 1",
      });
    }
    strategy = { actionsPerStep: actions, rules };
  }

  const orderedRegisters = orderRegisters(registers, errors);
  const invariants: Check[] = [];
  for (const [i, invariant] of model.invariants.entries()) {
    if (invariant.expr === undefined) continue;
    const expr = parse(invariant.expr, `invariants.${i}.expr`);
    if (expr) invariants.push({ id: invariant.id, expr });
  }
  invariants.sort((a, b) => byId(a.id, b.id));
  const endConditions: Check[] = [];
  for (const [i, end] of (model.endConditions ?? []).entries()) {
    const expr = parse(end.expr, `endConditions.${i}.expr`);
    if (expr) endConditions.push({ id: end.id, expr });
  }
  endConditions.sort((a, b) => byId(a.id, b.id));

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    engine: new StepEngine(
      model,
      nodes,
      edges,
      converters,
      gateOrder,
      stateEdges,
      interactive,
      orderedRegisters,
      invariants,
      endConditions,
      strategy,
    ),
  };
}

/**
 * Registers in dependency order (Kahn's algorithm, ready registers taken in id
 * order). A cycle is reported as an error.
 */
function orderRegisters(registers: Register[], errors: SimError[]): Register[] {
  const byName = new Map(registers.map((r) => [r.id, r]));
  const dependsOn = new Map<string, Set<string>>();
  for (const r of registers) {
    dependsOn.set(
      r.id,
      new Set(references(r.formula).filter((id) => byName.has(id) && id !== r.id)),
    );
  }
  const selfReferencing = registers.filter((r) => references(r.formula).includes(r.id));
  const ordered: Register[] = [];
  const done = new Set<string>();
  for (;;) {
    const ready = [...dependsOn.keys()]
      .filter((id) => !done.has(id) && [...dependsOn.get(id)!].every((d) => done.has(d)))
      .sort(byId);
    if (ready.length === 0) break;
    for (const id of ready) {
      done.add(id);
      ordered.push(byName.get(id)!);
    }
  }
  const cyclic = [
    ...new Set([
      ...selfReferencing.map((r) => r.id),
      ...[...dependsOn.keys()].filter((id) => !done.has(id)),
    ]),
  ].sort(byId);
  if (cyclic.length > 0) {
    errors.push({ path: "nodes", message: `registers form a cycle: ${cyclic.join(", ")}` });
  }
  return ordered;
}

/**
 * Gates in routing order: a gate that feeds another routes first (Kahn's
 * algorithm, ties by id). A cycle made only of gates is reported as an error.
 */
function orderGates(nodes: Map<string, FlowNode>, edges: FlowEdge[], errors: SimError[]): string[] {
  const gates = [...nodes.values()].filter((n) => n.kind === "gate").map((n) => n.id);
  const feeders = new Map(gates.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    if (feeders.has(edge.from) && feeders.has(edge.to)) feeders.get(edge.to)!.add(edge.from);
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  for (;;) {
    const ready = gates
      .filter((id) => !done.has(id) && [...feeders.get(id)!].every((f) => done.has(f)))
      .sort(byId);
    if (ready.length === 0) break;
    for (const id of ready) {
      done.add(id);
      ordered.push(id);
    }
  }
  const cyclic = gates.filter((id) => !done.has(id)).sort(byId);
  if (cyclic.length > 0) {
    errors.push({ path: "edges", message: `gates form a cycle: ${cyclic.join(", ")}` });
  }
  return ordered;
}

/** A flow edge driven this step, with what it asks for. */
interface Driven {
  edge: FlowEdge;
  driver: FlowNode;
  /** Whole resources wanted from the source. */
  want: number;
  /** Arrivals per resource moved. */
  multiplier: number;
  /** Position of the driver in its group's seeded shuffle. */
  rank: number;
}

class StepEngine implements Engine {
  private readonly poolIds: string[];
  /** Parameter values by id; formulas read them like nodes. */
  private readonly parameters: Record<string, number> = {};
  /** Each gate's output edges, in id order. */
  private readonly gateOutputs = new Map<string, FlowEdge[]>();

  constructor(
    private readonly model: Model,
    private readonly nodes: Map<string, FlowNode>,
    private readonly edges: FlowEdge[],
    private readonly converters: Converter[],
    private readonly gateOrder: string[],
    private readonly stateEdges: StateEdges,
    private readonly interactive: Map<string, InteractiveSchedule>,
    private readonly registers: Register[],
    private readonly invariants: Check[],
    private readonly endConditions: Check[],
    private readonly strategy: CompiledStrategy | null,
  ) {
    for (const parameter of model.parameters ?? []) this.parameters[parameter.id] = parameter.value;
    this.poolIds = [...nodes.values()]
      .filter((n) => n.kind === "pool")
      .map((n) => n.id)
      .sort(byId);
    for (const gate of gateOrder) {
      this.gateOutputs.set(
        gate,
        edges.filter((e) => e.from === gate),
      );
    }
  }

  initialState(rng: Rng): SimState {
    const amounts: Record<string, number> = {};
    const starts = new Map(
      this.model.nodes.flatMap((n) => (n.kind === "pool" ? [[n.id, n.start] as const] : [])),
    );
    for (const id of this.poolIds) amounts[id] = starts.get(id)!;
    const carry: Record<string, number> = {};
    for (const edge of this.edges) carry[edge.id] = 0;
    for (const edge of this.stateEdges.nodeModifiers) carry[edge.id] = 0;
    return {
      step: 0,
      amounts,
      registers: this.computeRegisters(amounts, rng),
      carry,
      inTransit: [],
      triggered: [],
      gateCursor: {},
      warned: [],
    };
  }

  step(prev: SimState, rng: Rng, input: StepInput = {}): { state: SimState; record: StepRecord } {
    const step = prev.step + 1;
    const amounts = { ...prev.amounts };
    const carry = { ...prev.carry };
    const gateCursor = { ...prev.gateCursor };
    const warned = new Set(prev.warned);
    const warnings: SimWarning[] = [];
    const warn = (key: string, warning: SimWarning): void => {
      if (warned.has(key)) return;
      warned.add(key);
      warnings.push(warning);
    };
    const capacityLoss = new Map<string, number>();
    const lose = (pool: string, amount: number): void => {
      if (amount > 0) capacityLoss.set(pool, (capacityLoss.get(pool) ?? 0) + amount);
    };

    // Phase 1: arrivals from delays and last step's converters.
    const due = prev.inTransit.filter((t) => t.arrivesAtStep <= step);
    const inTransit: Transit[] = prev.inTransit.filter((t) => t.arrivesAtStep > step);
    const gateInbox = new Map<string, number>();
    const arrivals = this.arrive(due, amounts, gateInbox, lose);

    // Phase 2: registers, from the start-of-step state.
    const registers = this.computeRegisters(amounts, rng);

    // Phase 3: activation. Interactive nodes fire by schedule or by hand
    // (a probability is drawn even for a node fired by hand, so firing by hand
    // never shifts later draws); then every condition is evaluated, and a
    // node any condition fails stays inactive.
    const activatable = [...this.nodes.values(), ...this.converters];
    const firedByHand = [...new Set(input.fire ?? [])].sort(byId);
    for (const id of firedByHand) {
      if (!activatable.some((n) => n.id === id && n.activation === "interactive")) {
        throw new Error(`cannot fire "${id}": it is not an interactive node`);
      }
    }
    const fired = new Set(firedByHand);
    for (const node of activatable
      .filter((n) => n.activation === "interactive")
      .sort((a, b) => byId(a.id, b.id))) {
      const schedule = this.interactive.get(node.id) ?? "never";
      const fires =
        schedule === "always" ||
        (typeof schedule === "number" && rng.next() < schedule) ||
        (Array.isArray(schedule) && schedule.includes(step));
      if (fires) fired.add(node.id);
    }
    const value = (id: string): number =>
      amounts[id] ?? registers[id] ?? this.parameters[id] ?? 0;
    const blocked = new Set<string>();
    for (const condition of this.stateEdges.conditions) {
      const self = value(condition.from);
      let holds: boolean;
      if (condition.formula) {
        const ctx = this.context(amounts, registers, () => self, rng);
        const result = evaluateAt(condition.formula, ctx, `edge "${condition.id}" condition`);
        holds = result !== 0 && !Number.isNaN(result);
      } else {
        holds = condition.sign > 0 ? self > 0 : self === 0;
      }
      if (!holds) blocked.add(condition.to);
    }
    // The strategy fires the first `actionsPerStep` eligible rules: those
    // whose `when` holds on the start-of-step state and whose node no
    // condition blocks. A node counts once per step.
    const firedByStrategy: string[] = [];
    if (this.strategy) {
      for (const rule of this.strategy.rules) {
        if (firedByStrategy.length >= this.strategy.actionsPerStep) break;
        if (blocked.has(rule.fire) || firedByStrategy.includes(rule.fire)) continue;
        if (rule.when) {
          const self = value(rule.fire);
          const ctx = this.context(amounts, registers, () => self, rng);
          const result = evaluateAt(rule.when, ctx, `strategy rule for "${rule.fire}"`);
          if (result === 0 || Number.isNaN(result)) continue;
        }
        firedByStrategy.push(rule.fire);
        fired.add(rule.fire);
      }
    }
    const active = new Set(
      activatable
        .filter((n) => !blocked.has(n.id) && (fired.has(n.id) || this.isSelected(n, step, prev)))
        .map((n) => n.id),
    );

    // Label modifiers shift the rates of their targets for this step.
    const labelShift = new Map<string, number>();
    for (const modifier of this.stateEdges.labelModifiers) {
      const self = value(modifier.from);
      const multiplier = modifier.formula
        ? sanitize(
            evaluateAt(
              modifier.formula,
              this.context(amounts, registers, () => self, rng),
              `edge "${modifier.id}" multiplier`,
            ),
            "multiplier",
            modifier.id,
            warn,
          )
        : 1;
      labelShift.set(
        modifier.to,
        (labelShift.get(modifier.to) ?? 0) + modifier.sign * multiplier * self,
      );
    }

    // Phase 4: flow groups. Each edge is driven at most once per step: by its
    // source if that pushes, else by its target if that pulls. A gate's
    // outputs are routes and are never driven.
    const drivers = new Map<string, FlowNode>();
    for (const edge of this.edges) {
      const from = this.nodes.get(edge.from)!;
      const to = this.nodes.get(edge.to)!;
      if (from.kind === "gate") continue;
      // A gate a condition switched off takes nothing in.
      if (to.kind === "gate" && !active.has(to.id)) continue;
      if (active.has(from.id) && from.act === "push") drivers.set(edge.id, from);
      else if (active.has(to.id) && to.act === "pull") drivers.set(edge.id, to);
    }
    const activeConverters = this.converters.filter((c) => active.has(c.id));

    // The step's seeded shuffle, one per group, over the group's nodes in id
    // order. Converters act in the pull-all group.
    const ranks = new Map<string, number>();
    for (const group of GROUP_ORDER) {
      const members = new Set(
        [...drivers.values()].filter((n) => groupOf(n) === group).map((n) => n.id),
      );
      if (group === "pull-all") for (const c of activeConverters) members.add(c.id);
      rng.shuffle([...members].sort(byId)).forEach((id, rank) => ranks.set(id, rank));
    }

    // Rates and multipliers, in edge-id order, on the start-of-step state.
    const driven: Driven[] = [];
    for (const edge of this.edges) {
      const driver = drivers.get(edge.id);
      if (!driver) continue;
      const ctx = this.context(amounts, registers, () => amounts[edge.from] ?? 0, rng);
      const base = edge.rate
        ? evaluateAt(edge.rate, ctx, `edge "${edge.id}" rate`)
        : edge.fallbackRate;
      const shift =
        (this.nodes.get(edge.from)!.kind === "source" ? (labelShift.get(edge.from) ?? 0) : 0) +
        (this.nodes.get(edge.to)!.kind === "drain" ? (labelShift.get(edge.to) ?? 0) : 0);
      const rate = sanitize(base + shift, "rate", edge.id, warn);
      const total = rate + (carry[edge.id] ?? 0);
      const want = Math.floor(total + CARRY_EPSILON);
      carry[edge.id] = Math.max(0, total - want);
      const multiplier = edge.multiplier
        ? sanitize(
            evaluateAt(edge.multiplier, ctx, `edge "${edge.id}" multiplier`),
            "multiplier",
            edge.id,
            warn,
          )
        : 1;
      driven.push({ edge, driver, want, multiplier, rank: ranks.get(driver.id)! });
    }

    const flows = new FlowLedger(this.nodes, amounts);
    const failed: string[] = [];
    const activations = new Map<string, number>();
    for (const group of GROUP_ORDER) {
      const members = driven.filter((d) => groupOf(d.driver) === group);
      if (group.endsWith("-all")) {
        const converters = group === "pull-all" ? activeConverters : [];
        failed.push(...resolveAll(members, converters, ranks, flows, activations));
      } else {
        resolveAny(members, flows);
      }
    }

    // Gates route what reached them this step, after the flow groups, so
    // their deliveries get whatever room the flows left.
    for (const d of driven) {
      if (d.edge.delay === 0 && this.nodes.get(d.edge.to)!.kind === "gate") {
        const arrived = flows.arrived.get(d.edge.id) ?? 0;
        gateInbox.set(d.edge.to, (gateInbox.get(d.edge.to) ?? 0) + arrived);
      }
    }
    const gateLoss = new Map<string, number>();
    const routed = new Map<string, { moved: number; arrived: number }>();
    for (const gate of this.gateOrder) {
      const count = gateInbox.get(gate) ?? 0;
      if (count === 0) continue;
      const outputs = this.gateOutputs.get(gate)!;
      const ctx = this.context(amounts, registers, () => count, rng);
      const counts = this.route(gate, count, outputs, ctx, gateCursor, rng, warn);
      let lost = count - counts.reduce((sum, c) => sum + c, 0);
      outputs.forEach((out, i) => {
        const moved = counts[i]!;
        if (moved === 0) return;
        const multiplier = out.multiplier
          ? sanitize(
              evaluateAt(out.multiplier, ctx, `edge "${out.id}" multiplier`),
              "multiplier",
              out.id,
              warn,
            )
          : 1;
        const sent = Math.floor(moved * multiplier);
        const target = this.nodes.get(out.to)!;
        let arrived = sent;
        if (out.delay > 0) {
          if (sent > 0)
            inTransit.push({
              via: out.id,
              to: out.to,
              arrivesAtStep: step + out.delay,
              amount: sent,
            });
        } else if (target.kind === "gate") {
          gateInbox.set(out.to, (gateInbox.get(out.to) ?? 0) + sent);
        } else {
          arrived = Math.min(sent, flows.space(out.to));
          flows.fill(out.to, arrived);
          lost += sent - arrived;
        }
        routed.set(out.id, { moved, arrived });
      });
      if (lost > 0) gateLoss.set(gate, lost);
    }

    // Phase 5: commit every move of the step at once.
    for (const d of driven) {
      const moved = flows.moved.get(d.edge.id) ?? 0;
      const arrived = flows.arrived.get(d.edge.id) ?? 0;
      if (this.nodes.get(d.edge.from)!.kind === "pool") amounts[d.edge.from]! -= moved;
      const to = this.nodes.get(d.edge.to)!;
      if (d.edge.delay > 0) {
        if (arrived > 0) {
          inTransit.push({
            via: d.edge.id,
            to: to.id,
            arrivesAtStep: step + d.edge.delay,
            amount: arrived,
          });
        }
      } else if (to.kind === "pool") {
        amounts[to.id]! += arrived;
      }
    }
    for (const [pool, amount] of flows.consumed) amounts[pool]! -= amount;
    for (const converter of activeConverters) {
      const times = activations.get(converter.id) ?? 0;
      const shift = labelShift.get(converter.id) ?? 0;
      for (const output of converter.outputs) {
        const { pool } = output;
        const amount = Math.max(0, Math.floor(output.amount + shift + CARRY_EPSILON));
        if (times * amount > 0) {
          inTransit.push({
            via: converter.id,
            to: pool,
            arrivesAtStep: step + 1,
            amount: times * amount,
          });
        }
      }
    }
    for (const [edge, { arrived }] of routed) {
      const out = this.edges.find((e) => e.id === edge)!;
      if (out.delay === 0 && this.nodes.get(out.to)!.kind === "pool") amounts[out.to]! += arrived;
    }
    inTransit.sort(
      (a, b) => a.arrivesAtStep - b.arrivesAtStep || byId(a.via, b.via) || byId(a.to, b.to),
    );

    // Phase 6: node modifiers change their target by the source's change over
    // phases 1 to 5, scaled, keeping the fraction for later steps. Changes to
    // one pool are summed, then clamped to [0, capacity].
    const change = new Map<string, number>();
    for (const modifier of this.stateEdges.nodeModifiers) {
      const before = prev.amounts[modifier.from] ?? prev.registers[modifier.from] ?? 0;
      const delta = value(modifier.from) - before;
      const multiplier = modifier.formula
        ? sanitize(
            evaluateAt(
              modifier.formula,
              this.context(amounts, registers, () => value(modifier.from), rng),
              `edge "${modifier.id}" multiplier`,
            ),
            "multiplier",
            modifier.id,
            warn,
          )
        : 1;
      const total = modifier.sign * multiplier * delta + (carry[modifier.id] ?? 0);
      const whole = Math.sign(total) * Math.floor(Math.abs(total) + CARRY_EPSILON);
      carry[modifier.id] = total - whole;
      change.set(modifier.to, (change.get(modifier.to) ?? 0) + whole);
    }
    const modified: Record<string, number> = {};
    for (const pool of [...change.keys()].sort(byId)) {
      const capacity = this.nodes.get(pool)!.capacity ?? Infinity;
      const next = Math.min(capacity, Math.max(0, amounts[pool]! + change.get(pool)!));
      if (next !== amounts[pool]) modified[pool] = next - amounts[pool]!;
      amounts[pool] = next;
    }

    // A trigger fires when its source acted in full: it was active and every
    // edge it drove moved all it asked for (a converter: it activated). A
    // node that drove no edges acted in full by default.
    const actedInFull = (id: string): boolean => {
      if (!active.has(id)) return false;
      if (activations.has(id)) return activations.get(id)! > 0;
      return driven.every((d) => d.driver.id !== id || (flows.moved.get(d.edge.id) ?? 0) >= d.want);
    };
    const triggered = [
      ...new Set(this.stateEdges.triggers.filter((t) => actedInFull(t.from)).map((t) => t.to)),
    ].sort(byId);

    // Phase 7: invariants and end conditions on the new state.
    const checkCtx = this.context(amounts, registers, () => 0, rng);
    const invariantViolations = this.invariants
      .filter((inv) => {
        const value = evaluateAt(inv.expr, checkCtx, `invariant "${inv.id}"`);
        return value === 0 || Number.isNaN(value);
      })
      .map((inv) => inv.id);
    const ended = this.endConditions
      .filter((end) => {
        const result = evaluateAt(end.expr, checkCtx, `end condition "${end.id}"`);
        return result !== 0 && !Number.isNaN(result);
      })
      .map((end) => end.id);

    const edgeRecord = (
      driverValue: (d: Driven) => number,
      routedValue: (r: { moved: number; arrived: number }) => number,
    ): Record<string, number> =>
      sortedRecord({
        ...Object.fromEntries(driven.map((d) => [d.edge.id, driverValue(d)])),
        ...Object.fromEntries([...routed].map(([id, r]) => [id, routedValue(r)])),
      });
    for (const [id, amount] of flows.capacityLoss) lose(id, amount);
    const record: StepRecord = {
      step,
      amounts: sortedRecord(amounts),
      registers,
      wanted: edgeRecord(
        (d) => d.want,
        (r) => r.moved,
      ),
      moved: edgeRecord(
        (d) => flows.moved.get(d.edge.id) ?? 0,
        (r) => r.moved,
      ),
      arrived: edgeRecord(
        (d) => flows.arrived.get(d.edge.id) ?? 0,
        (r) => r.arrived,
      ),
      failed: failed.sort(byId),
      activations: sortedRecord(
        Object.fromEntries(activeConverters.map((c) => [c.id, activations.get(c.id) ?? 0])),
      ),
      arrivals: sortedRecord(Object.fromEntries(arrivals)),
      capacityLoss: sortedRecord(Object.fromEntries(capacityLoss)),
      fired: [...fired].sort(byId),
      firedByHand,
      firedByStrategy,
      modified,
      triggered,
      gateLoss: sortedRecord(Object.fromEntries(gateLoss)),
      inTransit: inTransit.reduce((sum, t) => sum + t.amount, 0),
      invariantViolations,
      ended,
      warnings,
    };
    const state: SimState = {
      step,
      amounts: record.amounts,
      registers,
      carry: sortedRecord(carry),
      inTransit,
      triggered,
      gateCursor: sortedRecord(gateCursor),
      warned: [...warned].sort(byId),
    };
    return { state, record };
  }

  /**
   * Phase 1: deliver resources that are due. Several arrivals at one full
   * pool share its room in proportion; the excess is a capacity loss.
   * Arrivals at a gate join that gate's input for this step. Returns what
   * each pool received.
   */
  private arrive(
    due: Transit[],
    amounts: Record<string, number>,
    gateInbox: Map<string, number>,
    lose: (pool: string, amount: number) => void,
  ): Map<string, number> {
    const received = new Map<string, number>();
    const byTarget = new Map<string, Transit[]>();
    for (const t of due) byTarget.set(t.to, [...(byTarget.get(t.to) ?? []), t]);
    for (const to of [...byTarget.keys()].sort(byId)) {
      const list = byTarget.get(to)!;
      const node = this.nodes.get(to);
      const total = list.reduce((sum, t) => sum + t.amount, 0);
      if (node?.kind === "gate") {
        gateInbox.set(to, (gateInbox.get(to) ?? 0) + total);
        continue;
      }
      if (node?.kind !== "pool") {
        // A drain swallows what arrives; a source has no room for it.
        if (node?.kind !== "drain") lose(to, total);
        continue;
      }
      const room =
        node.capacity === undefined ? Infinity : Math.max(0, node.capacity - amounts[to]!);
      const accepted = share(
        room,
        list.map((t) => t.amount),
        (a, b) => byId(list[a]!.via, list[b]!.via) || a - b,
      ).reduce((sum, n) => sum + n, 0);
      amounts[to]! += accepted;
      received.set(to, accepted);
      lose(to, total - accepted);
    }
    return received;
  }

  /**
   * How many of `count` resources a gate sends along each output, in output
   * order. Resources with nowhere to go are left out of the counts.
   */
  private route(
    gate: string,
    count: number,
    outputs: FlowEdge[],
    ctx: EvalContext,
    gateCursor: Record<string, number[]>,
    rng: Rng,
    warn: (key: string, warning: SimWarning) => void,
  ): number[] {
    const mode = this.nodes.get(gate)!.gateMode!;
    const formula = (out: FlowEdge): number | null =>
      out.rate ? evaluateAt(out.rate, ctx, `edge "${out.id}" rate`) : null;
    const weights = outputs.map((out) => {
      const value = formula(out);
      if (mode === "condition")
        return value === null || (value !== 0 && !Number.isNaN(value)) ? 1 : 0;
      return value === null ? 1 : sanitize(value, "rate", out.id, warn);
    });
    const counts = outputs.map(() => 0);
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total <= 0) return counts;
    if (mode === "random") {
      for (let n = 0; n < count; n++) {
        let r = rng.next() * total;
        let pick = weights.findIndex((w) => (r -= w) < 0);
        // Rounding can leave r at the very top; take the last weighted output.
        if (pick < 0) pick = weights.length - 1 - [...weights].reverse().findIndex((w) => w > 0);
        counts[pick]!++;
      }
      return counts;
    }
    // Smooth weighted round-robin, resumed from the gate's cursor.
    const previous = gateCursor[gate];
    const cursor =
      previous && previous.length === outputs.length ? previous.slice() : outputs.map(() => 0);
    for (let n = 0; n < count; n++) {
      let pick = 0;
      for (let i = 0; i < cursor.length; i++) {
        cursor[i]! += weights[i]!;
        if (cursor[i]! > cursor[pick]!) pick = i;
      }
      cursor[pick]! -= total;
      counts[pick]!++;
    }
    gateCursor[gate] = cursor;
    return counts;
  }

  /** Whether a node's activation mode selects it in `step`. */
  private isSelected(
    node: { id: string; activation: Activation },
    step: number,
    prev: SimState,
  ): boolean {
    if (prev.triggered.includes(node.id)) return true;
    switch (node.activation) {
      case "automatic":
        return true;
      case "onStart":
        return step === 1;
      case "interactive":
      case "passive":
        return false;
    }
  }

  private computeRegisters(amounts: Record<string, number>, rng: Rng): Record<string, number> {
    const values: Record<string, number> = {};
    for (const register of this.registers) {
      const ctx = this.context(amounts, values, () => 0, rng);
      values[register.id] = evaluateAt(register.formula, ctx, `register "${register.id}"`);
    }
    return sortedRecord(values);
  }

  /**
   * Formula context: pools read their amount, registers their value,
   * parameters their value, any other node 0. `self` reads `self()`.
   */
  private context(
    amounts: Record<string, number>,
    registers: Record<string, number>,
    self: () => number,
    rng: Rng,
  ): EvalContext {
    return {
      lookup: (id) =>
        id === "self" ? self() : (amounts[id] ?? registers[id] ?? this.parameters[id] ?? 0),
      rng: () => rng.next(),
    };
  }
}

/** A rate or multiplier that is negative or not finite becomes 0, with a warning. */
function sanitize(
  value: number,
  what: "rate" | "multiplier",
  edge: string,
  warn: (key: string, warning: SimWarning) => void,
): number {
  if (!Number.isFinite(value)) {
    warn(`invalid-${what}:${edge}`, {
      code: `invalid-${what}`,
      edge,
      message: `edge "${edge}" ${what} is not a finite number (${value}); treated as 0`,
    });
    return 0;
  }
  if (value < 0) {
    warn(`negative-${what}:${edge}`, {
      code: `negative-${what}`,
      edge,
      message: `edge "${edge}" ${what} is negative (${value}); treated as 0`,
    });
    return 0;
  }
  return value;
}

function evaluateAt(expr: Expr, ctx: EvalContext, where: string): number {
  try {
    return evaluate(expr, ctx);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`);
  }
}

function groupOf(node: FlowNode): GroupKey {
  return `${node.act}-${node.flowMode}`;
}

/**
 * What is still available and how much room is left during phase 4, and what
 * every edge has moved so far. Sources have unlimited supply and no room;
 * drains and gates have unlimited room and no supply. A pool's room is its
 * capacity less its start-of-step amount less what has already been sent to
 * it: its own outflows do not free room until the next step. A delayed edge
 * needs no room now, since capacity is checked when it arrives.
 */
class FlowLedger {
  readonly moved = new Map<string, number>();
  readonly arrived = new Map<string, number>();
  readonly capacityLoss = new Map<string, number>();
  /** What converters took from each pool. */
  readonly consumed = new Map<string, number>();
  private readonly available = new Map<string, number>();
  private readonly room = new Map<string, number>();

  constructor(nodes: Map<string, FlowNode>, amounts: Record<string, number>) {
    for (const node of nodes.values()) {
      if (node.kind === "pool") {
        const amount = amounts[node.id]!;
        this.available.set(node.id, amount);
        this.room.set(
          node.id,
          node.capacity === undefined ? Infinity : Math.max(0, node.capacity - amount),
        );
      } else if (node.kind === "source") {
        this.available.set(node.id, Infinity);
        this.room.set(node.id, 0);
      } else {
        this.available.set(node.id, 0);
        this.room.set(node.id, Infinity);
      }
    }
  }

  supply(id: string): number {
    return this.available.get(id)!;
  }

  space(id: string): number {
    return this.room.get(id)!;
  }

  /** Room for what `edge` delivers this step. */
  spaceFor(edge: FlowEdge): number {
    return edge.delay > 0 ? Infinity : this.space(edge.to);
  }

  take(id: string, amount: number): void {
    this.available.set(id, this.available.get(id)! - amount);
  }

  fill(id: string, amount: number): void {
    this.room.set(id, this.room.get(id)! - amount);
  }

  fillFor(edge: FlowEdge, amount: number): void {
    if (edge.delay === 0) this.fill(edge.to, amount);
  }

  consume(pool: string, amount: number): void {
    this.take(pool, amount);
    this.consumed.set(pool, (this.consumed.get(pool) ?? 0) + amount);
  }

  record(edge: string, moved: number, arrived: number): void {
    this.moved.set(edge, (this.moved.get(edge) ?? 0) + moved);
    this.arrived.set(edge, (this.arrived.get(edge) ?? 0) + arrived);
  }

  lose(pool: string, amount: number): void {
    if (amount > 0) this.capacityLoss.set(pool, (this.capacityLoss.get(pool) ?? 0) + amount);
  }
}

/**
 * All-mode nodes and converters in shuffle order. A node moves every edge in
 * full or nothing; a converter activates while all its inputs are available,
 * up to its limit. Returns the ids of those that failed outright and records
 * each converter's activations.
 */
function resolveAll(
  members: Driven[],
  converters: Converter[],
  ranks: Map<string, number>,
  flows: FlowLedger,
  activations: Map<string, number>,
): string[] {
  const byDriver = new Map<string, Driven[]>();
  for (const d of members) byDriver.set(d.driver.id, [...(byDriver.get(d.driver.id) ?? []), d]);
  const units = [
    ...[...byDriver].map(([id, edges]) => ({ id, edges, converter: undefined })),
    ...converters.map((converter) => ({ id: converter.id, edges: [], converter })),
  ].sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
  const failed: string[] = [];
  for (const unit of units) {
    if (unit.converter) {
      const need = new Map<string, number>();
      for (const { pool, amount } of unit.converter.inputs)
        need.set(pool, (need.get(pool) ?? 0) + amount);
      let times = 0;
      while (
        times < unit.converter.maxActivations &&
        [...need].every(([pool, amount]) => amount <= flows.supply(pool))
      ) {
        for (const [pool, amount] of need) flows.consume(pool, amount);
        times++;
      }
      activations.set(unit.id, times);
      if (times === 0) failed.push(unit.id);
      continue;
    }
    const need = new Map<string, number>();
    const fill = new Map<FlowEdge, number>();
    for (const d of unit.edges) {
      need.set(d.edge.from, (need.get(d.edge.from) ?? 0) + d.want);
      fill.set(d.edge, Math.floor(d.want * d.multiplier));
    }
    const roomNeeded = new Map<string, number>();
    for (const [edge, amount] of fill) {
      if (edge.delay === 0) roomNeeded.set(edge.to, (roomNeeded.get(edge.to) ?? 0) + amount);
    }
    const fits =
      [...need].every(([id, amount]) => amount <= flows.supply(id)) &&
      [...roomNeeded].every(([id, amount]) => amount <= flows.space(id));
    if (!fits) {
      failed.push(unit.id);
      for (const d of unit.edges) flows.record(d.edge.id, 0, 0);
      continue;
    }
    for (const [id, amount] of need) flows.take(id, amount);
    for (const [edge, amount] of fill) flows.fillFor(edge, amount);
    for (const d of unit.edges) flows.record(d.edge.id, d.want, fill.get(d.edge)!);
  }
  return failed;
}

/**
 * Any-mode edges: share each short source among the edges drawing on it, then
 * share each short target's room among the edges sending to it, both in
 * proportion to demand. Resources a full target refuses stay at the source and
 * are not offered to other edges this step.
 */
function resolveAny(members: Driven[], flows: FlowLedger): void {
  const tie =
    (group: Driven[]) =>
    (a: number, b: number): number =>
      group[a]!.rank - group[b]!.rank || byId(group[a]!.edge.id, group[b]!.edge.id);
  const take = new Map<Driven, number>();
  for (const group of groupBy(members, (d) => d.edge.from)) {
    const shares = share(
      flows.supply(group[0]!.edge.from),
      group.map((d) => d.want),
      tie(group),
    );
    group.forEach((d, i) => take.set(d, shares[i]!));
  }
  // Delayed edges need no room now, so each is its own target group.
  for (const group of groupBy(members, (d) =>
    d.edge.delay > 0 ? `\u0000${d.edge.id}` : d.edge.to,
  )) {
    const offered = group.map((d) => Math.floor(take.get(d)! * d.multiplier));
    const accepted = share(flows.spaceFor(group[0]!.edge), offered, tie(group));
    group.forEach((d, i) => {
      let moved = take.get(d)!;
      const arrived = accepted[i]!;
      if (arrived < offered[i]! && d.multiplier > 0) {
        moved = Math.min(moved, Math.ceil(arrived / d.multiplier));
        flows.lose(d.edge.to, Math.floor(moved * d.multiplier) - arrived);
      }
      flows.take(d.edge.from, moved);
      flows.fillFor(d.edge, arrived);
      flows.record(d.edge.id, moved, arrived);
    });
  }
}

function groupBy(items: Driven[], key: (d: Driven) => string): Driven[][] {
  const groups = new Map<string, Driven[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.keys()].sort(byId).map((k) => groups.get(k)!);
}

/**
 * Split `total` among integer `demands` in proportion (largest remainder),
 * never giving an item more than it asked for. When there is enough, everyone
 * gets their demand. Equal remainders go in `tie` order (by index).
 */
function share(total: number, demands: number[], tie: (a: number, b: number) => number): number[] {
  const sum = demands.reduce((s, d) => s + d, 0);
  if (sum <= total) return demands.slice();
  const shares = demands.map((d) => Math.floor((total * d) / sum));
  const remainders = demands.map((d) => (total * d) % sum);
  let left = total - shares.reduce((s, x) => s + x, 0);
  const order = demands
    .map((_, i) => i)
    .sort((a, b) => remainders[b]! - remainders[a]! || tie(a, b));
  for (const i of order) {
    if (left === 0) break;
    shares[i]!++;
    left--;
  }
  return shares;
}
