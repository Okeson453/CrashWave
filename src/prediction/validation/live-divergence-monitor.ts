/**
 * Phase 7 — Live Divergence Monitor
 * Rolling window of predictions vs outcomes; progressive sheath levels.
 * Recovery requires manual confirmation (no auto "got better").
 */

export type DivergenceLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface DivergenceActions {
  /** Level 1 */ disableDynamicThresholds: boolean;
  /** Level 2 */ disableMultiTargetSwitch: boolean;
  /** Level 3 */ disableKelly: boolean;
  /** Level 4 */ lockConservativeBaseline: boolean;
  /** Level 5 */ fullSheathHaltEntries: boolean;
}

export interface DivergenceSnapshot {
  level: DivergenceLevel;
  actions: DivergenceActions;
  windowSize: number;
  predictedMean: number;
  realizedRate: number;
  brier: number;
  eceProxy: number;
  reason: string;
  manualRecoveryRequired: boolean;
}

interface WindowPoint {
  predicted: number;
  actual: 0 | 1;
}

const LEVEL_ACTIONS: Record<DivergenceLevel, DivergenceActions> = {
  0: {
    disableDynamicThresholds: false,
    disableMultiTargetSwitch: false,
    disableKelly: false,
    lockConservativeBaseline: false,
    fullSheathHaltEntries: false,
  },
  1: {
    disableDynamicThresholds: true,
    disableMultiTargetSwitch: false,
    disableKelly: false,
    lockConservativeBaseline: false,
    fullSheathHaltEntries: false,
  },
  2: {
    disableDynamicThresholds: true,
    disableMultiTargetSwitch: true,
    disableKelly: false,
    lockConservativeBaseline: false,
    fullSheathHaltEntries: false,
  },
  3: {
    disableDynamicThresholds: true,
    disableMultiTargetSwitch: true,
    disableKelly: true,
    lockConservativeBaseline: false,
    fullSheathHaltEntries: false,
  },
  4: {
    disableDynamicThresholds: true,
    disableMultiTargetSwitch: true,
    disableKelly: true,
    lockConservativeBaseline: true,
    fullSheathHaltEntries: false,
  },
  5: {
    disableDynamicThresholds: true,
    disableMultiTargetSwitch: true,
    disableKelly: true,
    lockConservativeBaseline: true,
    fullSheathHaltEntries: true,
  },
};

export class LiveDivergenceMonitor {
  private readonly window: WindowPoint[] = [];
  private readonly maxWindow: number;
  private level: DivergenceLevel = 0;
  private manualRecoveryRequired = false;
  private lastReason = 'ok';
  /** After manual recovery, suppress auto-escalate until this many new observes */
  private recoveryGraceRemaining = 0;

  constructor(maxWindow = 2000) {
    this.maxWindow = maxWindow;
  }

  observe(predicted: number, actual: 0 | 1): DivergenceSnapshot {
    this.window.push({
      predicted: Math.min(0.99, Math.max(0.01, predicted)),
      actual,
    });
    if (this.window.length > this.maxWindow) {
      this.window.shift();
    }
    if (this.recoveryGraceRemaining > 0) this.recoveryGraceRemaining -= 1;
    return this.evaluate();
  }

  evaluate(): DivergenceSnapshot {
    const n = this.window.length;
    if (n < 50) {
      return this.snapshot(0, 'insufficient-window');
    }

    let sumP = 0;
    let sumA = 0;
    let brier = 0;
    const bins = Array.from({ length: 10 }, () => ({ c: 0, sp: 0, sa: 0 }));
    for (const w of this.window) {
      sumP += w.predicted;
      sumA += w.actual;
      brier += (w.predicted - w.actual) ** 2;
      const idx = Math.min(9, Math.floor(w.predicted * 10));
      bins[idx].c += 1;
      bins[idx].sp += w.predicted;
      bins[idx].sa += w.actual;
    }
    const predictedMean = sumP / n;
    const realizedRate = sumA / n;
    brier /= n;
    let ece = 0;
    for (const b of bins) {
      if (b.c === 0) continue;
      ece += (b.c / n) * Math.abs(b.sp / b.c - b.sa / b.c);
    }
    const gap = predictedMean - realizedRate;

    // Progressive levels (only escalate automatically; de-escalate only via manual recovery)
    let newLevel: DivergenceLevel = this.level;
    if (!this.manualRecoveryRequired && this.recoveryGraceRemaining <= 0) {
      if (ece > 0.12 || gap > 0.12 || brier > 0.35) newLevel = 5;
      else if (ece > 0.1 || gap > 0.1 || brier > 0.3) newLevel = 4;
      else if (ece > 0.08 || gap > 0.08) newLevel = 3;
      else if (ece > 0.06 || gap > 0.06) newLevel = 2;
      else if (ece > 0.05 || gap > 0.05) newLevel = 1;
      else newLevel = 0;
    }

    if (newLevel > this.level) {
      this.level = newLevel;
      if (newLevel >= 3) this.manualRecoveryRequired = true;
      this.lastReason = `escalate ece=${ece.toFixed(3)} gap=${gap.toFixed(3)} brier=${brier.toFixed(3)}`;
    } else if (newLevel < this.level && !this.manualRecoveryRequired) {
      this.level = newLevel;
      this.lastReason = `improve ece=${ece.toFixed(3)} gap=${gap.toFixed(3)}`;
    } else {
      this.lastReason = `hold ece=${ece.toFixed(3)} gap=${gap.toFixed(3)} brier=${brier.toFixed(3)}`;
    }

    return this.snapshot(this.level, this.lastReason, {
      predictedMean,
      realizedRate,
      brier,
      eceProxy: ece,
    });
  }

  /** Manual recovery only — never automatic from "it got better" */
  manualRecover(confirm: true): DivergenceSnapshot {
    if (confirm !== true) {
      throw new Error('manualRecover requires explicit confirm=true');
    }
    this.manualRecoveryRequired = false;
    this.level = 0;
    this.recoveryGraceRemaining = Math.min(this.maxWindow, 100);
    this.lastReason = 'manual-recovery';
    // Do not immediately re-evaluate escalation on stale window
    return this.snapshot(0, 'manual-recovery');
  }

  getLevel(): DivergenceLevel {
    return this.level;
  }

  getActions(): DivergenceActions {
    return { ...LEVEL_ACTIONS[this.level] };
  }

  private snapshot(
    level: DivergenceLevel,
    reason: string,
    metrics?: { predictedMean: number; realizedRate: number; brier: number; eceProxy: number }
  ): DivergenceSnapshot {
    return {
      level,
      actions: { ...LEVEL_ACTIONS[level] },
      windowSize: this.window.length,
      predictedMean: metrics?.predictedMean ?? 0,
      realizedRate: metrics?.realizedRate ?? 0,
      brier: metrics?.brier ?? 0,
      eceProxy: metrics?.eceProxy ?? 0,
      reason,
      manualRecoveryRequired: this.manualRecoveryRequired,
    };
  }
}

export const globalLiveDivergence = new LiveDivergenceMonitor();
