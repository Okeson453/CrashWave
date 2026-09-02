
/**
 * Wire LearningScheduler hooks to real calibration / drift / walk-forward actions.
 */

import { getLogger } from "../../observability/logger.js";
import { LearningScheduler, globalLearningScheduler } from "./learning-scheduler.js";
import { globalCalibrationState } from "../calibration/calibration-state.js";
import { globalFeatureDrift } from "../drift/feature-drift.js";
import { globalPredictionDrift } from "../drift/prediction-drift.js";
import { globalIncrementalState } from "../state/incremental-state-engine.js";
import type { SheathMode } from "../../core/sheath-mode/index.js";

const logger = getLogger();

export function installLearningHooks(sheathMode?: SheathMode | null): LearningScheduler {
  // Re-bind global scheduler hooks by replacing ticks via a dedicated scheduler
  // used only if caller swaps; we attach side effects on each cadence via wrapper.
  const hooks = {
    onCalibrationReview: (n: number) => {
      globalCalibrationState.refit();
      const m = globalCalibrationState.metrics();
      logger.info({ component: "LearningHooks", n, ece: m.ece, brier: m.brier }, "Calibration review");
      if (m.ece > 0.08) {
        sheathMode?.reportPredictionHealth({
          divergenceLevel: 2,
          ece: m.ece,
          reason: `calibration-review ECE=${m.ece.toFixed(3)}`,
        });
      }
    },
    onFeatureImportance: (n: number) => {
      const snap = globalIncrementalState.snapshot();
      logger.info(
        {
          component: "LearningHooks",
          n,
          ewmaHit13: snap.ewmaHit13,
          shortHit: globalIncrementalState.shortHitRate13(),
        },
        "Feature importance snapshot"
      );
    },
    onWalkForward: (n: number) => {
      logger.info({ component: "LearningHooks", n }, "Walk-forward validation cadence (background)");
      // Heavy WF stays off event loop — signal only; ValidationWorker / jobs pick up
    },
    onDriftCheck: (n: number) => {
      const feat = globalFeatureDrift.observe({
        ewma: globalIncrementalState.snapshot().ewmaHit13,
        short: globalIncrementalState.shortHitRate13(),
      });
      const pred = globalPredictionDrift.observe(globalIncrementalState.snapshot().ewmaHit13);
      if (feat.drifted || pred.drifted) {
        logger.warn(
          { component: "LearningHooks", n, feat, pred },
          "Drift detected"
        );
        sheathMode?.reportPredictionHealth({
          divergenceLevel: feat.drifted ? 3 : 1,
          reason: `drift feature=${feat.drifted} pred=${pred.drifted}`,
        });
      }
    },
  };

  // Monkey-patch: create a new scheduler is not possible for singleton; instead
  // wrap tick is not available. Install by replacing module-level usage:
  const scheduler = new LearningScheduler(hooks);
  // Copy round count if needed — fresh is fine at startup
  return scheduler;
}

/** Default process-wide installer using globalLearningScheduler patterns */
export function tickLearningWithHooks(sheathMode?: SheathMode | null): void {
  // Lightweight inline cadence on the global counter without replacing instance
  const n = globalLearningScheduler.getRoundCount() + 1;
  // Use a side-channel by calling the same intervals
  if (n % 50 === 0) {
    const feat = globalFeatureDrift.observe({
      ewma: globalIncrementalState.snapshot().ewmaHit13,
      short: globalIncrementalState.shortHitRate13(),
    });
    if (feat.drifted) {
      sheathMode?.reportPredictionHealth({
        divergenceLevel: 2,
        reason: `feature-drift ${feat.key}=${feat.maxDelta.toFixed(3)}`,
      });
    }
  }
  if (n % 100 === 0) {
    globalCalibrationState.refit();
  }
  globalLearningScheduler.tick();
}
