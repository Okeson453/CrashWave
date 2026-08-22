import { PnlEntry, PnlSummary, EquityPoint } from './types';

/**
 * PnlCalculator computes realized vs expected P&L, equity curves,
 * drawdowns, streaks, and expected value.
 *
 * All calculations are deterministic and pure — no side effects.
 * The calculator operates on an array of PnlEntry records and
 * produces a PnlSummary plus an equity curve.
 *
 * Mathematical model:
 * - Profit on win: stake * (target - 1)
 * - Loss on loss: -stake
 * - Break-even hit rate: 1 / target
 * - EV per entry: stake * (hit_rate * target - 1)
 */
export class PnlCalculator {
  private readonly stake: number;
  private readonly target: number;

  constructor(stake: number = 700, target: number = 1.30) {
    this.stake = stake;
    this.target = target;
  }

  /**
   * Calculate the break-even hit rate for the configured target.
   */
  getBreakEvenHitRate(): number {
    return 1 / this.target;
  }

  /**
   * Calculate profit for a single winning bet.
   */
  calculateWinProfit(): number {
    return this.stake * (this.target - 1);
  }

  /**
   * Calculate loss for a single losing bet.
   */
  calculateLoss(): number {
    return -this.stake;
  }

  /**
   * Calculate expected value per entry given a hit rate.
   */
  calculateExpectedValue(hitRate: number): number {
    return this.stake * (hitRate * this.target - 1);
  }

  /**
   * Compute a full P&L summary from a series of entries.
   */
  computeSummary(entries: PnlEntry[]): PnlSummary {
    if (entries.length === 0) {
      return this.emptySummary();
    }

    let wins = 0;
    let losses = 0;
    let failed = 0;
    let unknown = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    let winStreakMax = 0;
    let lossStreakMax = 0;
    let currentWinStreak = 0;
    let currentLossStreak = 0;

    for (const entry of entries) {
      switch (entry.outcome) {
        case 'win':
          wins++;
          grossProfit += entry.pnl;
          currentWinStreak++;
          currentLossStreak = 0;
          winStreakMax = Math.max(winStreakMax, currentWinStreak);
          break;
        case 'loss':
          losses++;
          grossLoss += entry.pnl;
          currentLossStreak++;
          currentWinStreak = 0;
          lossStreakMax = Math.max(lossStreakMax, currentLossStreak);
          break;
        case 'failed':
          failed++;
          currentWinStreak = 0;
          currentLossStreak = 0;
          break;
        case 'unknown':
          unknown++;
          currentWinStreak = 0;
          currentLossStreak = 0;
          break;
      }
    }

    const totalBets = entries.length;
    const netPnl = grossProfit + grossLoss;
    const hitRate = wins + losses > 0 ? wins / (wins + losses) : 0;

    const { maxDrawdown, currentDrawdown } = this.computeDrawdown(entries);

    const averageWin = wins > 0 ? grossProfit / wins : 0;
    const averageLoss = losses > 0 ? grossLoss / losses : 0;

    const currentStreakType: 'win' | 'loss' | 'none' =
      currentWinStreak > 0 ? 'win' : currentLossStreak > 0 ? 'loss' : 'none';
    const currentStreak = currentWinStreak > 0 ? currentWinStreak : currentLossStreak;

    return {
      totalBets,
      wins,
      losses,
      failed,
      unknown,
      grossProfit,
      grossLoss,
      netPnl,
      hitRate,
      breakEvenHitRate: this.getBreakEvenHitRate(),
      maxDrawdown,
      currentDrawdown,
      averageWin,
      averageLoss,
      expectedValue: this.calculateExpectedValue(hitRate),
      winStreakMax,
      lossStreakMax,
      currentStreak,
      currentStreakType,
    };
  }

  /**
   * Build the equity curve from a series of entries.
   */
  buildEquityCurve(entries: PnlEntry[]): EquityPoint[] {
    const curve: EquityPoint[] = [];
    let cumulativePnl = 0;
    let peakPnl = 0;

    for (const entry of entries) {
      if (entry.outcome === 'win' || entry.outcome === 'loss') {
        cumulativePnl += entry.pnl;
      }
      // Failed and unknown bets don't change P&L

      peakPnl = Math.max(peakPnl, cumulativePnl);
      const currentDrawdown = peakPnl - cumulativePnl;

      curve.push({
        timestamp: entry.timestamp,
        cumulativePnl,
        peakPnl,
        currentDrawdown,
        betId: entry.betId,
      });
    }

    return curve;
  }

  /**
   * Compute max and current drawdown from entries.
   */
  computeDrawdown(entries: PnlEntry[]): { maxDrawdown: number; currentDrawdown: number } {
    let cumulativePnl = 0;
    let peakPnl = 0;
    let maxDrawdown = 0;

    for (const entry of entries) {
      if (entry.outcome === 'win' || entry.outcome === 'loss') {
        cumulativePnl += entry.pnl;
      }
      peakPnl = Math.max(peakPnl, cumulativePnl);
      const drawdown = peakPnl - cumulativePnl;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    const currentDrawdown = peakPnl - cumulativePnl;
    return { maxDrawdown, currentDrawdown };
  }

  /**
   * Compute drawdown from an existing equity curve.
   */
  computeDrawdownFromCurve(curve: EquityPoint[]): { maxDrawdown: number; currentDrawdown: number } {
    if (curve.length === 0) return { maxDrawdown: 0, currentDrawdown: 0 };
    const maxDrawdown = Math.max(...curve.map((p) => p.currentDrawdown));
    const currentDrawdown = curve[curve.length - 1].currentDrawdown;
    return { maxDrawdown, currentDrawdown };
  }

  /**
   * Simulate dry-run P&L for a series of hypothetical bets.
   * Each entry needs only the crash point; the calculator determines
   * whether the bet would have won (crash_point >= target).
   */
  simulateDryRun(crashPoints: number[]): PnlSummary {
    const entries: PnlEntry[] = crashPoints.map((crashPoint, index) => {
      const won = crashPoint >= this.target;
      return {
        betId: `dry-run-${index}`,
        roundId: `dry-run-round-${index}`,
        dailyKey: 'dry-run',
        stake: this.stake,
        target: this.target,
        outcome: won ? 'win' : 'loss',
        pnl: won ? this.calculateWinProfit() : this.calculateLoss(),
        cashOutMultiplier: won ? this.target : null,
        timestamp: new Date().toISOString(),
      };
    });

    return this.computeSummary(entries);
  }

  /**
   * Simulate 100 dry-run entries and return the summary.
   * This is the standard dry-run validation test.
   */
  simulate100Entries(crashPoints: number[]): PnlSummary {
    const points = crashPoints.slice(0, 100);
    if (points.length < 100) {
      throw new Error(`Need 100 crash points for simulation, got ${points.length}`);
    }
    return this.simulateDryRun(points);
  }

  /**
   * Compute rolling window statistics.
   */
  computeRollingWindows(entries: PnlEntry[], windowSizes: number[] = [10, 50, 100, 500]): Record<number, PnlSummary> {
    const results: Record<number, PnlSummary> = {};

    for (const size of windowSizes) {
      if (entries.length >= size) {
        const window = entries.slice(-size);
        results[size] = this.computeSummary(window);
      }
    }

    return results;
  }

  private emptySummary(): PnlSummary {
    return {
      totalBets: 0,
      wins: 0,
      losses: 0,
      failed: 0,
      unknown: 0,
      grossProfit: 0,
      grossLoss: 0,
      netPnl: 0,
      hitRate: 0,
      breakEvenHitRate: this.getBreakEvenHitRate(),
      maxDrawdown: 0,
      currentDrawdown: 0,
      averageWin: 0,
      averageLoss: 0,
      expectedValue: 0,
      winStreakMax: 0,
      lossStreakMax: 0,
      currentStreak: 0,
      currentStreakType: 'none',
    };
  }
}
