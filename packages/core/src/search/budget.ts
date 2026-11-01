/**
 * Counts evaluations against a search's `maxEvaluations`. An analysis asks
 * before each evaluation, and reports `used` as `evaluationsUsed`.
 */
export class Budget {
  private spent = 0;

  constructor(readonly max: number) {}

  get used(): number {
    return this.spent;
  }

  get remaining(): number {
    return Math.max(0, this.max - this.spent);
  }

  /** Whether `count` more evaluations fit. */
  fits(count: number): boolean {
    return this.spent + count <= this.max;
  }

  /** Spend `count` evaluations; false (and nothing spent) if they do not fit. */
  take(count = 1): boolean {
    if (!this.fits(count)) return false;
    this.spent += count;
    return true;
  }
}
