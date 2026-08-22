import { DrawdownCalculator } from '../../../src/risk-engine/drawdown';

describe('DrawdownCalculator', () => {
  it('tracks consecutive losses', () => {
    const calc = new DrawdownCalculator({
      alertThreshold: 3,
      maxDrawdownPercent: 50,
      stake: 100,
      initialEquity: 1000,
    });
    calc.recordLoss(100);
    calc.recordLoss(100);
    const stats = calc.getStats();
    expect(stats.consecutiveLosses).toBe(2);
    expect(stats.totalDrawdown).toBe(200);
    expect(stats.shouldAlert).toBe(false);
    expect(stats.currentEquity).toBe(800);
    expect(stats.peakEquity).toBe(1000);
  });

  it('alerts when consecutive threshold is reached', () => {
    const calc = new DrawdownCalculator({
      alertThreshold: 3,
      maxDrawdownPercent: 50,
      stake: 100,
      initialEquity: 1000,
    });
    calc.recordLoss(100);
    calc.recordLoss(100);
    calc.recordLoss(100);
    expect(calc.getStats().shouldAlert).toBe(true);
  });

  it('resets streak on win and updates peak', () => {
    const calc = new DrawdownCalculator({
      alertThreshold: 3,
      maxDrawdownPercent: 50,
      stake: 100,
      initialEquity: 1000,
    });
    calc.recordLoss(100);
    calc.recordLoss(100);
    calc.recordWin(50);
    const stats = calc.getStats();
    expect(stats.consecutiveLosses).toBe(0);
    expect(stats.totalDrawdown).toBe(150);
    expect(stats.currentEquity).toBe(850);
  });

  it('does not go below zero total drawdown', () => {
    const calc = new DrawdownCalculator({
      alertThreshold: 3,
      maxDrawdownPercent: 50,
      stake: 100,
      initialEquity: 1000,
    });
    calc.recordLoss(100);
    calc.recordWin(200);
    const stats = calc.getStats();
    expect(stats.totalDrawdown).toBe(0);
    expect(stats.currentEquity).toBe(1100);
    expect(stats.peakEquity).toBe(1100);
  });

  it('returns zero stats initially', () => {
    const calc = new DrawdownCalculator({
      alertThreshold: 5,
      maxDrawdownPercent: 50,
      stake: 100,
    });
    const stats = calc.getStats();
    expect(stats.consecutiveLosses).toBe(0);
    expect(stats.totalDrawdown).toBe(0);
    expect(stats.shouldAlert).toBe(false);
    expect(stats.drawdownPercent).toBe(0);
  });

  it('computes peak-to-trough drawdown percent', () => {
    const calc = new DrawdownCalculator({
      alertThreshold: 10,
      maxDrawdownPercent: 20,
      stake: 100,
      initialEquity: 1000,
    });
    calc.recordLoss(100);
    calc.recordLoss(100);
    const stats = calc.getStats();
    expect(stats.drawdownPercent).toBe(20);
    expect(stats.percentBreach).toBe(true);
    expect(stats.shouldAlert).toBe(true);
  });

  it('raises peak only on new highs', () => {
    const calc = new DrawdownCalculator({
      alertThreshold: 10,
      maxDrawdownPercent: 50,
      stake: 100,
      initialEquity: 1000,
    });
    calc.updateEquity(1200);
    expect(calc.getStats().peakEquity).toBe(1200);
    calc.updateEquity(1100);
    expect(calc.getStats().peakEquity).toBe(1200);
    expect(calc.getStats().currentEquity).toBe(1100);
    expect(calc.getStats().drawdownPercent).toBeCloseTo(8.33, 1);
  });
});
