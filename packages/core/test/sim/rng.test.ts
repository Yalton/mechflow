import { describe, expect, it } from "vitest";
import { createRng, deriveSeed, splitmix32 } from "../../src/sim/rng.js";

function draws(seed: number, count = 20): number[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.next());
}

describe("createRng", () => {
  it("gives the same sequence for the same seed", () => {
    expect(draws(42)).toEqual(draws(42));
  });

  it("gives different sequences for different seeds, including neighbours", () => {
    expect(draws(1)).not.toEqual(draws(2));
    expect(draws(0)).not.toEqual(draws(1));
  });

  it("takes seeds modulo 2^32", () => {
    expect(draws(-1)).toEqual(draws(0xffff_ffff));
    expect(draws(2 ** 32 + 5)).toEqual(draws(5));
  });

  it("rejects a non-integer seed", () => {
    expect(() => createRng(1.5)).toThrow(RangeError);
    expect(() => createRng(Number.NaN)).toThrow(RangeError);
  });

  it("next() stays in [0, 1) with a mean near 0.5", () => {
    const values = draws(7, 10_000);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
  });

  it("int(n) stays in range and is roughly uniform over 10k draws", () => {
    const rng = createRng(3);
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const k = rng.int(6);
      expect(Number.isInteger(k) && k >= 0 && k < 6).toBe(true);
      counts[k]!++;
    }
    // Expected 1667 each; a 10% band is far outside chance for a fair die.
    for (const count of counts) {
      expect(count).toBeGreaterThan(1500);
      expect(count).toBeLessThan(1833);
    }
  });

  it("int(1) is always 0 and int rejects bad bounds", () => {
    const rng = createRng(9);
    expect(Array.from({ length: 10 }, () => rng.int(1))).toEqual(new Array(10).fill(0));
    for (const n of [0, -3, 2.5, 2 ** 32 + 1]) expect(() => rng.int(n)).toThrow(RangeError);
  });

  it("shuffle returns a permutation and leaves the input untouched", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const shuffled = createRng(11).shuffle(items);
    expect(items).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect([...shuffled].sort()).toEqual(items);
    expect(createRng(11).shuffle(items)).toEqual(shuffled);
  });

  it("shuffle reaches every order of three items", () => {
    const rng = createRng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(rng.shuffle([1, 2, 3]).join(""));
    expect(seen.size).toBe(6);
  });
});

describe("deriveSeed", () => {
  it("is deterministic and differs per run index", () => {
    expect(deriveSeed(100, 3)).toBe(deriveSeed(100, 3));
    const seeds = new Set(Array.from({ length: 1000 }, (_, i) => deriveSeed(100, i)));
    expect(seeds.size).toBe(1000);
  });

  it("is splitmix32(seed + i) as 32-bit unsigned integers", () => {
    expect(deriveSeed(100, 3)).toBe(splitmix32(103));
    const seed = deriveSeed(-1, 0);
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
  });
});
