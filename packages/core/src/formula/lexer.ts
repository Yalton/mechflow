/**
 * Lexer for the mechflow formula language.
 *
 * Turns a formula string into a flat token stream. Dice expressions (NdM, e.g.
 * 2d6) are recognised here as a single token so the parser can turn them into a
 * `dice` call that draws from the injected RNG.
 */

export interface Token {
  type: "number" | "self" | "ident" | "op" | "lparen" | "rparen" | "comma" | "dice" | "eof";
  value?: number;
  name?: string;
  op?: string;
  operands?: [number, number];
  offset: number;
}

const OPERATORS = "+-*/%^,";

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      while (i < n && isDigit(input[i]!)) i++;
      if (input[i] === "." && i + 1 < n && isDigit(input[i + 1]!)) {
        i++;
        while (i < n && isDigit(input[i]!)) i++;
      }
      // NdM dice: a digit immediately followed by 'd' and another digit.
      const ch = input[i];
      if (ch === "d" || ch === "D") {
        const next = i + 1;
        if (next < n && isDigit(input[next]!)) {
          let j = next + 1;
          while (j < n && isDigit(input[j]!)) j++;
          const sides = parseInt(input.slice(next, j), 10);
          const count = parseFloat(input.slice(start, i));
          tokens.push({ type: "dice", operands: [count, sides], offset: start });
          i = j;
          continue;
        }
      }
      tokens.push({ type: "number", value: parseFloat(input.slice(start, i)), offset: start });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(input[i]!)) i++;
      const name = input.slice(start, i);
      if (name === "self") {
        tokens.push({ type: "self", offset: start });
      } else {
        tokens.push({ type: "ident", name, offset: start });
      }
      continue;
    }
    if (c === "<") {
      if (input[i + 1] === "=") {
        tokens.push({ type: "op", op: "<=", offset: i });
        i += 2;
      } else {
        tokens.push({ type: "op", op: "<", offset: i });
        i++;
      }
      continue;
    }
    if (c === ">") {
      if (input[i + 1] === "=") {
        tokens.push({ type: "op", op: ">=", offset: i });
        i += 2;
      } else {
        tokens.push({ type: "op", op: ">", offset: i });
        i++;
      }
      continue;
    }
    if (c === "=" && input[i + 1] === "=") {
      tokens.push({ type: "op", op: "==", offset: i });
      i += 2;
      continue;
    }
    if (c === "!" && input[i + 1] === "=") {
      tokens.push({ type: "op", op: "!=", offset: i });
      i += 2;
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "comma", offset: i });
      i++;
      continue;
    }
    if (OPERATORS.includes(c)) {
      tokens.push({ type: "op", op: c, offset: i });
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen", offset: i });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", offset: i });
      i++;
      continue;
    }
    throw new Error(`unexpected character '${c}' at offset ${i}`);
  }
  tokens.push({ type: "eof", offset: n });
  return tokens;
}

export function tokenLabel(t: Token): string {
  switch (t.type) {
    case "number":
      return String(t.value);
    case "self":
      return "self";
    case "ident":
      return t.name ?? "<ident>";
    case "op":
      return t.op ?? "<op>";
    case "lparen":
      return "(";
    case "rparen":
      return ")";
    case "comma":
      return ",";
    case "dice":
      return `${t.operands?.[0] ?? 0}d${t.operands?.[1] ?? 0}`;
    case "eof":
      return "end of input";
  }
}
