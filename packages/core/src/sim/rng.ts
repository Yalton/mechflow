/**
 * Seeded random numbers for simulation runs (docs/simulation-semantics.md,
 * "Randomness").
 *
 * Every run takes an explicit 32-bit seed. The generator is sfc32, a small,
 * fast 32-bit PRNG with good statistical quality, whose four words of state are
 * filled from the seed by splitmix32. Nothing in the simulation may use
 * `Math.random`: a run must be a pure function of the model, the seed and the
 * run options.
 */

export interface Rng {
  /** A float in [0, 1). Also usable as the formula evaluator's `rng`. */
  next(): number;
  /** An integer in [0, n), without modulo bias. `n` is a positive integer. */
  int(n: number): number;
  /** A shuffled copy of `items` (Fisher-Yates); the input is left untouched. */
  shuffle<T>(items: readonly T[]): T[];
}

const GOLDEN_GAMMA = 0x9e3779b9;
const TWO_POW_32 = 0x1_0000_0000;

/** Reduce any safe integer to an unsigned 32-bit seed. */
function toSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`seed must be an integer, got ${seed}`);
  }
  return Number(BigInt.asUintN(32, BigInt(seed)));
}

/** The splitmix32 output function: a well-mixed 32-bit hash of `x`. */
function mix32(x: number): number {
  let t = x ^ (x >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}

/** One splitmix32 step: the hash of `x` advanced by the golden gamma. */
export function splitmix32(x: number): number {
  return mix32((toSeed(x) + GOLDEN_GAMMA) >>> 0);
}

/**
 * The seed for Monte Carlo run `i` of a batch started with `seed`. Each run is
 * independent and can be replayed alone with this seed.
 */
export function deriveSeed(seed: number, i: number): number {
  return splitmix32(toSeed(seed) + i);
}

/** A generator seeded with `seed` (any safe integer, taken modulo 2^32). */
export function createRng(seed: number): Rng {
  let state = toSeed(seed);
  const seedWord = (): number => {
    state = (state + GOLDEN_GAMMA) >>> 0;
    return mix32(state);
  };
  let a = seedWord();
  let b = seedWord();
  let c = seedWord();
  let d = seedWord();

  const nextUint32 = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Discard the first outputs so similar seeds diverge fully.
  for (let i = 0; i < 12; i++) nextUint32();

  const int = (n: number): number => {
    if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
      throw new RangeError(`int(n) needs an integer n in [1, 2^32], got ${n}`);
    }
    // Reject the top partial block so every residue is equally likely.
    const limit = TWO_POW_32 - (TWO_POW_32 % n);
    for (;;) {
      const u = nextUint32();
      if (u < limit) return u % n;
    }
  };

  return {
    next: () => nextUint32() / TWO_POW_32,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
