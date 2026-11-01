import { describe, expect, it } from "vitest";
import { parseFormula, isFunction } from "../../src/formula/index.js";

describe("parseFormula", () => {
  it("parses a plain number", () => {
    const r = parseFormula("42");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toEqual({ kind: "number", value: 42 });
  });

  it("respects operator precedence: 2*3+1 multiplies before adding", () => {
    const r = parseFormula("2*3+1");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.ast).toEqual({
      kind: "binary",
      op: "+",
      left: { kind: "binary", op: "*", left: { kind: "number", value: 2 }, right: { kind: "number", value: 3 } },
      right: { kind: "number", value: 1 },
    });
  });

  it("is right-associative for power: 2^3^2 == 2^(3^2)", () => {
    const r = parseFormula("2^3^2");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.ast).toEqual({
      kind: "binary",
      op: "^",
      left: { kind: "number", value: 2 },
      right: { kind: "binary", op: "^", left: { kind: "number", value: 3 }, right: { kind: "number", value: 2 } },
    });
  });

  it("parses references, self, and function calls", () => {
    const r = parseFormula("self + gold * max(a, b)");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.ast.kind).toBe("binary"); // top-level '+'
  });

  it("parses comparisons into a cmp node (evaluated to 1/0 later)", () => {
    const r = parseFormula("a < b");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.ast.kind).toBe("cmp");
  });

  it("reports a parse error with a positive offset for unbalanced parens", () => {
    const r = parseFormula("((( ");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(typeof r.error.message).toBe("string");
    expect(r.error.offset).toBeGreaterThan(0);
  });

  it("treats 'constructor' and '__proto__' as ordinary identifiers", () => {
    expect(() => parseFormula("constructor")).not.toThrow();
    expect(parseFormula("__proto__").ok).toBe(true);
  });
});

describe("isFunction", () => {
  it("recognises the built-in pure functions and rejects unknown ones", () => {
    for (const name of ["min", "max", "floor", "ceil", "round", "abs", "clamp", "dice"]) {
      expect(isFunction(name)).toBe(true);
    }
    expect(isFunction("frobnicate")).toBe(false);
  });
});
