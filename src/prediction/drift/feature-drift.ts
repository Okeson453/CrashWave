/** PSI / population drift on feature means (simple EWMA detector). */

export class FeatureDriftMonitor {
  private baseline: Record<string, number> = {};
  private ewma: Record<string, number> = {};
  private readonly alpha: number;
  private readonly threshold: number;
  private observations = 0;

  constructor(alpha = 0.02, threshold = 0.25) {
    this.alpha = alpha;
    this.threshold = threshold;
  }

  setBaseline(features: Record<string, number>): void {
    this.baseline = { ...features };
    this.ewma = { ...features };
  }

  observe(features: Record<string, number>): { drifted: boolean; maxDelta: number; key?: string } {
    this.observations += 1;
    let maxDelta = 0;
    let key: string | undefined;
    for (const [k, v] of Object.entries(features)) {
      if (!Number.isFinite(v)) continue;
      const prev = this.ewma[k] ?? v;
      this.ewma[k] = this.alpha * v + (1 - this.alpha) * prev;
      const base = this.baseline[k];
      if (base === undefined) continue;
      const scale = Math.max(1e-6, Math.abs(base));
      const delta = Math.abs(this.ewma[k] - base) / scale;
      if (delta > maxDelta) {
        maxDelta = delta;
        key = k;
      }
    }
    const drifted = this.observations > 100 && maxDelta > this.threshold;
    return { drifted, maxDelta, key };
  }
}

export const globalFeatureDrift = new FeatureDriftMonitor();
