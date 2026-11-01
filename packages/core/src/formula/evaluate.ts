/**
 * Evaluator for parsed mechflow formulas.
 *
 * `evaluate` never calls eval/Function. It resolves identifiers through the
 * supplied lookup callback and draws randomness through the supplied rng()
 * callback, so it is fully deterministic and testable given fixed inputs.
 */

import { isFunction, type Expr } from "./parser.js";

export interface EvalContext {
  /** Resolve a node id (or the literal 'self') to its current amount. */
  lookup(id: string): number;
  /** Return a float in [0, 1) used by dice expressions. */
  rng(): number;
}

const PURE_FUNCTIONS = new Set(["min", "max", "floor", "ceil", "round", "abs", "clamp"]);

export function evaluate(expr: Expr, ctx: EvalContext): number {
  switch (expr.kind) {
    case "number":
      return expr.value;
    case "self":
      return ctx.lookup("self");
    case "ref":
      return ctx.lookup(expr.id);
    case "unary": {
      const v = evaluate(expr.expr, ctx);
      return expr.op === "-" ? -v : v;
    }
    case "binary": {
      const l = evaluate(expr.left, ctx);
      const r = evaluate(expr.right, ctx);
      switch (expr.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return l / r;
        case "%":
          return l % r;
        case "^":
          return Math.pow(l, r);
      }
      break;
    }
    case "cmp": {
      const l = evaluate(expr.left, ctx);
      const r = evaluate(expr.right, ctx);
      switch (expr.op) {
        case "<":
          return l < r ? 1 : 0;
        case "<=":
          return l <= r ? 1 : 0;
        case ">":
          return l > r ? 1 : 0;
        case ">=":
          return l >= r ? 1 : 0;
        case "==":
          return l === r ? 1 : 0;
        case "!=":
          return l !== r ? 1 : 0;
      }
      break;
    }
    case "call":
      return evaluateCall(expr, ctx);
  }
}

function evaluateCall(expr: { name: string; args: Expr[] }, ctx: EvalContext): number {
  const args = expr.args.map((a) => evaluate(a, ctx));
  switch (expr.name) {
    case "min":
      return Math.min(...args);
    case "max":
      return Math.max(...args);
    case "floor":
      return Math.floor(args[0]!);
    case "ceil":
      return Math.ceil(args[0]!);
    case "round":
      return Math.round(args[0]!);
    case "abs":
      return Math.abs(args[0]!);
    case "clamp": {
      const x = args[0]!;
      const lo = args[1]!;
      const hi = args[2]!;
      return Math.min(Math.max(x, lo), hi);
    }
    case "dice": {
      const count = Math.floor(args[0]!);
      const sides = Math.floor(args[1]!);
      if (sides < 1) throw new Error(`dice requires at least ${1} side, got ${sides}`);
      let sum = 0;
      for (let i = 0; i < count; i++) {
        sum += 1 + Math.floor(ctx.rng() * sides);
      }
      return sum;
    }
    default:
      throw new Error(`unknown function '${expr.name}'`);
  }
}

/**
 * An expression is constant when it does not depend on any node value or the
 * RNG, i.e. it would evaluate to the same number in every state.
 */
export function isConstant(expr: Expr): boolean {
  switch (expr.kind) {
    case "number":
      return true;
    case "self":
    case "ref":
      return false;
    case "unary":
      return isConstant(expr.expr);
    case "binary":
      return isConstant(expr.left) && isConstant(expr.right);
    case "cmp":
      return isConstant(expr.left) && isConstant(expr.right);
    case "call":
      if (!PURE_FUNCTIONS.has(expr.name)) return false;
      return expr.args.every(isConstant);
  }
}

/**
 * Collect the node ids referenced by an expression, in first-seen order.
 * 'self' and function names are not references.
 */
export function references(expr: Expr): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (e: Expr): void => {
    switch (e.kind) {
      case "ref":
        if (!seen.has(e.id)) {
          seen.add(e.id);
          out.push(e.id);
        }
        break;
      case "unary":
        visit(e.expr);
        break;
      case "binary":
        visit(e.left);
        visit(e.right);
        break;
      case "cmp":
        visit(e.left);
        visit(e.right);
        break;
      case "call":
        e.args.forEach(visit);
        break;
      case "number":
      case "self":
        break;
    }
  };
  visit(expr);
  return out;
}

export { isFunction };
