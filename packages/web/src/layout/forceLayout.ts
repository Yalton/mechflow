import {
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { findGhostEdges } from "@mechflow/core";
import type { Model, Node } from "@mechflow/core";
import { clipBadge, flowRate } from "../graph/toFlow.js";
import { ECONOMY_KINDS, layeredPositions } from "./layered.js";

/**
 * Property-clustering force layout.
 *
 * Runs a seeded {@link https://github.com/d3/d3-force | d3-force} simulation and
 * returns an x/y position for every node. The layout groups mechanics and
 * entities that share model properties so the graph reads as clusters:
 *
 * - link attraction along the model's real edges (keeps connected nodes near),
 * - extra attraction between nodes that share properties, weighted by the
 *   `score` returned by `findGhostEdges` from `@mechflow/core` (the stronger the
 *   shared-property relationship, the harder they pull together),
 * - attraction toward an invisible anchor per property (nodes sharing a
 *   property cluster near that property's anchor),
 * - mutual repulsion (stops overlap),
 * - a weak pull toward each subsystem's centroid (subtle subsystem grouping).
 *
 * Economy nodes then move to a left-to-right layered layout (layered.ts),
 * placed to the left of the mechanics and entities.
 *
 * Pinned nodes (those with a stored `position`) stay fixed. Anchors are pinned
 * at fixed initial positions so the result is stable. The whole run is
 * deterministic for a given seed: d3-force draws its randomness from a seeded
 * PRNG (mulberry32), so the same model + seed always yields the same layout.
 *
 * Tune the constants below to meet the quality bar (see kj1.3): in
 * `examples/elements.yaml` fire and water must end up visibly closer to each
 * other than fire is to an unrelated node.
 */

export interface LayoutPosition {
  x: number;
  y: number;
}

export type LayoutPositions = Map<string, LayoutPosition>;

export interface RunLayoutOptions {
  /** Seed for the deterministic PRNG. Same seed => same layout. */
  seed?: number;
  /** Number of simulation ticks to run before reading positions. */
  ticks?: number;
  /** Link distance (px) for real edges and ghost/anchor links. */
  linkDistance?: number;
  /** Base attraction strength applied to ghost edges, before the score scale. */
  ghostBaseStrength?: number;
  /** Cap on the ghost-edge score used in the strength scale. */
  ghostMaxScore?: number;
  /** Distance (px) of a node from its property anchor. */
  anchorDistance?: number;
  /** Anchor strength (kept gentle so ghost edges own the clustering). */
  anchorStrength?: number;
  /** Radius (px) of the circle anchors are spread over initially. */
  anchorRadius?: number;
  /** Many-body repulsion strength (negative => repel). */
  repulsion?: number;
  /** Weak pull strength toward each subsystem centroid. */
  subsystemStrength?: number;
}

/** Default tuning constants. Documented so the kj1.3 quality bar is auditable. */
export const DEFAULT_LAYOUT: Required<RunLayoutOptions> = {
  seed: 1234,
  ticks: 300,
  linkDistance: 140,
  ghostBaseStrength: 0.15,
  ghostMaxScore: 6,
  anchorDistance: 70,
  anchorStrength: 0.05,
  anchorRadius: 240,
  repulsion: -300,
  subsystemStrength: 0.02,
};

/**
 * The space each node kind's card takes on the canvas, in px, with room for
 * wrapped text (see the widths in packages/web/src/graph/nodes). The layout
 * keeps cards {@link CARD_GAP} apart so none overlap.
 */
export const CARD_SIZE: Record<Node["kind"], { width: number; height: number }> = {
  mechanic: { width: 170, height: 120 },
  entity: { width: 170, height: 90 },
  // Economy kinds are symbols with their name underneath (nodes/Symbol.tsx).
  converter: { width: 120, height: 72 },
  register: { width: 120, height: 72 },
  gate: { width: 120, height: 72 },
  source: { width: 120, height: 72 },
  drain: { width: 120, height: 72 },
  pool: { width: 120, height: 72 },
};

/** Free space (px) kept between node cards. */
export const CARD_GAP = 24;

/** Most passes of the overlap-removal step; it stops as soon as none overlap. */
const SEPARATION_PASSES = 500;

interface SimNode extends SimulationNodeDatum {
  id: string;
  subsystem?: string;
  properties: Set<string>;
  isAnchor?: boolean;
}

interface LayoutLink extends SimulationLinkDatum<SimNode> {
  id: string;
  strength?: number;
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function nodeProperties(node: Node): Set<string> {
  if (node.kind === "mechanic") return new Set([...node.reads, ...node.writes]);
  if (node.kind === "entity") return new Set(node.has);
  return new Set();
}

/**
 * Weak force pulling each node toward the centroid of its subsystem. Registered
 * as a custom d3 force so it recomputes the centroid from live positions each
 * tick. Non-subsystem nodes and anchors are ignored.
 */
function forceSubsystemCentroid(
  simulation: ReturnType<typeof forceSimulation<SimNode>>,
  strength: number,
): (alpha: number) => void {
  return function pull(alpha: number): void {
    const nodes = simulation.nodes();
    const sums = new Map<string, { x: number; y: number; n: number }>();
    for (const d of nodes) {
      if (!d.subsystem || d.isAnchor) continue;
      const bucket = sums.get(d.subsystem);
      if (bucket) {
        bucket.x += d.x ?? 0;
        bucket.y += d.y ?? 0;
        bucket.n += 1;
      } else {
        sums.set(d.subsystem, { x: d.x ?? 0, y: d.y ?? 0, n: 1 });
      }
    }
    for (const d of nodes) {
      if (!d.subsystem || d.isAnchor) continue;
      const c = sums.get(d.subsystem);
      if (!c || c.n === 0) continue;
      d.vx = (d.vx ?? 0) + ((c.x / c.n) - (d.x ?? 0)) * alpha * strength;
      d.vy = (d.vy ?? 0) + ((c.y / c.n) - (d.y ?? 0)) * alpha * strength;
    }
  };
}

/**
 * Run the property-clustering layout for `model`.
 *
 * Returns a map from node id to the computed position. Deterministic for a
 * given `options.seed`.
 */
export function runLayout(model: Model, options: RunLayoutOptions = {}): LayoutPositions {
  const cfg = { ...DEFAULT_LAYOUT, ...options };
  const rng = mulberry32(cfg.seed);

  const nodeIds = new Set(model.nodes.map((n) => n.id));
  const simNodes: SimNode[] = model.nodes.map((node) => ({
    id: node.id,
    subsystem: node.subsystem,
    properties: nodeProperties(node),
    // Pinned nodes keep their stored position: seed x/y and pin with fx/fy
    // (d3-force v3 only honours fx/fy, not the `pinned` flag, for locking).
    x: node.position?.x,
    y: node.position?.y,
    fx: node.position?.x,
    fy: node.position?.y,
  }));

  // One invisible, pinned anchor per referenced property, spread on a circle so
  // different property clusters start apart.
  const referencedProperties = new Set<string>();
  for (const node of simNodes) for (const p of node.properties) referencedProperties.add(p);
  const propertyIds = [...referencedProperties].sort();
  const anchors: SimNode[] = propertyIds.map((prop, i) => {
    const angle = (i / Math.max(1, propertyIds.length)) * Math.PI * 2;
    const ax = Math.cos(angle) * cfg.anchorRadius;
    const ay = Math.sin(angle) * cfg.anchorRadius;
    return {
      id: `prop:${prop}`,
      x: ax,
      y: ay,
      fx: ax,
      fy: ay,
      isAnchor: true,
      properties: new Set(),
    };
  });

  // Real edges (normal attraction) + ghost edges (score-weighted attraction).
  const realLinks = model.edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => ({ id: `edge:${e.id}`, source: e.from, target: e.to }));

  const ghosts = findGhostEdges(model).map((g) => ({
    id: `ghost:${g.a}:${g.b}`,
    source: g.a,
    target: g.b,
    strength: cfg.ghostBaseStrength * Math.min(g.score, cfg.ghostMaxScore),
  }));

  const anchorLinks = simNodes
    .filter((n) => !n.isAnchor && n.properties.size > 0)
    .flatMap((n) =>
      [...n.properties].map((prop) => ({
        id: `anchor:${n.id}:${prop}`,
        source: n.id,
        target: `prop:${prop}`,
      })),
    );

  const simulation = forceSimulation<SimNode, LayoutLink>(simNodes.concat(anchors));
  simulation.randomSource(rng);

  simulation
    .force(
      "link",
      forceLink<SimNode, LayoutLink>(realLinks)
        .id((d) => d.id)
        .distance(cfg.linkDistance)
        .strength(0.15),
    )
    .force(
      "ghost",
      forceLink<SimNode, LayoutLink>(ghosts)
        .id((d) => d.id)
        .distance(cfg.linkDistance)
        .strength((d) => d.strength ?? 0),
    )
    .force(
      "anchor",
      forceLink<SimNode, LayoutLink>(anchorLinks)
        .id((d) => d.id)
        .distance(cfg.anchorDistance)
        .strength(cfg.anchorStrength),
    )
    .force("charge", forceManyBody().strength(cfg.repulsion))
    .force("subsystem", forceSubsystemCentroid(simulation, cfg.subsystemStrength));

  simulation.tick(cfg.ticks);
  simulation.stop();

  const kinds = new Map(model.nodes.map((n) => [n.id, n.kind]));
  const cards = simNodes.map((d) => ({
    id: d.id,
    x: d.x ?? 0,
    y: d.y ?? 0,
    ...CARD_SIZE[kinds.get(d.id)!],
    fixed: d.fx !== undefined && d.fx !== null,
    symbol: ECONOMY_KINDS.has(kinds.get(d.id)!),
  }));
  placeEconomy(model, cards);
  // The forces treat nodes as points, so wide cards can still overlap: push
  // overlapping cards apart, holding pinned nodes where they are.
  separateCards(cards, labelGaps(model));

  const positions = new Map<string, LayoutPosition>();
  // Whole pixels, so positions saved to YAML stay short and diff cleanly.
  for (const card of cards) {
    positions.set(card.id, card.fixed ? { x: card.x, y: card.y } : { x: Math.round(card.x), y: Math.round(card.y) });
  }
  return positions;
}

/** Horizontal room (px) between economy columns besides the edge badges. */
const MIN_COLUMN_ROOM = 90;

/** Space (px) between the economy block and the mechanics beside it. */
const BLOCK_GAP = 160;

/**
 * Move the free economy cards to their layered positions (layered.ts), as a
 * block left of the other free cards and level with them.
 */
function placeEconomy(model: Model, cards: Card[]): void {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const economy = cards.filter((c) => !c.fixed && ECONOMY_KINDS.has(byId.get(c.id)!.kind));
  if (economy.length === 0) return;
  const badge = Math.max(0, ...model.edges.map((e) => labelWidth(e, byId)));
  const width = CARD_SIZE.pool.width;
  const layered = layeredPositions(model, { columnGap: width + Math.max(MIN_COLUMN_ROOM, badge + 2 * LABEL_ROOM) });
  const others = cards.filter((c) => !c.fixed && !ECONOMY_KINDS.has(byId.get(c.id)!.kind));
  const placed = economy.map((c) => layered.get(c.id)!);
  const right = Math.max(...placed.map((p) => p.x)) + width;
  const mid = (Math.min(...placed.map((p) => p.y)) + Math.max(...placed.map((p) => p.y))) / 2;
  let dx = 0;
  let dy = -mid;
  if (others.length > 0) {
    dx = Math.min(...others.map((c) => c.x)) - BLOCK_GAP - right;
    dy = (Math.min(...others.map((c) => c.y)) + Math.max(...others.map((c) => c.y + c.height))) / 2 - mid;
  }
  economy.forEach((card, i) => {
    card.x = placed[i]!.x + dx;
    card.y = placed[i]!.y + dy;
  });
}

/**
 * The edge badge's width in px, as FlowEdge draws it (7 px a character plus
 * padding); 0 for an edge without one. Flow edges show their rate (see
 * flowRate), others their polarity and label.
 */
export function labelWidth(edge: Model["edges"][number], nodes: ReadonlyMap<string, Node>): number {
  const badge = clipBadge(edge.kind === "flow"
    ? `${edge.polarity ?? ""} ${flowRate(edge, nodes)}`.trim()
    : `${edge.polarity ?? ""}${edge.label ? ` ${edge.label}` : ""}`.trim());
  return badge.length > 0 ? badge.length * 7 + 10 : 0;
}

/** Room (px) kept on either side of a label between its edge's two cards. */
const LABEL_ROOM = 8;

/**
 * For each pair of cards joined by a labelled edge, the horizontal gap they
 * need so the label fits between them; keyed `a|b` with a < b. Edges leave
 * and enter cards at the sides, so the label sits in the horizontal gap.
 */
function labelGaps(model: Model): Map<string, number> {
  const gaps = new Map<string, number>();
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  for (const edge of model.edges) {
    const width = labelWidth(edge, nodes);
    if (width === 0 || edge.from === edge.to) continue;
    const key = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    gaps.set(key, Math.max(gaps.get(key) ?? 0, width + 2 * LABEL_ROOM));
  }
  return gaps;
}

interface Card {
  id: string;
  /** Top-left corner, as React Flow places nodes. */
  x: number;
  y: number;
  width: number;
  height: number;
  fixed: boolean;
  /** An economy symbol; two of these stack in a column without being pushed sideways. */
  symbol: boolean;
}

/**
 * Move overlapping cards apart until every pair is at least {@link CARD_GAP}
 * apart on one axis, and cards joined by a labelled edge are far enough
 * apart sideways for the label. Each overlap is resolved along the axis that needs the
 * smaller move, split between the two cards (all of it on the free card when
 * the other is pinned). Deterministic: pairs are visited in a fixed order.
 */
function separateCards(cards: Card[], labelGaps: ReadonlyMap<string, number>): void {
  for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i]!;
        const b = cards[j]!;
        if (a.fixed && b.fixed) continue;
        const ax = a.x + a.width / 2;
        const ay = a.y + a.height / 2;
        const bx = b.x + b.width / 2;
        const by = b.y + b.height / 2;
        const shareA = a.fixed ? 0 : b.fixed ? 1 : 0.5;
        const shareB = 1 - shareA;
        // Cards joined by a labelled edge keep room for the label between them.
        const labelGap = labelGaps.get(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`) ?? 0;
        // Cards side by side keep apart sideways; economy symbols stacked in a
        // layered column only need it when a labelled edge joins them.
        const sideways = labelGap > 0 || !(a.symbol && b.symbol);
        const short = sideways ? (a.width + b.width) / 2 + labelGap - Math.abs(ax - bx) : 0;
        if (short > 0) {
          moved = true;
          const sign = ax < bx || (ax === bx && a.id < b.id) ? -1 : 1;
          a.x += sign * short * shareA;
          b.x -= sign * short * shareB;
          continue;
        }
        const overlapX = (a.width + b.width) / 2 + CARD_GAP - Math.abs(ax - bx);
        const overlapY = (a.height + b.height) / 2 + CARD_GAP - Math.abs(ay - by);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        if (overlapX < overlapY) {
          // Ties (cards stacked exactly) go by id order, so the result is stable.
          const sign = ax < bx || (ax === bx && a.id < b.id) ? -1 : 1;
          a.x += sign * overlapX * shareA;
          b.x -= sign * overlapX * shareB;
        } else {
          const sign = ay < by || (ay === by && a.id < b.id) ? -1 : 1;
          a.y += sign * overlapY * shareA;
          b.y -= sign * overlapY * shareB;
        }
      }
    }
    if (!moved) return;
  }
}
