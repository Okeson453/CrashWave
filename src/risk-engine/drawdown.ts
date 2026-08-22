/**
 * DrawdownCalculator tracks peak equity, consecutive losses, and true
 * peak-to-trough drawdown percentage. Emits alerts when thresholds are breached.
 */

export interface DrawdownStats {
  consecutiveLosses: number;
  totalDrawdown: number;
  /** Current peak-to-trough drawdown as a percentage of peak equity (0–100) */
  drawdownPercent: number;
  peakEquity: number;
  currentEquity: number;
  shouldAlert: boolean;
  /** True when percentage drawdown exceeds configured max */
  percentBreach: boolean;
}

export interface DrawdownCalculatorOptions {
  /** Consecutive losses before alert */
  alertThreshold: number;
  /** Max allowed peak-to-trough drawdown percent (e.g. 20 = 20%) */
  maxDrawdownPercent: number;
  /** Nominal stake used for absolute drawdown context */
  stake: number;
  /** Starting equity / balance for peak tracking */
  initialEquity?: number;
}

export class DrawdownCalculator {
  private consecutiveLosses = 0;
  private totalDrawdown = 0;
  private peakEquity: number;
  private currentEquity: number;
  private readonly alertThreshold: number;
  private readonly maxDrawdownPercent: number;
  private readonly stake: number;

  constructor(options: DrawdownCalculatorOptions) {
    this.alertThreshold = options.alertThreshold;
    this.maxDrawdownPercent = options.maxDrawdownPercent;
    this.stake = options.stake;
    const initial = options.initialEquity ?? 0;
    this.peakEquity = initial;
    this.currentEquity = initial;
  }

  /**
   * Update the absolute equity figure (e.g. after balance reconciliation).
   * Peak is raised only when equity exceeds the previous peak.
   */
  updateEquity(equity: number): void {
    this.currentEquity = equity;
    if (equity > this.peakEquity) {
      this.peakEquity = equity;
    }
  }

  recordLoss(amount: number): void {
    this.consecutiveLosses++;
    this.totalDrawdown += amount;
    this.currentEquity = Math.max(0, this.currentEquity - amount);
    // Peak is not lowered on loss
  }

  recordWin(profit: number): void {
    this.consecutiveLosses = 0;
    this.totalDrawdown = Math.max(0, this.totalDrawdown - profit);
    this.currentEquity += profit;
    if (this.currentEquity > this.peakEquity) {
      this.peakEquity = this.currentEquity;
    }
  }

  /** Reset consecutive-loss streak without changing equity */
  resetStreak(): void {
    this.consecutiveLosses = 0;
  }

  getDrawdownPercent(): number {
    if (this.peakEquity <= 0) {
      // Fall back to stake-based estimate when peak is unknown
      if (this.stake <= 0) return 0;
      return Math.min(100, (this.totalDrawdown / this.stake) * 100);
    }
    const trough = this.peakEquity - this.currentEquity;
    if (trough <= 0) return 0;
    return Math.min(100, (trough / this.peakEquity) * 100);
  }

  getStats(): DrawdownStats {
    const drawdownPercent = this.getDrawdownPercent();
    const percentBreach = drawdownPercent >= this.maxDrawdownPercent;
    const consecutiveBreach = this.consecutiveLosses >= this.alertThreshold;

    return {
      consecutiveLosses: this.consecutiveLosses,
      totalDrawdown: this.totalDrawdown,
      drawdownPercent: Math.round(drawdownPercent * 100) / 100,
      peakEquity: this.peakEquity,
      currentEquity: this.currentEquity,
      shouldAlert: consecutiveBreach || percentBreach,
      percentBreach,
    };
  }
}
