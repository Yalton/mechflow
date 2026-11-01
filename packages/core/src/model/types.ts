/**
 * Core model types for mechflow.
 *
 * A mechflow model combines a Machinations-style economy graph (sources, pools,
 * converters, drains, state edges) with a mechanic map (mechanics and entities
 * that read/write typed properties and interact via labelled edges). Everything
 * in this file is a plain structural type with no runtime dependency so the
 * analysis package can import it without pulling in the zod schema.
 */

export type PropertyKind = "number" | "flag" | "tag";

export interface Property {
  id: string;
  kind: PropertyKind;
  description?: string;
}

export type SubsystemTier = "core" | "support" | "flavor";

export interface Subsystem {
  id: string;
  name: string;
  role?: string;
  tier: SubsystemTier;
}

export interface Position {
  x: number;
  y: number;
  pinned?: boolean;
}

/**
 * When a node acts during a simulation step (docs/simulation-semantics.md,
 * "Activation"). Unset means `automatic`.
 */
export type Activation = "automatic" | "interactive" | "onStart" | "passive";
/** Whether a node moves resources along its inputs (pull) or outputs (push). */
export type FlowAct = "pull" | "push";
/** Rates as upper bounds (any) or as all-or-nothing requirements (all). */
export type FlowMode = "any" | "all";

export interface PoolNode {
  id: string;
  kind: "pool";
  name: string;
  subsystem?: string;
  position?: Position;
  capacity?: number;
  start: number;
  activation?: Activation;
  act?: FlowAct;
  flowMode?: FlowMode;
}

export interface SourceNode {
  id: string;
  kind: "source";
  name: string;
  subsystem?: string;
  position?: Position;
  rate: number;
  activation?: Activation;
  /** Sources always push. */
  act?: "push";
  /** Sources always move their full rate. */
  flowMode?: "all";
}

export interface DrainNode {
  id: string;
  kind: "drain";
  name: string;
  subsystem?: string;
  position?: Position;
  rate: number;
  activation?: Activation;
  /** Nothing ever flows out of a drain, so it can only pull. */
  act?: "pull";
  flowMode?: FlowMode;
}

export interface ConverterNode {
  id: string;
  kind: "converter";
  name: string;
  subsystem?: string;
  position?: Position;
  inputs: { resource: string; amount: number }[];
  outputs: { resource: string; amount: number }[];
  maxActivationsPerStep?: number;
  activation?: Activation;
  /** Converters always pull their inputs. */
  act?: "pull";
  /** Converters always need all their inputs. */
  flowMode?: "all";
}

export interface GateNode {
  id: string;
  kind: "gate";
  name: string;
  subsystem?: string;
  position?: Position;
  mode: "random" | "deterministic" | "condition";
}

export interface RegisterNode {
  id: string;
  kind: "register";
  name: string;
  subsystem?: string;
  position?: Position;
  formula: string;
}

export interface MechanicNode {
  id: string;
  kind: "mechanic";
  name: string;
  subsystem?: string;
  position?: Position;
  reads: string[];
  writes: string[];
  drives?: string[];
}

export interface EntityNode {
  id: string;
  kind: "entity";
  name: string;
  subsystem?: string;
  position?: Position;
  has: string[];
}

export type Node =
  | PoolNode
  | SourceNode
  | DrainNode
  | ConverterNode
  | GateNode
  | RegisterNode
  | MechanicNode
  | EntityNode;

export type EdgeKind = "flow" | "state" | "interaction";
export type Polarity = "+" | "-";
export type Strength = "modifier" | "gate" | "trigger";

export interface Edge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  label?: string;
  polarity?: Polarity;
  strength?: Strength;
  rate?: string;
  multiplier?: string;
  /** Flow edges only: steps before moved resources arrive. Unset means 0. */
  delay?: number;
}

export interface NoInteraction {
  a: string;
  b: string;
  reason: string;
}

export interface Invariant {
  id: string;
  description: string;
  expr?: string;
}

/** Stops a simulation run as soon as `expr` holds after a step. */
export interface EndCondition {
  id: string;
  description: string;
  expr: string;
}

/**
 * A named knob with its intended range (docs/search-design.md, "Parameters").
 * Formulas read a parameter by id, like a node.
 */
export interface Parameter {
  id: string;
  description: string;
  value: number;
  min: number;
  max: number;
  /** Sweeps try only whole numbers. */
  integer?: boolean;
}

/** What search optimises (docs/search-design.md, "Objectives"). */
export interface Objective {
  id: string;
  description: string;
  /** Ignored when `measure` is `endStep`. */
  expr: string;
  /** `final`: after the last step; `mean`: over steps 1 to N; `endStep`: when the run ended. */
  measure: "final" | "mean" | "endStep";
  sense: "max" | "min";
}

/** One rule of a strategy: fire `fire` when `when` holds (always, if unset). */
export interface StrategyRule {
  fire: string;
  when?: string;
}

/**
 * A player policy (docs/search-design.md, "Strategies"): each step, the first
 * `actionsPerStep` eligible rules, in list order, fire their nodes.
 */
export interface Strategy {
  id: string;
  description: string;
  /** A strategy the designer means to be competitive. */
  intended?: boolean;
  /** Unset means 1. */
  actionsPerStep?: number;
  rules: StrategyRule[];
}

export interface Model {
  version: 1;
  name: string;
  description?: string;
  properties: Property[];
  subsystems: Subsystem[];
  nodes: Node[];
  edges: Edge[];
  noInteraction: NoInteraction[];
  invariants: Invariant[];
  endConditions?: EndCondition[];
  parameters?: Parameter[];
  objectives?: Objective[];
  strategies?: Strategy[];
}

export function isMechanicOrEntity(node: Node): boolean {
  return node.kind === "mechanic" || node.kind === "entity";
}

export function nodeById(nodes: readonly Node[], id: string): Node | undefined {
  return nodes.find((n) => n.id === id);
}
