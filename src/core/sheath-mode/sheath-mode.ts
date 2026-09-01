/**
 * Sheath Mode state machine.
 * Design ref: Section 4.2–4.6
 *
 * NORMAL → (trigger) → SHEATH_EVALUATING → SHEATH_ACTIVE
 *                     ↘ false alarm → NORMAL
 * SHEATH_ACTIVE → SHEATH_RECOVERING → (validation) → NORMAL
 *                                  ↘ fail ×3 → SHEATH_PERSISTENT
 */

import { EventEmitter } from 'events';
import { getLogger } from '../../observability/logger';
import type {
  SheathState,
  SheathTrigger,
  SheathTransition,
  SheathModeSnapshot,
  RecoveryCheckResult,
  SheathSeverity,
} from './types';

export interface SheathModeOptions {
  /** Rounds to evaluate high-severity triggers before promoting */
  evaluateHighRounds?: number;
  /** Rounds to evaluate medium-severity triggers */
  evaluateMediumRounds?: number;
  /** Consecutive good rounds required to exit RECOVERING */
  recoveryRequiredRounds?: number;
  /** Failed recovery attempts before PERSISTENT */
  maxRecoveryAttempts?: number;
}

const DEFAULTS = {
  evaluateHighRounds: 3,
  evaluateMediumRounds: 5,
  recoveryRequiredRounds: 10,
  maxRecoveryAttempts: 3,
};

export class SheathMode extends EventEmitter {
  private readonly logger = getLogger();
  private state: SheathState = 'NORMAL';
  private activeTriggers: SheathTrigger[] = [];
  private evaluatingSince: string | null = null;
  private recoveringSince: string | null = null;
  private recoveryAttempts = 0;
  private consecutiveRecoveryRounds = 0;
  private evaluateRoundCount = 0;
  private lastTransition: SheathTransition | null = null;
  private readonly opts: Required<SheathModeOptions>;

  constructor(options: SheathModeOptions = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
  }

  getState(): SheathState {
    return this.state;
  }

  isBettingSuspended(): boolean {
    return this.state !== 'NORMAL';
  }

  isIntelligenceActive(): boolean {
    // Intelligence continues in all sheath states
    return true;
  }

  snapshot(): SheathModeSnapshot {
    return {
      state: this.state,
      activeTriggers: [...this.activeTriggers],
      evaluatingSince: this.evaluatingSince,
      recoveringSince: this.recoveringSince,
      recoveryAttempts: this.recoveryAttempts,
      consecutiveRecoveryRounds: this.consecutiveRecoveryRounds,
      lastTransition: this.lastTransition,
      bettingSuspended: this.isBettingSuspended(),
      intelligenceActive: this.isIntelligenceActive(),
    };
  }

  /**
   * Report one or more triggers. Critical → immediate ACTIVE.
   * High/Medium → EVALUATING then promote if still present.
   */
  reportTriggers(triggers: SheathTrigger[]): void {
    if (triggers.length === 0) return;

    for (const t of triggers) {
      const existing = this.activeTriggers.find((x) => x.id === t.id);
      if (!existing) this.activeTriggers.push(t);
      else Object.assign(existing, t);
    }

    const maxSeverity = this.maxSeverity(this.activeTriggers);

    if (this.state === 'NORMAL') {
      if (maxSeverity === 'critical' || maxSeverity === 'manual') {
        this.transition('SHEATH_ACTIVE', triggers);
      } else {
        this.transition('SHEATH_EVALUATING', triggers);
        this.evaluatingSince = new Date().toISOString();
        this.evaluateRoundCount = 0;
      }
    } else if (this.state === 'SHEATH_EVALUATING') {
      if (maxSeverity === 'critical' || maxSeverity === 'manual') {
        this.transition('SHEATH_ACTIVE', triggers);
      }
    } else if (this.state === 'SHEATH_RECOVERING') {
      // New triggers during recovery → back to ACTIVE
      if (maxSeverity === 'critical' || maxSeverity === 'high') {
        this.consecutiveRecoveryRounds = 0;
        this.transition('SHEATH_ACTIVE', triggers);
      }
    }
  }

  /** Operator `/sheath` */
  operatorSheath(): void {
    this.reportTriggers([
      {
        id: 'operator_command',
        severity: 'manual',
        message: 'Operator issued /sheath',
        detectedAt: new Date().toISOString(),
      },
    ]);
  }

  /**
   * Operator `/unsheath` — only initiates recovery, never forces NORMAL.
   */
  operatorUnsheath(): void {
    if (this.state === 'SHEATH_ACTIVE' || this.state === 'SHEATH_PERSISTENT') {
      this.transition('SHEATH_RECOVERING', [], '/unsheath');
      this.recoveringSince = new Date().toISOString();
      this.consecutiveRecoveryRounds = 0;
    } else if (this.state === 'SHEATH_EVALUATING') {
      // Cancel evaluation → NORMAL if no remaining critical triggers
      this.activeTriggers = this.activeTriggers.filter((t) => t.severity === 'critical');
      if (this.activeTriggers.length === 0) {
        this.transition('NORMAL', [], '/unsheath');
        this.evaluatingSince = null;
        this.evaluateRoundCount = 0;
      }
    }
  }

  /**
   * Called once per round (or on a timer) while in EVALUATING / RECOVERING.
   * `recoveryChecks` supplied by Monitoring / Learning workers.
   */
  onRoundTick(recoveryChecks?: RecoveryCheckResult[]): void {
    if (this.state === 'SHEATH_EVALUATING') {
      this.evaluateRoundCount += 1;
      const maxSev = this.maxSeverity(this.activeTriggers);
      const threshold =
        maxSev === 'medium' ? this.opts.evaluateMediumRounds : this.opts.evaluateHighRounds;

      if (this.evaluateRoundCount >= threshold) {
        // Still have triggers → promote
        if (this.activeTriggers.length > 0) {
          this.transition('SHEATH_ACTIVE', this.activeTriggers);
        } else {
          this.transition('NORMAL', []);
          this.evaluatingSince = null;
          this.evaluateRoundCount = 0;
        }
      }
    } else if (this.state === 'SHEATH_RECOVERING') {
      if (!recoveryChecks || recoveryChecks.length === 0) return;

      const allPassed = recoveryChecks.every((c) => c.passed);
      if (allPassed) {
        this.consecutiveRecoveryRounds += 1;
        if (this.consecutiveRecoveryRounds >= this.opts.recoveryRequiredRounds) {
          this.activeTriggers = [];
          this.transition('NORMAL', [], undefined, recoveryChecks);
          this.recoveringSince = null;
          this.recoveryAttempts = 0;
          this.consecutiveRecoveryRounds = 0;
        }
      } else {
        this.consecutiveRecoveryRounds = 0;
        this.recoveryAttempts += 1;
        if (this.recoveryAttempts >= this.opts.maxRecoveryAttempts) {
          this.transition('SHEATH_PERSISTENT', this.activeTriggers, undefined, recoveryChecks);
        }
      }
    }
  }

  /** Clear a specific trigger (e.g. condition resolved) */
  clearTrigger(id: string): void {
    this.activeTriggers = this.activeTriggers.filter((t) => t.id !== id);
    if (
      this.state === 'SHEATH_ACTIVE' &&
      this.activeTriggers.length === 0 &&
      !this.activeTriggers.some((t) => t.severity === 'manual')
    ) {
      // Auto-start recovery when all automatic triggers clear
      this.transition('SHEATH_RECOVERING', []);
      this.recoveringSince = new Date().toISOString();
      this.consecutiveRecoveryRounds = 0;
    }
  }

  private transition(
    next: SheathState,
    triggers: SheathTrigger[],
    operatorCommand?: string,
    recoveryResults?: RecoveryCheckResult[]
  ): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    const transition: SheathTransition = {
      previous,
      next,
      triggers,
      timestamp: new Date().toISOString(),
      operatorCommand,
      recoveryResults,
    };
    this.lastTransition = transition;
    this.logger.warn(
      {
        component: 'SheathMode',
        previous,
        next,
        triggers: triggers.map((t) => t.id),
        operatorCommand,
      },
      `Sheath mode transition: ${previous} → ${next}`
    );
    this.emit('transition', transition);
  }

  private maxSeverity(triggers: SheathTrigger[]): SheathSeverity | null {
    if (triggers.some((t) => t.severity === 'manual')) return 'manual';
    if (triggers.some((t) => t.severity === 'critical')) return 'critical';
    if (triggers.some((t) => t.severity === 'high')) return 'high';
    if (triggers.some((t) => t.severity === 'medium')) return 'medium';
    return null;
  }
  /**
   * Integrate live prediction divergence / calibration health (design §25–26).
   * Level 3+ → high severity evaluating; level 5 → critical immediate active.
   */
  reportPredictionHealth(input: {
    divergenceLevel: number;
    ece?: number;
    reason?: string;
    coldState?: boolean;
  }): void {
    const triggers: SheathTrigger[] = [];
    const now = new Date().toISOString();
    if (input.coldState) {
      triggers.push({
        id: 'prediction_cold_state',
        severity: 'critical',
        message: 'Prediction stack cold — live entries blocked',
        detectedAt: now,
        metadata: { coldState: true },
      });
    }
    if (input.ece != null && input.ece > 0.08) {
      triggers.push({
        id: 'prediction_calibration_degraded',
        severity: input.ece > 0.12 ? 'critical' : 'high',
        message: `Calibration ECE=${input.ece.toFixed(3)} above budget`,
        detectedAt: now,
        metadata: { ece: input.ece },
      });
    }
    if (input.divergenceLevel >= 5) {
      triggers.push({
        id: 'prediction_divergence',
        severity: 'critical',
        message: input.reason ?? `Divergence level ${input.divergenceLevel}`,
        detectedAt: now,
        metadata: { level: input.divergenceLevel },
      });
    } else if (input.divergenceLevel >= 3) {
      triggers.push({
        id: 'prediction_divergence',
        severity: 'high',
        message: input.reason ?? `Divergence level ${input.divergenceLevel}`,
        detectedAt: now,
        metadata: { level: input.divergenceLevel },
      });
    } else if (input.divergenceLevel >= 1) {
      triggers.push({
        id: 'poor_prediction_accuracy',
        severity: 'medium',
        message: input.reason ?? `Divergence level ${input.divergenceLevel}`,
        detectedAt: now,
        metadata: { level: input.divergenceLevel },
      });
    }
    if (triggers.length > 0) this.reportTriggers(triggers);
  }

  /** Prediction-driven soft suspend (divergence full sheath) without full state machine */
  isPredictionEntriesBlocked(): boolean {
    return (
      this.activeTriggers.some(
        (t) =>
          (t.id === 'prediction_divergence' && t.severity === 'critical') ||
          t.id === 'prediction_cold_state'
      ) || this.isBettingSuspended()
    );
  }

}
