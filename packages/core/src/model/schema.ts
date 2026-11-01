import { z } from "zod";
import { parseFormula, references } from "../formula/index.js";
import type {
  Edge,
  EndCondition,
  Model,
  Objective,
  Parameter,
  Strategy,
  Node,
  Position,
  Property,
  Subsystem,
} from "./types.js";

/**
 * Zod schema for a mechflow model.
 *
 * The base schema validates structure and kinds; `validateModel` additionally
 * runs cross-reference checks (endpoints exist, ids are unique and referenced)
 * via `superRefine` and returns a uniform { ok, model } | { ok:false, errors }
 * result. Every field is documented so the schema doubles as a spec.
 */

export const PropertySchema: z.ZodSchema<Property> = z.object({
  id: z.string().min(1, "property id must not be empty"),
  kind: z.enum(["number", "flag", "tag"]),
  description: z.string().optional(),
});

export const SubsystemSchema: z.ZodSchema<Subsystem> = z.object({
  id: z.string().min(1, "subsystem id must not be empty"),
  name: z.string().min(1, "subsystem name must not be empty"),
  role: z.string().optional(),
  tier: z.enum(["core", "support", "flavor"]),
});

export const PositionSchema: z.ZodSchema<Position> = z.object({
  x: z.number(),
  y: z.number(),
  pinned: z.boolean().optional(),
});

/** Simulation fields (docs/simulation-semantics.md, "New model fields"). */
const ActivationSchema = z.enum(["automatic", "interactive", "onStart", "passive"]);
const FlowModeSchema = z.enum(["any", "all"]);

export const PoolNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("pool"),
  name: z.string().min(1),
  subsystem: z.string().optional(),
  position: PositionSchema.optional(),
  capacity: z.number().optional(),
  start: z.number(),
  activation: ActivationSchema.optional(),
  act: z.enum(["pull", "push"]).optional(),
  flowMode: FlowModeSchema.optional(),
});

export const SourceNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("source"),
  name: z.string().min(1),
  subsystem: z.string().optional(),
  position: PositionSchema.optional(),
  rate: z.number(),
  activation: ActivationSchema.optional(),
  act: z.literal("push", { errorMap: () => ({ message: "a source always pushes" }) }).optional(),
  flowMode: z.literal("all", { errorMap: () => ({ message: "a source always moves its full rate" }) }).optional(),
});

export const DrainNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("drain"),
  name: z.string().min(1),
  subsystem: z.string().optional(),
  position: PositionSchema.optional(),
  rate: z.number(),
  activation: ActivationSchema.optional(),
  act: z.literal("pull", { errorMap: () => ({ message: "a drain can only pull" }) }).optional(),
  flowMode: FlowModeSchema.optional(),
});

export const ConverterNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("converter"),
  name: z.string().min(1),
  subsystem: z.string().optional(),
  position: PositionSchema.optional(),
  inputs: z.array(z.object({ resource: z.string().min(1), amount: z.number() })),
  outputs: z.array(z.object({ resource: z.string().min(1), amount: z.number() })),
  maxActivationsPerStep: z.number().int().optional(),
  activation: ActivationSchema.optional(),
  act: z.literal("pull", { errorMap: () => ({ message: "a converter always pulls" }) }).optional(),
  flowMode: z.literal("all", { errorMap: () => ({ message: "a converter always needs all its inputs" }) }).optional(),
});

export const GateNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("gate"),
  name: z.string().min(1),
  subsystem: z.string().optional(),
  position: PositionSchema.optional(),
  mode: z.enum(["random", "deterministic", "condition"]),
});

export const RegisterNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("register"),
  name: z.string().min(1),
  subsystem: z.string().optional(),
  position: PositionSchema.optional(),
  formula: z.string().min(1),
});

export const MechanicNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("mechanic"),
  name: z.string().min(1),
  subsystem: z.string().optional(),
  position: PositionSchema.optional(),
  reads: z.array(z.string().min(1)),
  writes: z.array(z.string().min(1)),
  drives: z.array(z.string().min(1)).optional(),
});

export const EntityNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("entity"),
  name: z.string().min(1),
  subsystem: z.string().optional(),
  position: PositionSchema.optional(),
  has: z.array(z.string().min(1)),
});

export const NodeSchema: z.ZodSchema<Node> = z.discriminatedUnion("kind", [
  PoolNodeSchema,
  SourceNodeSchema,
  DrainNodeSchema,
  ConverterNodeSchema,
  GateNodeSchema,
  RegisterNodeSchema,
  MechanicNodeSchema,
  EntityNodeSchema,
]);

export const EdgeSchema: z.ZodSchema<Edge> = z.object({
  id: z.string().min(1),
  kind: z.enum(["flow", "state", "interaction"]),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  polarity: z.enum(["+", "-"]).optional(),
  strength: z.enum(["modifier", "gate", "trigger"]).optional(),
  rate: z.string().optional(),
  multiplier: z.string().optional(),
  delay: z.number().int().min(0).optional(),
});

export const NoInteractionSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  reason: z.string().min(1),
});

export const InvariantSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  expr: z.string().optional(),
});

export const EndConditionSchema: z.ZodSchema<EndCondition> = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  expr: z.string().min(1),
});

export const ParameterSchema: z.ZodSchema<Parameter> = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  value: z.number(),
  min: z.number(),
  max: z.number(),
  integer: z.boolean().optional(),
});

export const ObjectiveSchema: z.ZodSchema<Objective> = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  expr: z.string().min(1),
  measure: z.enum(["final", "mean", "endStep"]),
  sense: z.enum(["max", "min"]),
});

export const StrategySchema: z.ZodSchema<Strategy> = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  intended: z.boolean().optional(),
  actionsPerStep: z.number().int().min(1).optional(),
  rules: z.array(z.object({ fire: z.string().min(1), when: z.string().min(1).optional() })),
});

export const ModelBaseSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  properties: z.array(PropertySchema),
  subsystems: z.array(SubsystemSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  noInteraction: z.array(NoInteractionSchema).default([]),
  invariants: z.array(InvariantSchema).default([]),
  endConditions: z.array(EndConditionSchema).optional(),
  parameters: z.array(ParameterSchema).optional(),
  objectives: z.array(ObjectiveSchema).optional(),
  strategies: z.array(StrategySchema).optional(),
});

export type ModelInput = z.infer<typeof ModelBaseSchema>;

export interface SchemaError {
  path: string;
  message: string;
  line?: number;
}

export type ValidateResult =
  | { ok: true; model: Model }
  | { ok: false; errors: SchemaError[] };

/** Report an id that repeats within one model list. */
function checkUnique(
  items: readonly { id: string }[],
  list: string,
  what: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: "custom", path: [list, i, "id"], message: `duplicate ${what} id "${item.id}"` });
    }
    seen.add(item.id);
  }
}

/**
 * Validate a formula field by parsing it and checking that every identifier it
 * references is an existing node or parameter id. Returns one error per parse failure (with
 * the formula offset) plus one per unknown reference, each carrying the model
 * path of the field so it surfaces under the right key.
 */
function validateFormula(
  formula: string,
  path: (string | number)[],
  nodeIds: ReadonlySet<string>,
): { path: (string | number)[]; message: string }[] {
  const parsed = parseFormula(formula);
  if (!parsed.ok) {
    return [
      {
        path: [...path],
        message: `invalid formula at offset ${parsed.error.offset}: ${parsed.error.message}`,
      },
    ];
  }
  const errors: { path: (string | number)[]; message: string }[] = [];
  for (const ref of references(parsed.ast)) {
    if (!nodeIds.has(ref)) {
      errors.push({ path: [...path], message: `formula references unknown node "${ref}"` });
    }
  }
  return errors;
}

/**
 * Validate untrusted input into a {@link Model}. Structural problems are
 * reported by zod with a dot-delimited path; cross-reference problems are
 * appended by `superRefine`.
 */
export const ModelSchema = ModelBaseSchema.superRefine((val, ctx) => {
  const ids = new Set<string>();
  val.nodes.forEach((node, i) => {
    if (ids.has(node.id)) {
      ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `duplicate node id "${node.id}"` });
    }
    ids.add(node.id);
  });
  for (const edge of val.edges) {
    if (!ids.has(edge.from)) {
      ctx.addIssue({
        code: "custom",
        path: ["edges", 0, "from"],
        message: `edge "${edge.id}" references unknown node "${edge.from}"`,
      });
    }
    if (!ids.has(edge.to)) {
      ctx.addIssue({
        code: "custom",
        path: ["edges", 0, "to"],
        message: `edge "${edge.id}" references unknown node "${edge.to}"`,
      });
    }
  }
  const propertyIds = new Set(val.properties.map((p) => p.id));
  for (const prop of val.properties) {
    if (!propertyIds.has(prop.id)) {
      ctx.addIssue({ code: "custom", path: ["properties", 0, "id"], message: `duplicate property id "${prop.id}"` });
    }
  }
  const subsystemIds = new Set(val.subsystems.map((s) => s.id));
  for (const s of val.subsystems) {
    if (!subsystemIds.has(s.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["subsystems", 0, "id"],
        message: `duplicate subsystem id "${s.id}"`,
      });
    }
  }
  for (const node of val.nodes) {
    if (node.subsystem && !subsystemIds.has(node.subsystem)) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes", 0, "subsystem"],
        message: `node "${node.id}" references unknown subsystem "${node.subsystem}"`,
      });
    }
  }
  const mechanicOrEntityIds = new Set(
    val.nodes.filter((n) => n.kind === "mechanic" || n.kind === "entity").map((n) => n.id),
  );
  for (const ni of val.noInteraction) {
    if (!mechanicOrEntityIds.has(ni.a) || !mechanicOrEntityIds.has(ni.b)) {
      ctx.addIssue({
        code: "custom",
        path: ["noInteraction", 0],
        message:
          `noInteraction references "${ni.a}" and "${ni.b}" which are not both mechanic/entity nodes`,
      });
    }
  }
  for (const [i, edge] of val.edges.entries()) {
    if (edge.delay !== undefined && edge.kind !== "flow") {
      ctx.addIssue({
        code: "custom",
        path: ["edges", i, "delay"],
        message: `edge "${edge.id}" has a delay but only flow edges can be delayed`,
      });
    }
  }
  const endConditionIds = new Set<string>();
  for (const [i, end] of (val.endConditions ?? []).entries()) {
    if (endConditionIds.has(end.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["endConditions", i, "id"],
        message: `duplicate end condition id "${end.id}"`,
      });
    }
    endConditionIds.add(end.id);
  }
  // Formulas may read nodes and parameters alike.
  const nodeIds = new Set(ids);
  for (const parameter of val.parameters ?? []) ids.add(parameter.id);
  const formulaErrors: { path: (string | number)[]; message: string }[] = [];
  for (const [i, edge] of val.edges.entries()) {
    if (edge.rate) formulaErrors.push(...validateFormula(edge.rate, ["edges", i, "rate"], ids));
    if (edge.multiplier) {
      formulaErrors.push(...validateFormula(edge.multiplier, ["edges", i, "multiplier"], ids));
    }
  }
  for (const [i, node] of val.nodes.entries()) {
    if (node.kind === "register" && node.formula) {
      formulaErrors.push(...validateFormula(node.formula, ["nodes", i, "formula"], ids));
    }
  }
  for (const [i, invariant] of val.invariants.entries()) {
    if (invariant.expr) {
      formulaErrors.push(...validateFormula(invariant.expr, ["invariants", i, "expr"], ids));
    }
  }
  for (const [i, end] of (val.endConditions ?? []).entries()) {
    formulaErrors.push(...validateFormula(end.expr, ["endConditions", i, "expr"], ids));
  }
  checkUnique(val.parameters ?? [], "parameters", "parameter", ctx);
  checkUnique(val.objectives ?? [], "objectives", "objective", ctx);
  checkUnique(val.strategies ?? [], "strategies", "strategy", ctx);
  for (const [i, parameter] of (val.parameters ?? []).entries()) {
    if (nodeIds.has(parameter.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["parameters", i, "id"],
        message: `parameter id "${parameter.id}" is also a node id`,
      });
    }
    if (!(parameter.min <= parameter.value && parameter.value <= parameter.max)) {
      ctx.addIssue({
        code: "custom",
        path: ["parameters", i, "value"],
        message: `parameter "${parameter.id}" value ${parameter.value} is outside [${parameter.min}, ${parameter.max}]`,
      });
    }
  }
  for (const [i, objective] of (val.objectives ?? []).entries()) {
    // An endStep objective scores the end step, so its expr is never read.
    if (objective.measure !== "endStep") {
      formulaErrors.push(...validateFormula(objective.expr, ["objectives", i, "expr"], ids));
    }
  }
  const interactive = new Set(
    val.nodes.filter((n) => "activation" in n && n.activation === "interactive").map((n) => n.id),
  );
  for (const [i, strategy] of (val.strategies ?? []).entries()) {
    for (const [j, rule] of strategy.rules.entries()) {
      if (!interactive.has(rule.fire)) {
        ctx.addIssue({
          code: "custom",
          path: ["strategies", i, "rules", j, "fire"],
          message: `strategy "${strategy.id}" fires "${rule.fire}", which is not an interactive node`,
        });
      }
      if (rule.when) {
        formulaErrors.push(...validateFormula(rule.when, ["strategies", i, "rules", j, "when"], ids));
      }
    }
  }
  for (const err of formulaErrors) {
    ctx.addIssue({ code: "custom", path: err.path, message: err.message });
  }
});

export function validateModel(input: unknown): ValidateResult {
  const result = ModelSchema.safeParse(input);
  if (result.success) {
    return { ok: true, model: result.data as Model };
  }
  const errors: SchemaError[] = result.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  return { ok: false, errors };
}
