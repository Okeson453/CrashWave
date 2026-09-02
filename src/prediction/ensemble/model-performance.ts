/**
 * Per-model online performance — EWMA log-loss / Brier for weighting.
 */

export interface ModelPerf {
  ewmaLogLoss: number;
  ewmaBrier: number;
  count: number;
  recentCorrect: number;
  recentTotal: number;
}

const ALPHA = 0.05;

export class ModelPerformanceTracker {
  private readonly models = new Map<string, ModelPerf>();

  ensure(name: string): ModelPerf {
    let p = this.models.get(name);
    if (!p) {
      p = { ewmaLogLoss: 0.5, ewmaBrier: 0.25, count: 0, recentCorrect: 0, recentTotal: 0 };
      this.models.set(name, p);
    }
    return p;
  }

  observe(name: string, probability: number, actual: 0 | 1): void {
    const p = this.ensure(name);
    const q = Math.min(0.999, Math.max(0.001, probability));
    const ll = actual === 1 ? -Math.log(q) : -Math.log(1 - q);
    const br = (q - actual) ** 2;
    p.ewmaLogLoss = ALPHA * ll + (1 - ALPHA) * p.ewmaLogLoss;
    p.ewmaBrier = ALPHA * br + (1 - ALPHA) * p.ewmaBrier;
    p.count += 1;
    p.recentTotal += 1;
    if ((q >= 0.5 && actual === 1) || (q < 0.5 && actual === 0)) p.recentCorrect += 1;
    if (p.recentTotal > 200) {
      p.recentCorrect = Math.floor(p.recentCorrect * 0.9);
      p.recentTotal = Math.floor(p.recentTotal * 0.9);
    }
  }

  get(name: string): ModelPerf | undefined {
    return this.models.get(name);
  }

  all(): Map<string, ModelPerf> {
    return this.models;
  }
}

export const globalModelPerformance = new ModelPerformanceTracker();
