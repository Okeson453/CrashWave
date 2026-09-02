/**
 * Phase 7/8 — Model lifecycle:
 * DEVELOPMENT → BACKTEST → VALIDATION → SHADOW → CANARY → PRODUCTION → DEPRECATION
 */

export type ModelStage =
  | 'DEVELOPMENT'
  | 'BACKTEST'
  | 'VALIDATION'
  | 'SHADOW'
  | 'CANARY'
  | 'PRODUCTION'
  | 'DEPRECATION';

export interface ModelVersionRecord {
  modelName: string;
  modelVersion: string;
  stage: ModelStage;
  trafficShare: number;
  metrics: {
    brier?: number;
    logLoss?: number;
    ece?: number;
    oosSkill?: number;
  };
  promotedAt?: string;
  notes?: string;
}

export interface PromotionGateResult {
  allowed: boolean;
  reasons: string[];
}

const STAGE_ORDER: ModelStage[] = [
  'DEVELOPMENT',
  'BACKTEST',
  'VALIDATION',
  'SHADOW',
  'CANARY',
  'PRODUCTION',
  'DEPRECATION',
];

export class ModelLifecycleManager {
  private readonly models = new Map<string, ModelVersionRecord>();
  private productionName: string | null = null;

  register(rec: ModelVersionRecord): void {
    const key = `${rec.modelName}@${rec.modelVersion}`;
    this.models.set(key, { ...rec });
    if (rec.stage === 'PRODUCTION') {
      this.productionName = key;
      rec.trafficShare = 1;
    }
  }

  get(modelName: string, modelVersion: string): ModelVersionRecord | undefined {
    return this.models.get(`${modelName}@${modelVersion}`);
  }

  list(): ModelVersionRecord[] {
    return [...this.models.values()];
  }

  checkPromotionGates(
    candidate: ModelVersionRecord,
    baseline: ModelVersionRecord
  ): PromotionGateResult {
    const reasons: string[] = [];
    const c = candidate.metrics;
    const b = baseline.metrics;

    if (c.oosSkill == null || (b.oosSkill != null && c.oosSkill <= b.oosSkill)) {
      reasons.push('oos-skill not better than baseline');
    }
    if (c.ece != null && b.ece != null && c.ece > b.ece + 0.01) {
      reasons.push('calibration ECE worse than baseline');
    }
    if (c.brier != null && b.brier != null && c.brier > b.brier) {
      reasons.push('Brier not improved');
    }
    if (c.logLoss != null && b.logLoss != null && c.logLoss > b.logLoss) {
      reasons.push('log-loss not improved');
    }

    return { allowed: reasons.length === 0, reasons };
  }

  promote(modelName: string, modelVersion: string, next: ModelStage): ModelVersionRecord {
    const key = `${modelName}@${modelVersion}`;
    const rec = this.models.get(key);
    if (!rec) throw new Error(`Unknown model ${key}`);
    const fromIdx = STAGE_ORDER.indexOf(rec.stage);
    const toIdx = STAGE_ORDER.indexOf(next);
    if (toIdx < fromIdx && next !== 'DEPRECATION') {
      throw new Error(`Cannot move ${rec.stage} → ${next}`);
    }
    rec.stage = next;
    rec.promotedAt = new Date().toISOString();
    if (next === 'CANARY') rec.trafficShare = 0.05;
    if (next === 'PRODUCTION') {
      // Deprecate previous production
      if (this.productionName && this.productionName !== key) {
        const prev = this.models.get(this.productionName);
        if (prev) {
          prev.stage = 'DEPRECATION';
          prev.trafficShare = 0;
        }
      }
      this.productionName = key;
      rec.trafficShare = 1;
    }
    if (next === 'SHADOW') rec.trafficShare = 0;
    return { ...rec };
  }

  setCanaryShare(modelName: string, modelVersion: string, share: number): void {
    const rec = this.get(modelName, modelVersion);
    if (!rec || rec.stage !== 'CANARY') {
      throw new Error('Canary share only for CANARY stage models');
    }
    const s = Math.max(0.05, Math.min(0.5, share));
    rec.trafficShare = s;
  }

  /** Route a decision unit of traffic: true → use candidate */
  routeCanary(modelName: string, modelVersion: string, rand = Math.random()): boolean {
    const rec = this.get(modelName, modelVersion);
    if (!rec) return false;
    if (rec.stage === 'PRODUCTION') return true;
    if (rec.stage === 'CANARY') return rand < rec.trafficShare;
    return false; // SHADOW and below never authorize live
  }

  rollbackTo(modelName: string, modelVersion: string): ModelVersionRecord {
    const key = `${modelName}@${modelVersion}`;
    const rec = this.models.get(key);
    if (!rec) throw new Error(`Unknown model ${key}`);
    for (const m of this.models.values()) {
      if (m.stage === 'PRODUCTION' || m.stage === 'CANARY') {
        m.stage = 'DEPRECATION';
        m.trafficShare = 0;
      }
    }
    rec.stage = 'PRODUCTION';
    rec.trafficShare = 1;
    rec.promotedAt = new Date().toISOString();
    rec.notes = (rec.notes ?? '') + ' | rollback';
    this.productionName = key;
    return { ...rec };
  }
}

export const globalModelLifecycle = new ModelLifecycleManager();
