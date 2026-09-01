/** Prediction distribution drift (predicted mean shift). */

export class PredictionDriftMonitor {
  private baselineMean = 0.65;
  private ewmaMean = 0.65;
  private n = 0;
  private readonly alpha: number;
  private readonly threshold: number;

  constructor(alpha = 0.05, threshold = 0.08) {
    this.alpha = alpha;
    this.threshold = threshold;
  }

  setBaseline(mean: number): void {
    this.baselineMean = mean;
    this.ewmaMean = mean;
  }

  observe(probability: number): { drifted: boolean; delta: number } {
    this.n += 1;
    this.ewmaMean = this.alpha * probability + (1 - this.alpha) * this.ewmaMean;
    const delta = Math.abs(this.ewmaMean - this.baselineMean);
    return { drifted: this.n > 80 && delta > this.threshold, delta };
  }
}

export const globalPredictionDrift = new PredictionDriftMonitor();
