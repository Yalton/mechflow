import type { Edge, Model } from "../model/types.js";
import { parseFormula } from "../formula/parser.js";
import { isConstant, evaluate } from "../formula/evaluate.js";
import type { Check, Finding } from "./types.js";

interface MultiplierChain {
  edges: Edge[];
  formulas: string[];
}

/**
 * Find maximal chains of multiplier edges that feed one another: a directed
 * path of at least two consecutive edges, each carrying a `multiplier` formula.
 * The search starts from multiplier edges with no incoming multiplier edge and
 * follows outgoing multiplier edges, so it enumerates maximal chains without
 * looping on cycles.
 */
export function findMultiplierChains(model: Model, maxChains = 100): MultiplierChain[] {
  const multi = model.edges.filter((e) => e.multiplier !== undefined);
  if (multi.length < 2) return [];
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Set<string>();
  for (const e of multi) {
    (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from)!).push(e);
    incoming.add(e.to);
  }
  const sources = multi.filter((e) => !incoming.has(e.from));
  const chains: MultiplierChain[] = [];
  const seen = new Set<string>();

  const dfs = (path: Edge[]): void => {
    if (chains.length >= maxChains) return;
    const last = path[path.length - 1]!;
    const next = (outgoing.get(last.to) ?? []).filter((e) => !path.includes(e));
    if (next.length === 0) {
      if (path.length >= 2) {
        const key = path.map((e) => e.id).join("\u0000");
        if (!seen.has(key)) {
          seen.add(key);
          chains.push({ edges: path.slice(), formulas: path.map((e) => e.multiplier!) });
        }
      }
      return;
    }
    for (const e of next) {
      dfs([...path, e]);
    }
  };
  for (const source of sources) {
    dfs([source]);
    if (chains.length >= maxChains) break;
  }
  return chains;
}

/**
 * Evaluate a constant multiplier formula to its numeric value. Returns null when
 * the formula is not constant (references a node or RNG), which callers treat as
 * an unbounded-unknown multiplier.
 */
export function evaluateConstantMultiplier(formula: string): number | null {
  const parsed = parseFormula(formula);
  if (!parsed.ok || !isConstant(parsed.ast)) return null;
  return evaluate(parsed.ast, { lookup: () => 0, rng: () => 0 });
}

export const multipliersCheck: Check = {
  id: "multipliers",
  name: "Stacked multipliers",
  run(model) {
    const chains = findMultiplierChains(model);
    const findings: Finding[] = [];
    for (const chain of chains) {
      const chainIds = chain.edges.map((e) => e.id);
      const id = `multipliers:${chainIds.join(",")}`;
      const values: number[] = [];
      let allConstant = true;
      for (const formula of chain.formulas) {
        const parsed = parseFormula(formula);
        if (!parsed.ok || !isConstant(parsed.ast)) {
          allConstant = false;
          break;
        }
        values.push(evaluate(parsed.ast, { lookup: () => 0, rng: () => 0 }));
      }
      if (allConstant) {
        const product = values.reduce((a, b) => a * b, 1);
        if (product > 3) {
          findings.push({
            id,
            check: "multipliers",
            severity: "warning",
            title: `Multiplier chain ${chainIds.join(" -> ")} compounds to ${product.toFixed(3)}`,
            detail:
              `The product of the constant multipliers ${chain.formulas.join(" × ")} is ${product.toFixed(3)}, ` +
              `which amplifies flow beyond 3x.`,
            nodes: chain.edges.map((e) => e.from),
            edges: chainIds,
            data: { chain: chainIds, product },
          });
        }
      } else {
        findings.push({
          id,
          check: "multipliers",
          severity: "warning",
          title: `Unbounded multiplier chain ${chainIds.join(" -> ")}`,
          detail: `The chain ${chain.formulas.join(" × ")} is not constant, so its compounded effect is unbounded.`,
          nodes: chain.edges.map((e) => e.from),
          edges: chainIds,
          data: { chain: chainIds, product: undefined },
        });
      }
    }
    return findings;
  },
};
