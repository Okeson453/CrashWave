/**
 * Learning Worker — outcomes, drift, calibration, feedback to prediction stack.
 */

import { BaseWorker } from '../framework/base-worker';
import type { WorkerContext } from '../framework/types';
import type { SheathMode } from '../../core/sheath-mode';
import type { SheathTrigger } from '../../core/sheath-mode';
import { feedbackPredictionPipeline } from '../../prediction/prediction-pipeline';
import { globalCalibrationState } from '../../prediction/calibration/calibration-state';
import { tickLearningWithHooks } from '../../prediction/learning/learning-bootstrap';
import { globalEnsemble } from '../../prediction/ensemble/ensemble-orchestrator';

export interface LearningWorkerDeps {
  sheathMode?: SheathMode;
  onOutcome?: (payload: Record<string, unknown>) => Promise<void>;
  getRollingAccuracy?: () => number;
  accuracyBaseline?: number;
  publishState?: () => void | Promise<void>;
}

export class LearningWorker extends BaseWorker {
  private readonly deps: LearningWorkerDeps;
  private outcomes = 0;
  private wins = 0;

  constructor(deps: LearningWorkerDeps = {}, name = 'learning-1') {
    super({
      type: 'learning',
      name,
      priority: 'background',
      concurrency: 1,
      heartbeatIntervalMs: 15_000,
    });
    this.deps = deps;
  }

  protected async handle(payload: unknown, _ctx: WorkerContext): Promise<void> {
    const p = (payload ?? {}) as Record<string, unknown>;
    const crashPoint = Number(p.crashPoint);
    const predicted = Number(p.predictedProbability ?? p.probability);
    const actual: 0 | 1 =
      Number.isFinite(crashPoint) && crashPoint > 0
        ? crashPoint >= 1.3
          ? 1
          : 0
        : Number(p.actual) === 1
          ? 1
          : 0;

    this.outcomes += 1;
    if (actual === 1) this.wins += 1;

    if (Number.isFinite(predicted) && predicted > 0) {
      feedbackPredictionPipeline(predicted, actual);
      globalCalibrationState.observe(predicted, actual, String(p.regime ?? 'global'));
      // Ensemble model performance feedback when scores provided
      const scores = p.modelScores as
        | Array<{ modelName: string; probability: number }>
        | undefined;
      if (Array.isArray(scores)) {
        globalEnsemble.observeOutcome(
          scores.map((s) => ({
            modelName: s.modelName,
            modelVersion: '1',
            probability: s.probability,
            confidence: 0.5,
            weight: 1,
          })),
          actual
        );
      }
    }

    tickLearningWithHooks(this.deps.sheathMode ?? null);

    if (this.deps.onOutcome) {
      await this.deps.onOutcome(p);
    }
    if (this.deps.publishState) {
      await this.deps.publishState();
    }

    const accuracy =
      this.deps.getRollingAccuracy?.() ??
      (this.outcomes > 0 ? this.wins / this.outcomes : 1);
    const baseline = this.deps.accuracyBaseline ?? 0.55;

    if (this.outcomes >= 50 && accuracy < baseline * 0.6 && this.deps.sheathMode) {
      const trigger: SheathTrigger = {
        id: 'poor_prediction_accuracy',
        severity: 'high',
        message: `Rolling accuracy ${(accuracy * 100).toFixed(1)}% below baseline`,
        detectedAt: new Date().toISOString(),
        metadata: { accuracy, baseline, outcomes: this.outcomes },
      };
      this.deps.sheathMode.reportTriggers([trigger]);
    } else if (this.outcomes >= 50 && accuracy >= baseline * 0.7 && this.deps.sheathMode) {
      this.deps.sheathMode.clearTrigger('poor_prediction_accuracy');
    }
  }
}
