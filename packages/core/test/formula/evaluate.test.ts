import { describe, expect, it } from "vitest";
import { parseFormula, type Expr } from "../../src/formula/parser.js";
import { evaluate, isConstant, references } from "../../src/formula/evaluate.js";
import type { EvalContext } from "../../src/formula/evaluate.js";

/** Parse a formula string and return its AST, throwing a helpful error on failure. */
function ast(text: string): Expr {
  const r = parseFormula(text);
  if (!r.ok) throw new Error(`parse failed for ${text}: ${r.error.message}`);
  return r.ast;
}

/** A deterministic EvalContext over a fixed set of node values. */
function ctx(values: Record<string, number>, rng = () => 0) {
  const lookup = (id: string): number => {
    const v = values[id];
    if (v === undefined) throw new Error(`no value for ${id}`);
    return v;
  };
  const evalCtx: EvalContext = { lookup, rng };
  return evalCtx;
}

describe("evaluate", () => {
  it("evaluates literal numbers", () => {
    expect(evaluate(ast("3.5"), ctx({}))).toBe(3.5);
    expect(evaluate(ast("-4"), ctx({}))).toBe(-4);
  });

  it("resolves 'self' through the lookup callback", () => {
    expect(evaluate(ast("self"), ctx({ self: 10 }))).toBe(10);
  });

  it("resolves node references through lookup", () => {
    expect(evaluate(ast("gold + water"), ctx({ gold: 3, water: 4 }))).toBe(7);
  });

  it("evaluates the arithmetic operators", () => {
    expect(evaluate(ast("2 + 3 * 4"), ctx({}))).toBe(14);
    expect(evaluate(ast("(2 + 3) * 4"), ctx({}))).toBe(20);
    expect(evaluate(ast("10 - 2 - 3"), ctx({}))).toBe(5); // left-associative
    expect(evaluate(ast("7 % 3"), ctx({}))).toBe(1);
    expect(evaluate(ast("2 ^ 3 ^ 2"), ctx({}))).toBe(512); // right-associative: 2^(3^2)
  });

  it("evaluates comparisons to 1/0", () => {
    expect(evaluate(ast("a < b"), ctx({ a: 1, b: 2 }))).toBe(1);
    expect(evaluate(ast("a < b"), ctx({ a: 2, b: 2 }))).toBe(0);
    expect(evaluate(ast("a == b"), ctx({ a: 5, b: 5 }))).toBe(1);
    expect(evaluate(ast("a != b"), ctx({ a: 5, b: 5 }))).toBe(0);
  });

  it("evaluates the pure functions", () => {
    expect(evaluate(ast("min(a, b)"), ctx({ a: 3, b: 7 }))).toBe(3);
    expect(evaluate(ast("max(a, b)"), ctx({ a: 3, b: 7 }))).toBe(7);
    expect(evaluate(ast("floor(3.9)"), ctx({}))).toBe(3);
    expect(evaluate(ast("ceil(3.1)"), ctx({}))).toBe(4);
    expect(evaluate(ast("round(2.5)"), ctx({}))).toBe(3);
    expect(evaluate(ast("abs(x)"), ctx({ x: -9 }))).toBe(9);
    expect(evaluate(ast("clamp(x, 0, 10)"), ctx({ x: 42 }))).toBe(10);
    expect(evaluate(ast("clamp(x, 0, 10)"), ctx({ x: -3 }))).toBe(0);
  });

  it("evaluates dice through the rng callback", () => {
    // rng() returns 0 -> every die rolls its minimum face (1).
    expect(evaluate(ast("2d6"), ctx({}, () => 0))).toBe(2);
    // rng() returns just under 1 -> every die rolls its maximum face (sides).
    expect(evaluate(ast("3d6"), ctx({}, () => 0.999999))).toBe(18);
  });
});

describe("isConstant", () => {
  it("is true for expressions with no references or rng", () => {
    expect(isConstant(ast("42"))).toBe(true);
    expect(isConstant(ast("2 * (3 + 4)"))).toBe(true);
    expect(isConstant(ast("floor(3.7)"))).toBe(true);
  });

  it("is false when a node reference or self is present", () => {
    expect(isConstant(ast("gold"))).toBe(false);
    expect(isConstant(ast("self + 1"))).toBe(false);
    expect(isConstant(ast("max(a, b)"))).toBe(false);
  });
});

describe("references", () => {
  it("collects node ids in first-seen order, deduping", () => {
    expect(references(ast("a + b * a"))).toEqual(["a", "b"]);
  });

  it("excludes self and function names", () => {
    expect(references(ast("self + max(a, b)"))).toEqual(["a", "b"]);
    expect(references(ast("42"))).toEqual([]);
  });
});
