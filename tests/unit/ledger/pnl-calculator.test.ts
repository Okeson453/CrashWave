import { PnlCalculator } from '../../../src/ledger/pnl-calculator';
import { PnlEntry } from '../../../src/ledger/types';
;
describe('PnlCalculator', () => {
  let calc: PnlCalculator;
;
  beforeEach(() => {
    calc = new PnlCalculator(700, 1.30);
  });
;
  describe('basic math', () => {
    it('calculates break-even hit rate correctly', () => {
      expect(calc.getBreakEvenHitRate()).toBeCloseTo(1 / 1.30, 5);
      expect(calc.getBreakEvenHitRate()).toBeCloseTo(0.76923, 4);
    });
;
    it('calculates win profit correctly', () => {
      expect(calc.calculateWinProfit()).toBeCloseTo(210, 5);
    });
;
    it('calculates loss correctly', () => {
      expect(calc.calculateLoss()).toBe(-700);
    });
;
    it('calculates expected value for given hit rate', () => {
      expect(calc.calculateExpectedValue(0.80)).toBeCloseTo(28, 1);
      expect(calc.calculateExpectedValue(1 / 1.30)).toBeCloseTo(0, 5);
      expect(calc.calculateExpectedValue(0.70)).toBeLessThan(0);
    });
;
    it('uses custom stake and target', () => {
      const custom = new PnlCalculator(500, 2.0);
      expect(custom.calculateWinProfit()).toBe(500);
      expect(custom.calculateLoss()).toBe(-500);
      expect(custom.getBreakEvenHitRate()).toBe(0.5);
    });
  });
;
  describe('computeSummary', () => {
    it('returns empty summary for no entries', () => {
      const summary = calc.computeSummary([]);
      expect(summary.totalBets).toBe(0);
      expect(summary.wins).toBe(0);
      expect(summary.losses).toBe(0);
      expect(summary.netPnl).toBe(0);
      expect(summary.hitRate).toBe(0);
      expect(summary.maxDrawdown).toBe(0);
      expect(summary.currentDrawdown).toBe(0);
      expect(summary.winStreakMax).toBe(0);
      expect(summary.lossStreakMax).toBe(0);
      expect(summary.currentStreak).toBe(0);
      expect(summary.currentStreakType).toBe('none');
      expect(summary.breakEvenHitRate).toBeCloseTo(0.76923, 4);
    });
;
    it('computes summary for all wins', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:01:00Z' },
        { betId: '3', roundId: 'r3', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:02:00Z' },
      ];
      const summary = calc.computeSummary(entries);
      expect(summary.totalBets).toBe(3);
      expect(summary.wins).toBe(3);
      expect(summary.losses).toBe(0);
      expect(summary.grossProfit).toBeCloseTo(630, 5);
      expect(summary.netPnl).toBeCloseTo(630, 5);
      expect(summary.hitRate).toBe(1.0);
      expect(summary.averageWin).toBeCloseTo(210, 5);
      expect(summary.maxDrawdown).toBe(0);
      expect(summary.currentDrawdown).toBe(0);
      expect(summary.winStreakMax).toBe(3);
      expect(summary.currentStreakType).toBe('win');
      expect(summary.currentStreak).toBe(3);
    });
;
    it('computes summary for all losses', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:01:00Z' },
      ];
      const summary = calc.computeSummary(entries);
      expect(summary.totalBets).toBe(2);
      expect(summary.wins).toBe(0);
      expect(summary.losses).toBe(2);
      expect(summary.grossLoss).toBe(-1400);
      expect(summary.netPnl).toBe(-1400);
      expect(summary.hitRate).toBe(0);
      expect(summary.maxDrawdown).toBe(1400);
      expect(summary.currentDrawdown).toBe(1400);
      expect(summary.lossStreakMax).toBe(2);
      expect(summary.currentStreakType).toBe('loss');
      expect(summary.currentStreak).toBe(2);
    });
;
    it('computes summary for mixed wins and losses', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:01:00Z' },
        { betId: '3', roundId: 'r3', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:02:00Z' },
      ];
      const summary = calc.computeSummary(entries);
      expect(summary.totalBets).toBe(3);
      expect(summary.wins).toBe(2);
      expect(summary.losses).toBe(1);
      expect(summary.hitRate).toBeCloseTo(2 / 3, 4);
      expect(summary.netPnl).toBeCloseTo(-280, 5);
      expect(summary.winStreakMax).toBe(1);
      expect(summary.lossStreakMax).toBe(1);
      expect(summary.currentStreakType).toBe('win');
    });
;
    it('handles failed and unknown outcomes without affecting PnL', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'failed', pnl: 0, cashOutMultiplier: null, timestamp: '2024-01-01T00:01:00Z' },
        { betId: '3', roundId: 'r3', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'unknown', pnl: 0, cashOutMultiplier: null, timestamp: '2024-01-01T00:02:00Z' },
      ];
      const summary = calc.computeSummary(entries);
      expect(summary.totalBets).toBe(3);
      expect(summary.wins).toBe(1);
      expect(summary.losses).toBe(0);
      expect(summary.failed).toBe(1);
      expect(summary.unknown).toBe(1);
      expect(summary.netPnl).toBeCloseTo(210, 5);
      expect(summary.hitRate).toBe(1.0);
      expect(summary.currentStreakType).toBe('none');
      expect(summary.currentStreak).toBe(0);
    });
;
    it('tracks streaks correctly through sequences', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:01:00Z' },
        { betId: '3', roundId: 'r3', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:02:00Z' },
        { betId: '4', roundId: 'r4', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:03:00Z' },
        { betId: '5', roundId: 'r5', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:04:00Z' },
        { betId: '6', roundId: 'r6', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:05:00Z' },
      ];
      const summary = calc.computeSummary(entries);
      expect(summary.winStreakMax).toBe(2);
      expect(summary.lossStreakMax).toBe(3);
      expect(summary.currentStreakType).toBe('win');
      expect(summary.currentStreak).toBe(1);
    });
;
    it('calculates expected value from observed hit rate', () => {
      const entries: PnlEntry[] = Array.from({ length: 100 }, (_, i) => ({
        betId: String(i),
        roundId: `r${i}`,
        dailyKey: 'd1',
        stake: 700,
        target: 1.30,
        outcome: i < 80 ? 'win' : 'loss',
        pnl: i < 80 ? 210 : -700,
        cashOutMultiplier: i < 80 ? 1.30 : null,
        timestamp: `2024-01-01T00:${String(i).padStart(2, '0')}:00Z`,
      }));
      const summary = calc.computeSummary(entries);
      expect(summary.hitRate).toBe(0.80);
      expect(summary.expectedValue).toBeCloseTo(calc.calculateExpectedValue(0.80), 1);
    });
  });
;
  describe('drawdown', () => {
    it('computes zero drawdown for all-win sequence', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:01:00Z' },
      ];
      const dd = calc.computeDrawdown(entries);
      expect(dd.maxDrawdown).toBe(0);
      expect(dd.currentDrawdown).toBe(0);
    });
;
    it('computes correct max drawdown', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:01:00Z' },
        { betId: '3', roundId: 'r3', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:02:00Z' },
        { betId: '4', roundId: 'r4', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:03:00Z' },
      ];
      const dd = calc.computeDrawdown(entries);
      expect(dd.maxDrawdown).toBe(1400);
      expect(dd.currentDrawdown).toBe(1190);
    });
;
    it('computes drawdown from equity curve', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'loss', pnl: -700, cashOutMultiplier: null, timestamp: '2024-01-01T00:01:00Z' },
      ];
      const curve = calc.buildEquityCurve(entries);
      const dd = calc.computeDrawdownFromCurve(curve);
      expect(dd.maxDrawdown).toBe(1400);
      expect(dd.currentDrawdown).toBe(1400);
    });
;
    it('buildEquityCurve has correct structure', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:00:00Z' },
      ];
      const curve = calc.buildEquityCurve(entries);
      expect(curve).toHaveLength(1);
      expect(curve[0].cumulativePnl).toBeCloseTo(210, 5);
      expect(curve[0].peakPnl).toBeCloseTo(210, 5);
      expect(curve[0].currentDrawdown).toBe(0);
      expect(curve[0].betId).toBe('1');
    });
;
    it('excludes failed and unknown from equity curve', () => {
      const entries: PnlEntry[] = [
        { betId: '1', roundId: 'r1', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'failed', pnl: 0, cashOutMultiplier: null, timestamp: '2024-01-01T00:00:00Z' },
        { betId: '2', roundId: 'r2', dailyKey: 'd1', stake: 700, target: 1.30, outcome: 'win', pnl: 210, cashOutMultiplier: 1.30, timestamp: '2024-01-01T00:01:00Z' },
      ];
      const curve = calc.buildEquityCurve(entries);
      expect(curve).toHaveLength(2);
      expect(curve[0].cumulativePnl).toBe(0);
      expect(curve[1].cumulativePnl).toBeCloseTo(210, 5);
    });
  });
;
  describe('simulateDryRun', () => {
    it('simulates wins when crash point >= target', () => {
      const summary = calc.simulateDryRun([1.50, 2.00, 1.30]);
      expect(summary.totalBets).toBe(3);
      expect(summary.wins).toBe(3);
      expect(summary.losses).toBe(0);
      expect(summary.netPnl).toBeCloseTo(630, 5);
    });
;
    it('simulates losses when crash point < target', () => {
      const summary = calc.simulateDryRun([1.10, 1.20, 1.25]);
      expect(summary.totalBets).toBe(3);
      expect(summary.wins).toBe(0);
      expect(summary.losses).toBe(3);
      expect(summary.netPnl).toBeCloseTo(-2100, 5);
    });
;
    it('simulates mixed results', () => {
      const summary = calc.simulateDryRun([1.50, 1.10, 2.00, 1.05]);
      expect(summary.wins).toBe(2);
      expect(summary.losses).toBe(2);
      expect(summary.netPnl).toBeCloseTo(-980, 5);
    });
;
    it('simulate100Entries requires exactly 100 points', () => {
      const points = Array.from({ length: 100 }, () => 1.0 + Math.random() * 2);
      const summary = calc.simulate100Entries(points);
      expect(summary.totalBets).toBe(100);
    });
;
    it('simulate100Entries throws when fewer than 100 points', () => {
      expect(() => calc.simulate100Entries([1.0, 2.0])).toThrow('Need 100 crash points');
    });
  });
;
  describe('computeRollingWindows', () => {
    it('computes windows for sufficient data', () => {
      const entries: PnlEntry[] = Array.from({ length: 100 }, (_, i) => ({
        betId: String(i),
        roundId: `r${i}`,
        dailyKey: 'd1',
        stake: 700,
        target: 1.30,
        outcome: i % 2 === 0 ? 'win' : 'loss',
        pnl: i % 2 === 0 ? 210 : -700,
        cashOutMultiplier: i % 2 === 0 ? 1.30 : null,
        timestamp: `2024-01-01T00:${String(i).padStart(2, '0')}:00Z`,
      }));
      const windows = calc.computeRollingWindows(entries, [10, 50, 100]);
      expect(windows[10]).toBeDefined();
      expect(windows[50]).toBeDefined();
      expect(windows[100]).toBeDefined();
      expect(windows[10].totalBets).toBe(10);
      expect(windows[50].totalBets).toBe(50);
      expect(windows[100].totalBets).toBe(100);
    });
;
    it('skips windows larger than data', () => {
      const entries: PnlEntry[] = Array.from({ length: 5 }, (_, i) => ({
        betId: String(i),
        roundId: `r${i}`,
        dailyKey: 'd1',
        stake: 700,
        target: 1.30,
        outcome: 'win',
        pnl: 210,
        cashOutMultiplier: 1.30,
        timestamp: '2024-01-01T00:00:00Z',
      }));
      const windows = calc.computeRollingWindows(entries, [10, 50]);
      expect(windows[10]).toBeUndefined();
      expect(windows[50]).toBeUndefined();
    });
;
    it('uses default window sizes when not specified', () => {
      const entries: PnlEntry[] = Array.from({ length: 500 }, (_, i) => ({
        betId: String(i),
        roundId: `r${i}`,
        dailyKey: 'd1',
        stake: 700,
        target: 1.30,
        outcome: 'win',
        pnl: 210,
        cashOutMultiplier: 1.30,
        timestamp: '2024-01-01T00:00:00Z',
      }));
      const windows = calc.computeRollingWindows(entries);
      expect(windows[10]).toBeDefined();
      expect(windows[50]).toBeDefined();
      expect(windows[100]).toBeDefined();
      expect(windows[500]).toBeDefined();
    });
  });
});
