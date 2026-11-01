/**
 * Dominant-combination search (docs/search-design.md, "Dominant combinations
 * (search-dominant)"): score focus strategies for sets of interactive nodes
 * and flag a set that is far stronger together than its members alone.
 */

import type { Finding } from "../analysis/types.js";
import type { Model, Objective, Strategy } from "../model/types.js";
import { createRng } from "../sim/rng.js";
import type { SimError } from "../sim/types.js";
import { Budget } from "./budget.js";
import { evaluateCandidate, oriented, resolveObjective } from "./evaluate.js";
import { DEFAULT_MAX_EVALUATIONS, type SearchOptions, type SearchResult } from "./types.js";

export interface DominantOptions extends SearchOptions {
  /** Largest set size; default 3. */
  k?: number;
  /** Flag a set whose synergy is at least this; default 1.5. */
  minSynergy?: number;
  /** ...and that beats the best single node by this fraction; default 0.2. */
  minMargin?: number;
  /** Search only these interactive nodes; default all of them. */
  nodes?: string[];
}

export const DOMINANT_DEFAULTS = { k: 3, minSynergy: 1.5, minMargin: 0.2 } as const;

/** Sampled searches improve this many of the best sets by local search. */
const LOCAL_SEARCH_STARTS = 3;

export interface RankedSet {
  /** The interactive nodes the focus strategy fires, in id order. */
  nodes: string[];
  score: number;
  p5: number;
  p50: number;
  p95: number;
  /** Oriented score minus the baseline's: positive is better. */
  gain: number;
  /**
   * Gain over the sum of the members' gains alone; null for single nodes or
   * when the members' gains sum to zero or less.
   */
  synergy: number | null;
}

export interface DominantReport {
  objective: Objective;
  /** "exhaustive" when every set up to size k was tried. */
  mode: "exhaustive" | "sampled";
  baseline: { score: number; p5: number; p50: number; p95: number };
  /** Best first. */
  ranked: RankedSet[];
}

export type DominantResult =
  { ok: true; result: SearchResult<DominantReport> } | { ok: false; errors: SimError[] };

/**
 * The focus strategy for `nodes`: fire each of them, in id order, every step
 * it can.
 */
export function focusStrategy(nodes: readonly string[]): Strategy {
  const sorted = [...nodes].sort();
  return {
    id: `focus:${sorted.join("+")}`,
    description: `Fire ${sorted.join(", ")} every step they can.`,
    actionsPerStep: Math.max(1, sorted.length),
    rules: sorted.map((fire) => ({ fire })),
  };
}

function interactiveIds(model: Model): string[] {
  return model.nodes
    .filter((n) => "activation" in n && n.activation === "interactive")
    .map((n) => n.id)
    .sort();
}

/** Every set of `ids` with 1 to `k` members, smaller sets first. */
function* subsets(ids: readonly string[], k: number): Generator<string[]> {
  for (let size = 1; size <= k; size++) {
    const pick = (start: number, chosen: string[]): string[][] =>
      chosen.length === size
        ? [chosen]
        : ids.slice(start).flatMap((id, i) => pick(start + i + 1, [...chosen, id]));
    yield* pick(0, []);
  }
}

function countSubsets(n: number, k: number): number {
  let total = 0;
  let choose = 1;
  for (let size = 1; size <= k; size++) {
    choose = (choose * (n - size + 1)) / size;
    total += choose;
  }
  return Math.round(total);
}

export function dominantCombinations(model: Model, options: DominantOptions): DominantResult {
  const resolved = resolveObjective(model, options.objective);
  if (!resolved.ok) return resolved;
  const objective = resolved.resolved.objective;
  const { minSynergy, minMargin } = { ...DOMINANT_DEFAULTS, ...options };
  const all = interactiveIds(model);
  const unknown = (options.nodes ?? []).filter((id) => !all.includes(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: unknown.map((id) => ({
        path: "options.nodes",
        message: `"${id}" is not an interactive node`,
      })),
    };
  }
  const ids = options.nodes ? [...new Set(options.nodes)].sort() : all;
  const k = Math.min(options.k ?? DOMINANT_DEFAULTS.k, ids.length);
  const budget = new Budget(options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS);

  const scored = new Map<string, Omit<RankedSet, "gain" | "synergy">>();
  let failure: SimError[] | null = null;
  /** Score a set (or the baseline, for []); false if the budget is spent. */
  const score = (nodes: string[]): boolean => {
    const key = [...nodes].sort().join("+");
    if (scored.has(key)) return true;
    if (failure || !budget.take()) return false;
    const result = evaluateCandidate(
      model,
      nodes.length > 0 ? { strategy: focusStrategy(nodes) } : {},
      options,
    );
    if (!result.ok) {
      failure = result.errors;
      return false;
    }
    const { score: s, p5, p50, p95 } = result.evaluation;
    scored.set(key, { nodes: [...nodes].sort(), score: s, p5, p50, p95 });
    return true;
  };

  score([]);
  const exhaustive = 1 + countSubsets(ids.length, k) <= budget.max;
  if (exhaustive) {
    for (const set of subsets(ids, k)) score(set);
  } else {
    // Singles first: synergy needs every member's gain alone.
    for (const id of ids) score([id]);
    // Then random sets of 2..k members, until half the remaining budget...
    const rng = createRng(options.seed);
    const sampleUntil = budget.used + Math.floor(budget.remaining / 2);
    let attempts = 0;
    while (budget.used < sampleUntil && attempts < 50 * budget.max && !failure) {
      attempts++;
      const size = 2 + rng.int(Math.max(1, k - 1));
      if (size > k) continue;
      score(rng.shuffle(ids).slice(0, size));
    }
    // ...then improve the best few by swapping one member in or out.
    const starts = [...scored.values()]
      .filter((s) => s.nodes.length > 0)
      .sort((a, b) => oriented(b.score, objective) - oriented(a.score, objective))
      .slice(0, LOCAL_SEARCH_STARTS);
    for (const start of starts) {
      let current = start;
      let improved = true;
      while (improved && budget.remaining > 0 && !failure) {
        improved = false;
        for (const neighbour of neighbours(current.nodes, ids, k)) {
          if (!score(neighbour)) break;
          const candidate = scored.get([...neighbour].sort().join("+"))!;
          if (oriented(candidate.score, objective) > oriented(current.score, objective)) {
            current = candidate;
            improved = true;
            break;
          }
        }
      }
    }
  }
  if (failure) return { ok: false, errors: failure };

  const baseline = scored.get("")!;
  const gainOf = (s: { score: number }): number =>
    oriented(s.score, objective) - oriented(baseline.score, objective);
  const ranked: RankedSet[] = [...scored.values()]
    .filter((s) => s.nodes.length > 0)
    .map((s) => {
      const gain = gainOf(s);
      let synergy: number | null = null;
      if (s.nodes.length > 1) {
        const singles = s.nodes.map((id) => scored.get(id));
        const sum = singles.every(Boolean)
          ? singles.reduce((t, single) => t + gainOf(single!), 0)
          : 0;
        if (sum > 0) synergy = gain / sum;
      }
      return { ...s, gain, synergy };
    })
    .sort(
      (a, b) =>
        oriented(b.score, objective) - oriented(a.score, objective) ||
        a.nodes.length - b.nodes.length ||
        (a.nodes.join() < b.nodes.join() ? -1 : 1),
    );

  const findings: Finding[] = [];
  const best = ranked[0];
  const bestSingle = ranked.find((r) => r.nodes.length === 1);
  if (
    best &&
    bestSingle &&
    best.nodes.length > 1 &&
    best.synergy !== null &&
    best.synergy >= minSynergy
  ) {
    const lead = oriented(best.score, objective) - oriented(bestSingle.score, objective);
    const needed = minMargin * Math.abs(bestSingle.score);
    if (lead > 0 && lead >= needed) {
      findings.push({
        id: `search-dominant:${best.nodes.join("+")}`,
        check: "search-dominant",
        severity: "warning",
        title: `${best.nodes.join(" + ")} dominate together`,
        detail:
          `Firing ${best.nodes.join(", ")} together scores ${round(best.score)} on ${objective.id}, ` +
          `${round(best.synergy)}× the sum of their gains alone and ahead of the best single choice ` +
          `(${bestSingle.nodes[0]}, ${round(bestSingle.score)}). Replay it with the strategy in data.`,
        nodes: best.nodes,
        edges: [],
        data: {
          objective: objective.id,
          score: best.score,
          synergy: best.synergy,
          bestSingle: { node: bestSingle.nodes[0], score: bestSingle.score },
          baseline: baseline.score,
          strategy: focusStrategy(best.nodes),
          seed: options.seed,
        },
      });
    }
  }

  const { score: bs, p5, p50, p95 } = baseline;
  return {
    ok: true,
    result: {
      findings,
      report: {
        objective,
        mode: exhaustive ? "exhaustive" : "sampled",
        baseline: { score: bs, p5, p50, p95 },
        ranked,
      },
      evaluationsUsed: budget.used,
    },
  };
}

/** Sets one swap away from `nodes`: one member added, removed or replaced. */
function neighbours(nodes: string[], ids: string[], k: number): string[][] {
  const out: string[][] = [];
  const outside = ids.filter((id) => !nodes.includes(id));
  if (nodes.length < k) for (const id of outside) out.push([...nodes, id]);
  if (nodes.length > 1) for (const id of nodes) out.push(nodes.filter((n) => n !== id));
  for (const id of nodes) {
    for (const other of outside) out.push([...nodes.filter((n) => n !== id), other]);
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
