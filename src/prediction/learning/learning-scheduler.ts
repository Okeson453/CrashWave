/**
 * Phase 22 — scheduled learning cadence (every N rounds).
 * Heavy work is invoked via callbacks (caller may offload to workers).
 */

export interface LearningSchedulerHooks {
  onCalibrationReview?: (roundCount: number) => void;
  onFeatureImportance?: (roundCount: number) => void;
  onWalkForward?: (roundCount: number) => void;
  onDriftCheck?: (roundCount: number) => void;
}

export class LearningScheduler {
  private rounds = 0;
  constructor(
    private readonly hooks: LearningSchedulerHooks = {},
    private readonly every = { calibration: 100, featureImportance: 200, walkForward: 500, drift: 50 }
  ) {}

  /** Call once per completed crash / observation */
  tick(): void {
    this.rounds += 1;
    if (this.rounds % this.every.drift === 0) this.hooks.onDriftCheck?.(this.rounds);
    if (this.rounds % this.every.calibration === 0) this.hooks.onCalibrationReview?.(this.rounds);
    if (this.rounds % this.every.featureImportance === 0) this.hooks.onFeatureImportance?.(this.rounds);
    if (this.rounds % this.every.walkForward === 0) this.hooks.onWalkForward?.(this.rounds);
  }

  getRoundCount(): number {
    return this.rounds;
  }

  reset(): void {
    this.rounds = 0;
  }
}

export const globalLearningScheduler = new LearningScheduler();
