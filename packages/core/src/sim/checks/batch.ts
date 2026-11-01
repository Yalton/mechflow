/** Thresholds for the Monte Carlo batch checks; every field has a default. */
export interface BatchCheckOptions {
  variance?: {
    /** Coefficient of variation of a pool's final amount that makes a finding. */
    maxCv?: number;
    /** Batches with fewer runs are not judged. */
    minRuns?: number;
  };
  streaks?: {
    /** A node's worst streak of short steps, in any run, that makes a finding. */
    minStreak?: number;
  };
}

export const BATCH_DEFAULTS = {
  variance: { maxCv: 0.5, minRuns: 10 },
  streaks: { minStreak: 5 },
} as const;
