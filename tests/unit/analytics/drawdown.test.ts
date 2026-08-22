import {
  buildEquityCurve,
  computeDrawdownMetrics,
  computeDrawdownFromOutcomes,
  computeDrawdownFromPnl,
  findRecoveryTime,
  findConsecutiveDrawdowns,
  formatDrawdownMetrics,
} from '../../../src/analytics/metrics/drawdown';
import { BetOutcomeRecord } from '../../../src/analytics/types';

function makeOutcome(pnl: number, index: number): BetOutcomeRecord {
  return {
    betId: `b-${index}`,
    roundId: `r-${index}`,
    dailyKey: '2024-01-01',
    timestamp: new Date(2024, 0, 1, 0, index).toISOString(),
    outcome: pnl >= 0 ? 'win' : 'loss',
    pnl,
    stake: 700,
    target: 1.30,
    cashOutMultiplier: pnl >= 0 ? 1.30 : null,
    latencyMs: null,
    cashOutSuccess: pnl >= 0,
    failureReason: null,
  };
}

describe('buildEquityCurve', () => {
  it('builds correct equity curve for alternating wins/losses', () => {
    const outcomes = [210, -700, 210, -700].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);

    expect(curve).toHaveLength(4);
    expect(curve[0].equity).toBe(210);
    expect(curve[1].equity).toBe(-490);
    expect(curve[2].equity).toBe(-280);
    expect(curve[3].equity).toBe(-980);
  });

  it('tracks peak equity correctly', () => {
    const outcomes = [210, 210, -700, 210].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);

    expect(curve[0].peakEquity).toBe(210);
    expect(curve[1].peakEquity).toBe(420);
    expect(curve[2].peakEquity).toBe(420);
    expect(curve[3].peakEquity).toBe(420);
  });

  it('resets underwater duration after new peak', () => {
    // Equity: 0 -> 210 -> 420 -> -280 -> -70 -> 140 -> 350 -> 560 (new peak)
    const outcomes = [210, 210, -700, 210, 210, 210, 210].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);

    expect(curve[2].durationUnderwater).toBe(1); // first underwater
    expect(curve[6].durationUnderwater).toBe(0); // new peak resets
  });

  it('ignores failed and unknown outcomes', () => {
    const outcomes: BetOutcomeRecord[] = [
      makeOutcome(210, 0),
      { ...makeOutcome(0, 1), outcome: 'failed', pnl: 0 },
      makeOutcome(-700, 2),
    ];
    const curve = buildEquityCurve(outcomes, 0);

    expect(curve).toHaveLength(3);
    expect(curve[0].equity).toBe(210);
    expect(curve[1].equity).toBe(210); // failed doesn't change equity
    expect(curve[2].equity).toBe(-490);
  });
});

describe('computeDrawdownMetrics', () => {
  it('returns zeros for empty curve', () => {
    const metrics = computeDrawdownMetrics([]);
    expect(metrics.maxDrawdown).toBe(0);
    expect(metrics.currentDrawdown).toBe(0);
  });

  it('computes max drawdown correctly', () => {
    // Start at 0, win 210, win 210, lose 700, lose 700, win 210
    // Equity: 0 -> 210 -> 420 -> -280 -> -980 -> -770
    // Peak: 0 -> 210 -> 420 -> 420 -> 420 -> 420
    // DD:   0 -> 0   -> 0   -> 700 -> 1400 -> 1190
    const outcomes = [210, 210, -700, -700, 210].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);
    const metrics = computeDrawdownMetrics(curve);

    expect(metrics.maxDrawdown).toBe(1400);
    expect(metrics.currentDrawdown).toBe(1190);
    expect(metrics.peakEquity).toBe(420);
    expect(metrics.currentEquity).toBe(-770);
    expect(metrics.isUnderwater).toBe(true);
    expect(metrics.drawdownSeverity).toBe('mild'); // 1400 is >= 500, < 1500
  });

  it('classifies no drawdown as none', () => {
    const outcomes = [210, 210, 210].map((pnl, i) => makeOutcome(pnl, i));
    const metrics = computeDrawdownFromOutcomes(outcomes);

    expect(metrics.maxDrawdown).toBe(0);
    expect(metrics.drawdownSeverity).toBe('none');
    expect(metrics.isUnderwater).toBe(false);
  });

  it('classifies mild drawdown correctly', () => {
    const outcomes = Array(3).fill(-700).map((pnl, i) => makeOutcome(pnl, i));
    const metrics = computeDrawdownFromOutcomes(outcomes, 10000);

    expect(metrics.maxDrawdown).toBe(2100);
    expect(metrics.drawdownSeverity).toBe('moderate'); // 2100 >= 1500
  });

  it('counts recoveries correctly', () => {
    // 0 -> 210 -> 420 -> -280 -> -70 -> 140 -> 350 -> 560 (recover to new peak)
    const outcomes = [210, 210, -700, 210, 210, 210, 210].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);
    const metrics = computeDrawdownMetrics(curve);

    expect(metrics.recoveryCount).toBe(1);
  });
});

describe('computeDrawdownFromPnl', () => {
  it('computes drawdown from P&L array', () => {
    const metrics = computeDrawdownFromPnl([210, 210, -700, -700, 210], 0);
    expect(metrics.maxDrawdown).toBe(1400);
  });
});

describe('findRecoveryTime', () => {
  it('returns 0 if never underwater', () => {
    const outcomes = [210, 210].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);
    expect(findRecoveryTime(curve)).toBe(0);
  });

  it('returns recovery bets after max drawdown', () => {
    // 0 -> 210 -> 420 -> -280 -> -70 -> 140 -> 350 -> 560 (recover)
    // Max DD at index 2 (420 -> -280, DD=700)
    // Recovery at index 7 (560 > 420)
    const outcomes = [210, 210, -700, 210, 210, 210, 210].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);
    expect(findRecoveryTime(curve)).toBe(4); // index 6 - index 2
  });

  it('returns null if still underwater', () => {
    const outcomes = [210, -700].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);
    expect(findRecoveryTime(curve)).toBeNull();
  });
});

describe('findConsecutiveDrawdowns', () => {
  it('finds single drawdown period', () => {
    // 0 -> 210 -> -490 -> -1190 -> -980 (still underwater at end)
    const outcomes = [210, -700, -700, 210].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);
    const dds = findConsecutiveDrawdowns(curve);

    expect(dds).toHaveLength(1);
    expect(dds[0].startIndex).toBe(1);
    expect(dds[0].endIndex).toBe(3); // still underwater at end
    expect(dds[0].depth).toBe(1400);
    expect(dds[0].duration).toBe(3);
  });

  it('finds multiple drawdown periods', () => {
    // 0 -> 210 -> 420 -> -280 -> -70 -> 140 -> 350 -> 560 -> -140 -> 70 -> 280 -> 490 -> 700
    // Peak 420 at 1, underwater 2-6, new peak 560 at 6, underwater 7-11, recovery 12
    const outcomes = [210, 210, -700, 210, 210, 210, 210, -700, 210, 210, 210, 210].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);
    const dds = findConsecutiveDrawdowns(curve);

    expect(dds).toHaveLength(2);
    expect(dds[0].startIndex).toBe(2);
    expect(dds[0].endIndex).toBe(5); // index 6 is new peak, not underwater
    expect(dds[1].startIndex).toBe(7);
    expect(dds[1].endIndex).toBe(10);
  });

  it('handles ongoing drawdown at end', () => {
    const outcomes = [210, -700, -700].map((pnl, i) => makeOutcome(pnl, i));
    const curve = buildEquityCurve(outcomes, 0);
    const dds = findConsecutiveDrawdowns(curve);

    expect(dds).toHaveLength(1);
    expect(dds[0].endIndex).toBe(2);
  });
});

describe('formatDrawdownMetrics', () => {
  it('produces a non-empty formatted string', () => {
    const metrics = computeDrawdownFromPnl([210, -700, 210], 0);
    const formatted = formatDrawdownMetrics(metrics);
    expect(formatted).toContain('Max Drawdown');
    expect(formatted).toContain('Current Drawdown');
    expect(formatted).toContain('Severity');
  });
});
