/**
 * Calibration state — global + per-regime, bounded memory.
 * Ring pairs, capped regimes, infrequent refit (default every 500).
 */

import { IsotonicCalibrator } from './isotonic-calibrator.js';
import { PlattCalibrator } from './platt-calibrator.js';
import {
  emptyBins,
  updateBin,
  expectedCalibrationError,
  brierScore,
  logLoss,
  type ReliabilityBin,
} from './calibration-metrics.js';

export type RegimeKey = string;

interface RegimeCalibrator {
  isotonic: IsotonicCalibrator;
  platt: PlattCalibrator;
  pairs: Array<{ p: number; y: 0 | 1 } | undefined>;
  writeIdx: number;
  pairCount: number;
  bins: ReliabilityBin[];
  brierSum: number;
  logLossSum: number;
  n: number;
}

const DEFAULT_MAX_PAIRS = 2000;
const DEFAULT_MAX_REGIMES = 32;
const DEFAULT_REFIT_EVERY = 500;

function createRegime(maxPairs: number): RegimeCalibrator {
  return {
    isotonic: new IsotonicCalibrator(),
    platt: new PlattCalibrator(),
    pairs: new Array(maxPairs),
    writeIdx: 0,
    pairCount: 0,
    bins: emptyBins(10),
    brierSum: 0,
    logLossSum: 0,
    n: 0,
  };
}

export class CalibrationState {
  readonly version = 'cal-v2';
  private readonly maxPairs: number;
  private readonly maxRegimes: number;
  private refitEvery: number;
  private global: RegimeCalibrator;
  private byRegime = new Map<RegimeKey, RegimeCalibrator>();
  private sinceRefit = 0;

  constructor(opts?: { maxPairs?: number; refitEvery?: number; maxRegimes?: number }) {
    this.maxPairs = opts?.maxPairs ?? DEFAULT_MAX_PAIRS;
    this.maxRegimes = opts?.maxRegimes ?? DEFAULT_MAX_REGIMES;
    this.refitEvery = opts?.refitEvery ?? DEFAULT_REFIT_EVERY;
    this.global = createRegime(this.maxPairs);
  }

  observe(rawProbability: number, actual: 0 | 1, regime: RegimeKey = 'global'): void {
    const p = Math.min(0.999, Math.max(0.001, rawProbability));
    this.record(this.global, p, actual);
    if (regime !== 'global') {
      let reg = this.byRegime.get(regime);
      if (!reg) {
        if (this.byRegime.size >= this.maxRegimes) {
          const first = this.byRegime.keys().next().value;
          if (first !== undefined) this.byRegime.delete(first);
        }
        reg = createRegime(this.maxPairs);
        this.byRegime.set(regime, reg);
      }
      this.record(reg, p, actual);
    }
    this.sinceRefit += 1;
    if (this.sinceRefit >= this.refitEvery) {
      this.refit();
      this.sinceRefit = 0;
    }
  }

  private record(c: RegimeCalibrator, p: number, y: 0 | 1): void {
    c.pairs[c.writeIdx % this.maxPairs] = { p, y };
    c.writeIdx += 1;
    if (c.pairCount < this.maxPairs) c.pairCount += 1;
    updateBin(c.bins, p, y);
    c.brierSum += brierScore(p, y);
    c.logLossSum += logLoss(p, y);
    c.n += 1;
  }

  private pairsArray(c: RegimeCalibrator): Array<{ p: number; y: 0 | 1 }> {
    if (c.pairCount === 0) return [];
    if (c.pairCount < this.maxPairs) {
      return c.pairs.slice(0, c.pairCount).filter(Boolean) as Array<{ p: number; y: 0 | 1 }>;
    }
    const out: Array<{ p: number; y: 0 | 1 }> = [];
    const start = c.writeIdx % this.maxPairs;
    for (let i = 0; i < this.maxPairs; i++) {
      const item = c.pairs[(start + i) % this.maxPairs];
      if (item) out.push(item);
    }
    return out;
  }

  refit(): void {
    this.fitOne(this.global);
    for (const c of this.byRegime.values()) this.fitOne(c);
  }

  private fitOne(c: RegimeCalibrator): void {
    const pairs = this.pairsArray(c);
    if (pairs.length < 20) return;
    c.bins = emptyBins(10);
    c.brierSum = 0;
    c.logLossSum = 0;
    for (const pair of pairs) {
      updateBin(c.bins, pair.p, pair.y);
      c.brierSum += brierScore(pair.p, pair.y);
      c.logLossSum += logLoss(pair.p, pair.y);
    }
    c.n = pairs.length;
    if (pairs.length >= 80) {
      try {
        c.isotonic.fit(pairs);
      } catch { /* */ }
    }
    try {
      c.platt.fit(pairs);
    } catch { /* */ }
  }

  calibrate(rawProbability: number, regime: RegimeKey = 'global'): number {
    const p = Math.min(0.999, Math.max(0.001, rawProbability));
    const reg = this.byRegime.get(regime);
    if (reg?.isotonic.fitted) return reg.isotonic.calibrate(p);
    if (this.global.isotonic.fitted) return this.global.isotonic.calibrate(p);
    if (reg?.platt.fitted) return reg.platt.calibrate(p);
    if (this.global.platt.fitted) return this.global.platt.calibrate(p);
    return p;
  }

  calibrateWithShrinkage(
    rawProbability: number,
    regime: RegimeKey,
    baseline = 0.65,
    sampleCount: number
  ): number {
    const calibrated = this.calibrate(rawProbability, regime);
    const conf = Math.min(1, sampleCount / 200);
    return conf * calibrated + (1 - conf) * baseline;
  }

  metrics(regime: RegimeKey = 'global'): {
    ece: number;
    brier: number;
    logLoss: number;
    n: number;
    version: string;
  } {
    const c = regime === 'global' ? this.global : this.byRegime.get(regime) ?? this.global;
    return {
      ece: expectedCalibrationError(c.bins),
      brier: c.n > 0 ? c.brierSum / c.n : 0,
      logLoss: c.n > 0 ? c.logLossSum / c.n : 0,
      n: c.pairCount || c.n,
      version: this.version,
    };
  }

  isWarm(): boolean {
    return this.global.pairCount >= 30 || this.global.n >= 30;
  }
}

export const globalCalibrationState = new CalibrationState();
