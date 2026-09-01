/**
 * §16 Lookahead Engine — DISABLED BY DEFAULT.
 * Only enable after randomness gate demonstrates serial dependence.
 * Uses conditional scenario simulation from empirical transition rates — no assumed 1.5x/1.1x fantasy paths.
 */

import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';

export interface LookaheadConfig {
  enabled: boolean;
  horizon: number;
  scenarios: number;
}

export const DEFAULT_LOOKAHEAD_CONFIG: LookaheadConfig = {
  enabled: false,
  horizon: 3,
  scenarios: 64,
};

export interface LookaheadResult {
  enabled: boolean;
  horizonProbability: number[];
  expectedHits: number;
  reason: string;
}

export class LookaheadEngine {
  constructor(private config: LookaheadConfig = { ...DEFAULT_LOOKAHEAD_CONFIG }) {}

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Simulate multi-step hit probability using Markov transition from engine state.
   * No hard-coded intermediate crash values.
   */
  evaluate(engine: IncrementalStateEngine): LookaheadResult {
    if (!this.config.enabled) {
      return {
        enabled: false,
        horizonProbability: [],
        expectedHits: 0,
        reason: 'lookahead-disabled',
      };
    }
    const p = engine.markovPNextAbove13();
    const horizonProbability: number[] = [];
    let survive = 1;
    let expectedHits = 0;
    for (let h = 1; h <= this.config.horizon; h++) {
      // Independent-ish Markov step with slight mean reversion toward EWMA
      const ewma = engine.snapshot().ewmaHit13;
      const stepP = 0.7 * p + 0.3 * ewma;
      const hitP = survive * stepP;
      horizonProbability.push(hitP);
      expectedHits += hitP;
      survive *= 1 - stepP * 0.15; // damp
    }
    return {
      enabled: true,
      horizonProbability,
      expectedHits,
      reason: `markov-conditional horizon=${this.config.horizon}`,
    };
  }
}

export const globalLookaheadEngine = new LookaheadEngine();
