/** Concept drift via short vs long Brier comparison. */

export class ConceptDriftMonitor {
  private short: number[] = [];
  private long: number[] = [];
  private readonly shortN: number;
  private readonly longN: number;

  constructor(shortN = 50, longN = 200) {
    this.shortN = shortN;
    this.longN = longN;
  }

  observe(predicted: number, actual: 0 | 1): {
    detected: boolean;
    brierShort: number;
    brierLong: number;
    reason: string;
  } {
    const sq = (predicted - actual) ** 2;
    this.short.push(sq);
    this.long.push(sq);
    if (this.short.length > this.shortN) this.short.shift();
    if (this.long.length > this.longN) this.long.shift();

    if (this.long.length < this.longN) {
      return { detected: false, brierShort: 0, brierLong: 0, reason: 'warming' };
    }
    const brierShort = avg(this.short);
    const brierLong = avg(this.long);
    const detected = brierShort > brierLong * 1.35 && brierShort - brierLong > 0.03;
    return {
      detected,
      brierShort,
      brierLong,
      reason: detected ? 'short-brier-elevated' : 'stable',
    };
  }
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export const globalConceptDrift = new ConceptDriftMonitor();
