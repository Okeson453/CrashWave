/**
 * Phase 8 — Production rollout controller
 * Canary 5% → 25% → 50% → 100% with rollback.
 * Integrates divergence sheath + lifecycle.
 */

import {
  globalModelLifecycle,
  type ModelLifecycleManager,
  type ModelVersionRecord,
} from './model-lifecycle.js';
import {
  globalLiveDivergence,
  type LiveDivergenceMonitor,
  type DivergenceSnapshot,
} from '../validation/live-divergence-monitor.js';

export type RolloutStep = 0.05 | 0.25 | 0.5 | 1.0;

export interface ProductionStatus {
  activeModel: ModelVersionRecord | null;
  canaryModel: ModelVersionRecord | null;
  rolloutShare: number;
  divergence: DivergenceSnapshot;
  entriesAllowed: boolean;
  kellyAllowed: boolean;
  multiTargetAllowed: boolean;
  dynamicThresholdsAllowed: boolean;
}

export class ProductionController {
  private rolloutShare: RolloutStep = 1.0;

  constructor(
    private readonly lifecycle: ModelLifecycleManager = globalModelLifecycle,
    private readonly divergence: LiveDivergenceMonitor = globalLiveDivergence
  ) {}

  status(): ProductionStatus {
    const models = this.lifecycle.list();
    const active = models.find((m) => m.stage === 'PRODUCTION') ?? null;
    const canary = models.find((m) => m.stage === 'CANARY') ?? null;
    const div = this.divergence.evaluate();
    const actions = div.actions;
    return {
      activeModel: active,
      canaryModel: canary,
      rolloutShare: canary ? canary.trafficShare : this.rolloutShare,
      divergence: div,
      entriesAllowed: !actions.fullSheathHaltEntries,
      kellyAllowed: !actions.disableKelly,
      multiTargetAllowed: !actions.disableMultiTargetSwitch,
      dynamicThresholdsAllowed: !actions.disableDynamicThresholds,
    };
  }

  advanceCanary(modelName: string, modelVersion: string): ModelVersionRecord {
    const rec = this.lifecycle.get(modelName, modelVersion);
    if (!rec) throw new Error('model not found');
    if (rec.stage === 'SHADOW') {
      return this.lifecycle.promote(modelName, modelVersion, 'CANARY');
    }
    if (rec.stage === 'CANARY') {
      const next: RolloutStep =
        rec.trafficShare < 0.1 ? 0.25 : rec.trafficShare < 0.3 ? 0.5 : 1.0;
      if (next === 1.0) {
        return this.lifecycle.promote(modelName, modelVersion, 'PRODUCTION');
      }
      this.lifecycle.setCanaryShare(modelName, modelVersion, next);
      return this.lifecycle.get(modelName, modelVersion)!;
    }
    throw new Error(`Cannot advance from ${rec.stage}`);
  }

  rollback(modelName: string, modelVersion: string): ModelVersionRecord {
    return this.lifecycle.rollbackTo(modelName, modelVersion);
  }

  /** Should this request use the candidate model? */
  shouldUseCandidate(modelName: string, modelVersion: string): boolean {
    const st = this.status();
    if (!st.entriesAllowed) return false;
    return this.lifecycle.routeCanary(modelName, modelVersion);
  }

  observeOutcome(predicted: number, actual: 0 | 1): DivergenceSnapshot {
    const snap = this.divergence.observe(predicted, actual);
    // Auto-rollback canary when divergence reaches high levels (3+)
    if (snap.level >= 3) {
      const canary = this.lifecycle.list().find((m) => m.stage === 'CANARY');
      if (canary) {
        try {
          this.lifecycle.rollbackTo(canary.modelName, canary.modelVersion);
        } catch {
          /* no prior production version */
        }
      }
    }
    return snap;
  }

  manualRecoverDivergence(): DivergenceSnapshot {
    return this.divergence.manualRecover(true);
  }
}

export const globalProductionController = new ProductionController();
