/**
 * Where an edge's label goes so that it does not sit under a node card.
 *
 * React Flow draws edges beneath nodes, so a label at the path's midpoint is
 * hidden whenever the path runs behind a card. The label is moved along the
 * path instead: the midpoint first, then points stepping outwards towards
 * either end, taking the first spot where the label's box clears every card.
 * When none does (a short edge between two close cards), it takes the spot
 * that covers the least card area.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Free space (px) kept between a label and a card. */
const LABEL_MARGIN = 4;

/** Fractions of the path length tried, in order: outwards from the middle. */
const TRIES = Array.from({ length: 19 }, (_, i) => 0.5 + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 0.05);

/**
 * The corner points of an SVG path made of M, L and Q commands, as
 * `getSmoothStepPath` returns. A quadratic's control point is the corner it
 * rounds, so the points trace the path closely enough to place a label.
 */
export function pathPoints(d: string): Point[] {
  const numbers = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const points: Point[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i]!, y: numbers[i + 1]! });
  }
  return points;
}

/** The point a fraction `t` of the way along the polyline `points`. */
export function pointAlong(points: readonly Point[], t: number): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let left = lengths.reduce((sum, l) => sum + l, 0) * t;
  for (const [i, length] of lengths.entries()) {
    if (left <= length && length > 0) {
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + ((b.x - a.x) * left) / length, y: a.y + ((b.y - a.y) * left) / length };
    }
    left -= length;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

/** The area a label centred at `center` shares with `box` and its margin. */
function overlap(center: Point, size: { width: number; height: number }, box: Box): number {
  const width =
    Math.min(center.x + size.width / 2, box.x + box.width + LABEL_MARGIN) -
    Math.max(center.x - size.width / 2, box.x - LABEL_MARGIN);
  const height =
    Math.min(center.y + size.height / 2, box.y + box.height + LABEL_MARGIN) -
    Math.max(center.y - size.height / 2, box.y - LABEL_MARGIN);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The center for a label of `size` on the path `d`: `midpoint` (the path's
 * own label point) when it is clear of every box in `cards`, else the first
 * clear spot along the path, else the tried spot covering the least card.
 */
export function placeLabel(
  d: string,
  size: { width: number; height: number },
  cards: readonly Box[],
  midpoint: Point,
): Point {
  const covered = (spot: Point): number => cards.reduce((sum, box) => sum + overlap(spot, size, box), 0);
  let best = midpoint;
  let least = covered(midpoint);
  const points = pathPoints(d);
  if (least === 0 || points.length < 2) return midpoint;
  for (const t of TRIES) {
    const spot = pointAlong(points, t);
    const area = covered(spot);
    if (area === 0) return spot;
    // Ignore rounding noise, so an equally covered spot never displaces an earlier one.
    if (area < least - 0.5) {
      best = spot;
      least = area;
    }
  }
  return best;
}
