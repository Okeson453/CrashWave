/**
 * TPL — Temporal Pattern Learning
 * Learns conditional P(crash ≥ 1.30 | sequence state) vs baseline — empirical, not hard-coded rules.
 */

import { ACIE_TARGET, SequenceState, SOLRecord, RegimeLabel } from './types.js';

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function hitRate(cps: number[], n: number): number {
  const slice = cps.slice(-n);
  if (slice.length === 0) return 0;
  return slice.filter((c) => c >= ACIE_TARGET).length / slice.length;
}

export class TemporalPatternLearner {
  /**
   * Build sequence state from ordered crash points (oldest → newest).
   */
  computeSequenceState(crashPoints: number[]): SequenceState {
    const last10 = crashPoints.slice(-10);
    const last10Reached130 = last10.filter((c) => c >= ACIE_TARGET).length;
    const last10AvgCrash = mean(last10);

    let currentStreakBelow130 = 0;
    let currentStreakAbove130 = 0;
    for (let i = crashPoints.length - 1; i >= 0; i--) {
      if (crashPoints[i] < ACIE_TARGET) {
        if (currentStreakAbove130 > 0) break;
        currentStreakBelow130++;
      } else {
        if (currentStreakBelow130 > 0) break;
        currentStreakAbove130++;
      }
    }

    const lowClusterActive = currentStreakBelow130 >= 3;
    const lowClusterLength = lowClusterActive ? currentStreakBelow130 : 0;
    const clusterSlice = crashPoints.slice(-Math.max(lowClusterLength, 1));
    const lowClusterSeverity = lowClusterActive ? mean(clusterSlice) : 0;

    const last50 = crashPoints.slice(-50).map((c) => Math.log(Math.max(c, 1.01)));
    const prev50 = crashPoints.slice(-100, -50).map((c) => Math.log(Math.max(c, 1.01)));
    const recentVolatility = stddev(last50);
    const prevVol = stddev(prev50);
    let volatilityTrend: SequenceState['volatilityTrend'] = 'stable';
    if (prev50.length >= 10) {
      if (recentVolatility > prevVol * 1.15) volatilityTrend = 'increasing';
      else if (recentVolatility < prevVol * 0.85) volatilityTrend = 'decreasing';
    }

    return {
      last10Reached130,
      last10AvgCrash,
      currentStreakBelow130,
      currentStreakAbove130,
      lowClusterActive,
      lowClusterLength,
      lowClusterSeverity,
      rolling100HitRate: hitRate(crashPoints, 100),
      rolling500HitRate: hitRate(crashPoints, 500),
      rolling1000HitRate: hitRate(crashPoints, 1000),
      recentVolatility,
      volatilityTrend,
    };
  }

  /**
   * Map sequence features to a regime label (descriptive, not predictive).
   */
  detectRegime(state: SequenceState): RegimeLabel {
    if (state.recentVolatility > 1.2 && state.volatilityTrend === 'increasing') return 'volatile';
    if (state.lowClusterActive && state.lowClusterLength >= 5) return 'deep-low';
    if (state.lowClusterActive) return 'low-cluster';
    if (state.rolling100HitRate > 0.75) return 'high-activity';
    if (state.rolling100HitRate < 0.45 && state.currentStreakBelow130 >= 2) return 'deep-low';
    return 'normal';
  }

  /**
   * Empirical conditional P(≥1.30 | similar sequence) vs unconditional baseline.
   * Falls back to baseline when matching sample is too small.
   */
  computeConditionalProbability(
    sequenceState: SequenceState,
    history: SOLRecord[],
    minMatches = 50
  ): { conditional: number; baseline: number; improvement: number; matchCount: number } {
    if (history.length === 0) {
      return { conditional: 0.65, baseline: 0.65, improvement: 0, matchCount: 0 };
    }
    const baseline = history.filter((r) => r.reached130).length / history.length;

    const matching = history.filter((r) => {
      const s = r.sequenceState;
      return (
        Math.abs(s.currentStreakBelow130 - sequenceState.currentStreakBelow130) <= 1 &&
        Math.abs(s.lowClusterLength - sequenceState.lowClusterLength) <= 1 &&
        (s.lowClusterActive === sequenceState.lowClusterActive ||
          sequenceState.lowClusterLength <= 1)
      );
    });

    const conditional =
      matching.length >= minMatches
        ? matching.filter((r) => r.reached130).length / matching.length
        : baseline;

    return {
      conditional,
      baseline,
      improvement: conditional - baseline,
      matchCount: matching.length,
    };
  }
}
