import { describe, expect, it } from "vitest";
import { avoidingPath, borderPoint, floatingPath, type Shape } from "../src/graph/edges/floating.js";

const pool = (x: number, y: number): Shape => ({ x, y, width: 100, height: 100, round: true });
const card = (x: number, y: number): Shape => ({ x, y, width: 160, height: 80, round: false });

describe("floating edges", () => {
  it("leaves a circle on its radius and a box on its border", () => {
    expect(borderPoint(pool(0, 0), { x: 500, y: 50 })).toEqual({ x: 100, y: 50 });
    expect(borderPoint(card(0, 0), { x: 80, y: 500 })).toEqual({ x: 80, y: 80 });
  });

  it("runs between the facing sides, so a target on the left is entered from the right", () => {
    const path = floatingPath(pool(400, 0), pool(0, 0));
    const start = path.points[0]!;
    const end = path.points[path.points.length - 1]!;
    expect(start.x).toBeLessThan(420);
    expect(start.x).toBeGreaterThanOrEqual(400);
    expect(end.x).toBeGreaterThan(80);
    expect(end.x).toBeLessThanOrEqual(100);
  });

  it("bows opposite edges apart instead of drawing one over the other", () => {
    const there = floatingPath(pool(0, 0), pool(400, 0));
    const back = floatingPath(pool(400, 0), pool(0, 0));
    expect(Math.sign(there.mid.y - 50)).toBe(-Math.sign(back.mid.y - 50));
    expect(Math.abs(there.mid.y - back.mid.y)).toBeGreaterThan(40);
  });

  it("draws a loop above a node that feeds itself", () => {
    const loop = floatingPath(pool(0, 0), pool(0, 0));
    expect(loop.d.startsWith("M")).toBe(true);
    expect(loop.mid.y).toBeLessThan(0);
  });
});

describe("avoidingPath", () => {
  const box = (x: number, y: number): Shape => ({ x, y, width: 40, height: 40, round: true });
  const inside = (p: { x: number; y: number }, o: { x: number; y: number; width: number; height: number }) =>
    p.x > o.x && p.x < o.x + o.width && p.y > o.y && p.y < o.y + o.height;

  it("bends around a node lying on the straight line between the ends", () => {
    // A tall card in the middle, as a mechanic card sits between two symbols.
    const [a, c] = [box(0, 0), box(400, 0)];
    const mid = { x: 170, y: -60, width: 100, height: 160 };
    expect(floatingPath(a, c).points.some((p) => inside(p, mid))).toBe(true);
    const path = avoidingPath(a, c, [mid]);
    expect(path.points.some((p) => inside(p, mid))).toBe(false);
  });

  it("keeps the default curve when nothing is in the way", () => {
    const [a, c] = [box(0, 0), box(400, 0)];
    expect(avoidingPath(a, c, [box(200, 300)]).d).toBe(floatingPath(a, c).d);
  });
});
