/**
 * Hand-written recursive-descent parser for the mechflow formula language.
 *
 * Precedence (low -> high): comparison, additive (+ -), multiplicative
 * (* / %), power (^, right associative), unary (- +), primary. No eval, no
 * Function, no parser generator. Identifiers are opaque node references;
 * names like 'constructor' or '__proto__' are simply unknown identifiers.
 */

import { tokenLabel, tokenize, type Token } from "./lexer.js";

export type UnaryOp = "-" | "+";
export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "^";
export type CmpOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

export type Expr =
  | { kind: "number"; value: number }
  | { kind: "self" }
  | { kind: "ref"; id: string }
  | { kind: "unary"; op: UnaryOp; expr: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "cmp"; op: CmpOp; left: Expr; right: Expr }
  | { kind: "call"; name: string; args: Expr[] };

export interface ParseError {
  message: string;
  offset: number;
}

export type ParseResult = { ok: true; ast: Expr } | { ok: false; error: ParseError };

const FUNCTIONS = new Set([
  "min",
  "max",
  "floor",
  "ceil",
  "round",
  "abs",
  "clamp",
  "dice",
]);

export function isFunction(name: string): boolean {
  return FUNCTIONS.has(name);
}

class Parser {
  private pos = 0;
  private ok = true;
  private err: ParseError = { message: "", offset: 0 };

  constructor(private tokens: Token[]) {}

  /** Whether parsing completed without hitting a failure. */
  isOk(): boolean {
    return this.ok;
  }

  /** The first parse error encountered, if any. */
  getError(): ParseError {
    return this.err;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  /** Public view of the current token for post-parse trailing-token checks. */
  peekToken(): Token {
    return this.peek();
  }

  private next(): Token {
    const t = this.tokens[this.pos]!;
    this.pos++;
    return t;
  }

  private fail(message: string, offset: number): void {
    if (this.ok) {
      this.ok = false;
      this.err = { message, offset };
    }
  }

  parseExpression(): Expr {
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    if (!this.ok) return left;
    const t = this.peek();
    if (t.type === "op" && isCmpOp(t.op)) {
      this.next();
      const right = this.parseAdditive();
      return { kind: "cmp", op: t.op as CmpOp, left, right };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.ok) {
      const t = this.peek();
      if (t.type === "op" && (t.op === "+" || t.op === "-")) {
        this.next();
        const right = this.parseMultiplicative();
        left = { kind: "binary", op: t.op as BinaryOp, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parsePower();
    while (this.ok) {
      const t = this.peek();
      if (t.type === "op" && (t.op === "*" || t.op === "/" || t.op === "%")) {
        this.next();
        const right = this.parsePower();
        left = { kind: "binary", op: t.op as BinaryOp, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parsePower(): Expr {
    const base = this.parseUnary();
    if (!this.ok) return base;
    const t = this.peek();
    if (t.type === "op" && t.op === "^") {
      this.next();
      const exp = this.parsePower();
      return { kind: "binary", op: "^", left: base, right: exp };
    }
    return base;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === "op" && (t.op === "-" || t.op === "+")) {
      this.next();
      const expr = this.parseUnary();
      return { kind: "unary", op: t.op as UnaryOp, expr };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "number") {
      this.next();
      return { kind: "number", value: t.value! };
    }
    if (t.type === "self") {
      this.next();
      return { kind: "self" };
    }
    if (t.type === "lparen") {
      this.next();
      const e = this.parseExpression();
      const close = this.peek();
      if (close.type !== "rparen") {
        this.fail(`expected ')' at offset ${close.offset}`, close.offset);
        return { kind: "number", value: 0 };
      }
      this.next();
      return e;
    }
    if (t.type === "dice") {
      this.next();
      const [count, sides] = t.operands!;
      return { kind: "call", name: "dice", args: [{ kind: "number", value: count }, { kind: "number", value: sides }] };
    }
    if (t.type === "ident") {
      this.next();
      if (this.peek().type === "lparen") {
        return this.parseCall(t.name!);
      }
      return { kind: "ref", id: t.name! };
    }
    this.fail(`unexpected ${tokenLabel(t)}` , t.offset);
    return { kind: "number", value: 0 };
  }

  private parseCall(name: string): Expr {
    this.next(); // consume '('
    const args: Expr[] = [];
    if (this.peek().type !== "rparen") {
      args.push(this.parseExpression());
      while (this.peek().type === "comma") {
        this.next();
        args.push(this.parseExpression());
      }
    }
    const close = this.peek();
    if (close.type !== "rparen") {
      this.fail(`expected ')' for call to '${name}' at offset ${close.offset}`, close.offset);
      return { kind: "number", value: 0 };
    }
    this.next();
    return { kind: "call", name, args };
  }
}

function isCmpOp(op: string | undefined): boolean {
  return (
    op === "<" ||
    op === "<=" ||
    op === ">" ||
    op === ">=" ||
    op === "==" ||
    op === "!="
  );
}

export function parseFormula(text: string): ParseResult {
  let tokenList: Token[];
  try {
    tokenList = tokenize(text);
  } catch (err) {
    const e = err as { offset?: number };
    return { ok: false, error: { message: (err as Error).message, offset: e.offset ?? text.length } };
  }
  const parser = new Parser(tokenList);
  const ast = parser.parseExpression();
  if (!parser.isOk()) {
    return { ok: false, error: parser.getError() };
  }
  const last = parser.peekToken();
  if (last.type !== "eof") {
    return {
      ok: false,
      error: { message: `unexpected ${tokenLabel(last)}`, offset: last.offset },
    };
  }
  return { ok: true, ast };
}
