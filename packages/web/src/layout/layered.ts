import type { Model, Node } from "@mechflow/core";

/**
 * Left-to-right layered placement for the economy, as Machinations diagrams
 * read: resources enter on the left (sources) and leave on the right (drains).
 *
 * 1. Rank: break cycles by dropping the edges a depth-first search finds
 *    pointing back up its path (searching from nodes with no incoming edge
 *    first, in id order), then give each node its longest-path rank, so every
 *    remaining edge points right. A node fed by nothing then moves right, to
 *    the column before its nearest target.
 * 2. Order: a few barycenter sweeps put each node level with the nodes it is
 *    joined to, which keeps crossings down.
 * 3. Place: rank r is column r, `columnGap` apart; each column is centred on y = 0.
 *
 * Only economy nodes are placed, joined by the flow and state edges between
 * them and by each converter's inputs and outputs. Deterministic: every tie goes by id.
 */

export const ECONOMY_KINDS: ReadonlySet<Node["kind"]> = new Set([
  "pool",
  "source",
  "drain",
  "converter",
  "gate",
  "register",
]);

/** Vertical distance (px) between nodes' top edges in one column. */
export const ROW_GAP = 110;

/** Barycenter sweeps (one down and one up each). */
const SWEEPS = 4;

export interface LayeredOptions {
  /** Horizontal distance (px) between columns' left edges. */
  columnGap: number;
}

/** Top-left positions of the economy nodes, keyed by id. */
export function layeredPositions(
  model: Model,
  { columnGap }: LayeredOptions,
): Map<string, { x: number; y: number }> {
  const ids = model.nodes.filter((n) => ECONOMY_KINDS.has(n.kind)).map((n) => n.id).sort();
  const economy = new Set(ids);
  const drawn = model.edges
    .filter((e) => e.kind !== "interaction" && e.from !== e.to && economy.has(e.from) && economy.has(e.to))
    .map((e) => [e.from, e.to] as const);
  // A converter's inputs and outputs name the pools it trades between; they
  // place it between those pools even where no edge is drawn.
  const traded = model.nodes.flatMap((n) =>
    n.kind === "converter"
      ? [
          ...n.inputs.filter((r) => economy.has(r.resource)).map((r) => [r.resource, n.id] as const),
          ...n.outputs.filter((r) => economy.has(r.resource)).map((r) => [n.id, r.resource] as const),
        ]
      : [],
  );
  const seen = new Set<string>();
  const edges = [...drawn, ...traded].filter(([from, to]) => {
    const key = `${from}\u0000${to}`;
    return from !== to && !seen.has(key) && seen.add(key) !== undefined;
  });

  const kept = acyclic(ids, edges);
  const rank = ranks(ids, kept);
  // Longest-path ranks leave every node fed by nothing in column 0, however far
  // right its targets are; pull each one to just left of its nearest target, so
  // its edges do not run across the columns between.
  const fed = new Set(kept.map(([, to]) => to));
  for (const id of ids) {
    if (fed.has(id)) continue;
    const targets = kept.filter(([from]) => from === id).map(([, to]) => rank.get(to)!);
    if (targets.length > 0) rank.set(id, Math.min(...targets) - 1);
  }
  const columns: string[][] = [];
  for (const id of ids) (columns[rank.get(id)!] ??= []).push(id);
  orderColumns(columns, edges);

  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((column, c) => {
    const top = -((column.length - 1) * ROW_GAP) / 2;
    column.forEach((id, row) => positions.set(id, { x: c * columnGap, y: top + row * ROW_GAP }));
  });
  return positions;
}

/** The edges left once those closing a cycle are dropped. */
function acyclic(ids: readonly string[], edges: ReadonlyArray<readonly [string, string]>) {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Set<string>();
  for (const [from, to] of edges) {
    out.get(from)!.push(to);
    incoming.add(to);
  }
  for (const list of out.values()) list.sort();

  const state = new Map<string, "open" | "done">();
  const back = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, "open");
    for (const next of out.get(id)!) {
      const s = state.get(next);
      if (s === "open") back.add(`${id}\u0000${next}`);
      else if (s === undefined) visit(next);
    }
    state.set(id, "done");
  };
  // Roots first, so a cycle fed from outside is cut where it closes, not where it is entered.
  for (const id of [...ids.filter((id) => !incoming.has(id)), ...ids]) {
    if (!state.has(id)) visit(id);
  }
  return edges.filter(([from, to]) => !back.has(`${from}\u0000${to}`));
}

/** Longest-path rank of every node over an acyclic edge list. */
function ranks(ids: readonly string[], edges: ReadonlyArray<readonly [string, string]>) {
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  // Relaxing every edge |ids| times settles a DAG's longest paths.
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const [from, to] of edges) {
      const r = rank.get(from)! + 1;
      if (r > rank.get(to)!) {
        rank.set(to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

/** Reorder each column by the mean row of its neighbours in the column beside it. */
function orderColumns(columns: string[][], edges: ReadonlyArray<readonly [string, string]>): void {
  const neighbours = new Map<string, string[]>();
  for (const [a, b] of edges) {
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
    (neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push(a);
  }
  const row = new Map<string, number>();
  const index = (): void => columns.forEach((column) => column?.forEach((id, i) => row.set(id, i)));
  index();
  const sweep = (c: number, beside: number): void => {
    const column = columns[c];
    const other = columns[beside];
    if (!column || !other) return;
    const near = new Set(other);
    const key = new Map(column.map((id) => {
      const rows = (neighbours.get(id) ?? []).filter((n) => near.has(n)).map((n) => row.get(n)!);
      // A node with no neighbour there keeps its place.
      return [id, rows.length ? rows.reduce((s, r) => s + r, 0) / rows.length : row.get(id)!];
    }));
    column.sort((a, b) => key.get(a)! - key.get(b)! || (a < b ? -1 : 1));
    column.forEach((id, i) => row.set(id, i));
  };
  for (let s = 0; s < SWEEPS; s++) {
    for (let c = 1; c < columns.length; c++) sweep(c, c - 1);
    for (let c = columns.length - 2; c >= 0; c--) sweep(c, c + 1);
  }
}
