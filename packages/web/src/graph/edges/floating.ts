import type { Box, Point } from "./labelPlacement.js";

/**
 * Geometry for "floating" edges: an edge runs from the border of its source
 * node to the border of its target, on the sides that face each other,
 * instead of from fixed left/right handles. The path is one quadratic curve
 * bowed to the left of its direction, so a pair of opposite edges (A to B and
 * B to A) bow apart instead of drawing over each other.
 */

/** A node's box and whether it is drawn as a circle (pools). */
export interface Shape extends Box {
  round: boolean;
}

export interface FloatingPath {
  /** SVG path data. */
  d: string;
  /** Points along the curve, for placing the label. */
  points: Point[];
  /** The curve's midpoint. */
  mid: Point;
}

/** How far the curve bows out, as a fraction of the centre-to-centre distance. */
const BOW = 0.18;

/** Gap (px) left between the arrow tip and the target's border. */
const TIP_GAP = 2;

const centre = (s: Shape): Point => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 });

/**
 * Where the ray from the shape's centre towards `toward` leaves the shape: on
 * the circle for a round shape, otherwise on the box.
 */
export function borderPoint(shape: Shape, toward: Point): Point {
  const c = centre(shape);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return c;
  if (shape.round) {
    const r = Math.min(shape.width, shape.height) / 2;
    return { x: c.x + (dx / length) * r, y: c.y + (dy / length) * r };
  }
  const scale = Math.min(
    dx === 0 ? Infinity : shape.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : shape.height / 2 / Math.abs(dy),
  );
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

function quadAt(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

function curve(start: Point, control: Point, end: Point): FloatingPath {
  const points = Array.from({ length: 17 }, (_, i) => quadAt(start, control, end, i / 16));
  return {
    d: `M${start.x},${start.y} Q${control.x},${control.y} ${end.x},${end.y}`,
    points,
    mid: quadAt(start, control, end, 0.5),
  };
}

/** The curve between two node shapes, border to border, bowed by `bow`. */
export function floatingPath(source: Shape, target: Shape, bow = BOW): FloatingPath {
  if (source === target || (source.x === target.x && source.y === target.y)) {
    return selfLoop(source);
  }
  const a = centre(source);
  const b = centre(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Bow to the left of the direction of travel (screen coordinates).
  const control = { x: (a.x + b.x) / 2 + dy * bow, y: (a.y + b.y) / 2 - dx * bow };
  const start = borderPoint(source, control);
  const rawEnd = borderPoint(target, control);
  // Pull the end back a little so the arrowhead's tip touches the border.
  const ex = control.x - rawEnd.x;
  const ey = control.y - rawEnd.y;
  const el = Math.hypot(ex, ey) || 1;
  const end = { x: rawEnd.x + (ex / el) * TIP_GAP, y: rawEnd.y + (ey / el) * TIP_GAP };
  return curve(start, control, end);
}

/**
 * Bows tried in turn when the default curve runs through another node: wider
 * each time, alternating sides, the default side first so that a pair of
 * opposite edges still bow apart.
 */
const DETOURS = [BOW, 0.35, -0.35, 0.55, -0.55, 0.8, -0.8];

/** Room (px) kept between a detouring curve and the nodes it avoids. */
const CLEARANCE = 6;

/** How much of the curve's sampled length runs inside the obstacles. */
function hits(path: FloatingPath, obstacles: readonly Box[]): number {
  // Skip the ends, which sit on the curve's own nodes.
  return path.points.slice(1, -1).filter((p) =>
    obstacles.some((o) =>
      p.x > o.x - CLEARANCE && p.x < o.x + o.width + CLEARANCE &&
      p.y > o.y - CLEARANCE && p.y < o.y + o.height + CLEARANCE,
    ),
  ).length;
}

/**
 * {@link floatingPath}, bent further out when it would run through one of
 * `obstacles` (the other nodes): the first bow in {@link DETOURS} that clears
 * them all, else the one that touches them least.
 */
export function avoidingPath(source: Shape, target: Shape, obstacles: readonly Box[]): FloatingPath {
  let best = floatingPath(source, target);
  if (source === target || (source.x === target.x && source.y === target.y)) return best;
  let least = hits(best, obstacles);
  for (const bow of DETOURS.slice(1)) {
    if (least === 0) break;
    const path = floatingPath(source, target, bow);
    const count = hits(path, obstacles);
    if (count < least) {
      best = path;
      least = count;
    }
  }
  return best;
}

/** The curve between two points, for an edge whose nodes are not measured yet. */
export function pointPath(from: Point, to: Point): FloatingPath {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return curve(from, { x: (from.x + to.x) / 2 + dy * BOW, y: (from.y + to.y) / 2 - dx * BOW }, to);
}

/** A loop out of the top of a node and back into it. */
function selfLoop(shape: Shape): FloatingPath {
  const c = centre(shape);
  const top = shape.y;
  const start = borderPoint(shape, { x: c.x - shape.width / 4, y: top - 1 });
  const end = borderPoint(shape, { x: c.x + shape.width / 4, y: top - 1 });
  const lift = 48;
  const c1 = { x: start.x - 24, y: top - lift };
  const c2 = { x: end.x + 24, y: top - lift };
  const points: Point[] = Array.from({ length: 17 }, (_, i) => {
    const t = i / 16;
    const u = 1 - t;
    return {
      x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
      y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
    };
  });
  return {
    d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`,
    points,
    mid: points[8]!,
  };
}

/** Path data for a polyline, which {@link placeLabel} reads point by point. */
export function polyline(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}
