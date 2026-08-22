import { AnalyticsEngine, createAnalyticsEngine } from '../../../src/analytics/engine';
import { BetOutcomeRecord, LatencySample } from '../../../src/analytics/types';

describe('Analytics Engine Integration — Full Pipeline', () => {
  let engine: AnalyticsEngine;

  beforeEach(() => {
    engine = createAnalyticsEngine();
    engine.startSession('test-session-001');
  });

  afterEach(() => {
    engine.clear();
  });

  const today = new Date();
  const todayKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;

  function generateOutcomes(
    count: number,
    winRate: number,
    startTime: Date = new Date(today.getTime() - count * 60000)
  ): BetOutcomeRecord[] {
    const outcomes: BetOutcomeRecord[] = [];
    for (let i = 0; i < count; i++) {
      const isWin = Math.random() < winRate;
      outcomes.push({
        betId: `bet-${i}`,
        roundId: `round-${i}`,
        dailyKey: todayKey,
        timestamp: new Date(startTime.getTime() + i * 60000).toISOString(),
        outcome: isWin ? 'win' : 'loss',
        pnl: isWin ? 210 : -700,
        stake: 700,
        target: 1.30,
        cashOutMultiplier: isWin ? 1.30 : null,
        latencyMs: Math.floor(Math.random() * 500) + 100,
        cashOutSuccess: isWin,
        failureReason: null,
      });
    }
    return outcomes;
  }

  function generateLatencySamples(count: number): LatencySample[] {
    const base = new Date(today.getTime() - count * 60000);
    return Array.from({ length: count }, (_, i) => ({
      timestamp: new Date(base.getTime() + i * 60000).toISOString(),
      type: ['observation', 'execution', 'cashout'][i % 3] as 'observation' | 'execution' | 'cashout',
      latencyMs: Math.floor(Math.random() * 400) + 100,
      roundId: `round-${i}`,
      betId: `bet-${i}`,
    }));
  }

  describe('Data Ingestion', () => {
    it('records outcomes and maintains state', () => {
      const outcomes = generateOutcomes(50, 0.8);
      engine.recordOutcomes(outcomes);

      const state = engine.getState();
      expect(state.outcomes).toHaveLength(50);
      expect(state.sessionId).toBe('test-session-001');
    });

    it('records latency samples', () => {
      const samples = generateLatencySamples(30);
      engine.recordLatencies(samples);

      const state = engine.getState();
      expect(state.latencySamples).toHaveLength(30);
    });

    it('sets balance and observation confidence', () => {
      engine.setBalance(15000);
      engine.setObservationConfidence('high');

      const state = engine.getState();
      expect(state.currentBalance).toBe(15000);
      expect(state.observationConfidence).toBe('high');
    });
  });

  describe('Window Aggregation', () => {
    it('returns snapshot for last_10 window with sufficient data', () => {
      const outcomes = generateOutcomes(20, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(20));

      const snapshot = engine.getSnapshot('last_10');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.window).toBe('last_10');
      expect(snapshot!.hitRate.sampleSize).toBe(10);
    });

    it('returns null for window with insufficient data', () => {
      const outcomes = generateOutcomes(3, 0.8);
      engine.recordOutcomes(outcomes);

      const snapshot = engine.getSnapshot('last_10');
      expect(snapshot).toBeNull();
    });

    it('returns snapshots for all windows', () => {
      const outcomes = generateOutcomes(600, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(600));

      const allSnapshots = engine.getAllSnapshots();
      expect(allSnapshots.last_10).not.toBeNull();
      expect(allSnapshots.last_50).not.toBeNull();
      expect(allSnapshots.last_100).not.toBeNull();
      expect(allSnapshots.last_500).not.toBeNull();
      expect(allSnapshots.all).not.toBeNull();
    });

    it('computes correct hit rate in snapshot', () => {
      // Generate exactly 80% win rate
      const outcomes: BetOutcomeRecord[] = [];
      for (let i = 0; i < 100; i++) {
        const isWin = i < 80;
        outcomes.push({
          betId: `bet-${i}`,
          roundId: `round-${i}`,
          dailyKey: todayKey,
          timestamp: new Date(today.getTime() - 100 * 60000 + i * 60000).toISOString(),
          outcome: isWin ? 'win' : 'loss',
          pnl: isWin ? 210 : -700,
          stake: 700,
          target: 1.30,
          cashOutMultiplier: isWin ? 1.30 : null,
          latencyMs: 200,
          cashOutSuccess: isWin,
          failureReason: null,
        });
      }

      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(100));

      const snapshot = engine.getSnapshot('last_100');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.hitRate.observedRate).toBe(0.8);
      expect(snapshot!.hitRate.sampleSize).toBe(100);
    });
  });

  describe('Summary Generation', () => {
    it('returns summary with correct structure', () => {
      const outcomes = generateOutcomes(100, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(100));

      const summary = engine.getSummary('last_100');
      expect(summary).not.toBeNull();
      expect(summary!.window).toBe('last_100');
      expect(summary!.entries).toBe(100);
      expect(summary!.hitRate).toBeGreaterThan(0);
      expect(summary!.breakEvenHitRate).toBeCloseTo(1 / 1.30, 5);
      expect(summary!.realizedPnl).toBeDefined();
      expect(summary!.maxDrawdown).toBeDefined();
      expect(summary!.recommendation).toBeDefined();
    });
  });

  describe('Report Generation', () => {
    it('generates daily report', () => {
      const outcomes = generateOutcomes(50, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(50));
      engine.setBalance(15000);

      const report = engine.generateDailyReport();
      expect(report.dailyKey).toBeDefined();
      expect(report.entriesConfirmed).toBe(50);
      expect(report.hitRate).toBeDefined();
      expect(report.recommendations).toBeDefined();
      expect(report.anomalies).toBeDefined();
    });

    it('generates session report', () => {
      const outcomes = generateOutcomes(50, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(50));

      const report = engine.generateSessionReport();
      expect(report).not.toBeNull();
      expect(report!.sessionId).toBe('test-session-001');
      expect(report!.entries).toBe(50);
      expect(report!.healthScore).toBeGreaterThan(0);
      expect(report!.efficiencyScore).toBeGreaterThanOrEqual(0);
    });

    it('returns null session report when no session active', () => {
      engine.endSession();
      const report = engine.generateSessionReport();
      expect(report).toBeNull();
    });

    it('generates learning curve report', () => {
      const outcomes = generateOutcomes(100, 0.8);
      engine.recordOutcomes(outcomes);

      const report = engine.generateLearningCurveReport();
      expect(report.points.length).toBeGreaterThan(0);
      expect(report.trendDirection).toBeDefined();
      expect(report.trendStrength).toBeGreaterThanOrEqual(0);
    });

    it('handles learning curve with insufficient data', () => {
      const outcomes = generateOutcomes(3, 0.8);
      engine.recordOutcomes(outcomes);

      const report = engine.generateLearningCurveReport();
      expect(report.points).toHaveLength(0);
      expect(report.trendDirection).toBe('stable');
    });
  });

  describe('Telegram Commands', () => {
    it('handles summary command', () => {
      const outcomes = generateOutcomes(100, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(100));

      const payload = engine.handleSummaryCommand();
      expect(payload.command).toBe('/analytics summary');
      expect(payload.summary).toBeDefined();
      expect(payload.formattedMessage).toBeTruthy();
      expect(payload.hitRateDetails).not.toBeNull();
    });

    it('handles today command', () => {
      const outcomes = generateOutcomes(50, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(50));

      const payload = engine.handleTodayCommand();
      expect(payload.command).toBe('/analytics today');
      expect(payload.formattedMessage).toBeTruthy();
    });

    it('handles window command', () => {
      const outcomes = generateOutcomes(100, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(100));

      const payload = engine.handleWindowCommand('last_100');
      expect(payload.command).toBe('/analytics last_100');
      expect(payload.summary).toBeDefined();
      expect(payload.formattedMessage).toBeTruthy();
    });

    it('handles window command with insufficient data', () => {
      const outcomes = generateOutcomes(5, 0.8);
      engine.recordOutcomes(outcomes);

      const payload = engine.handleWindowCommand('last_100');
      expect(payload.formattedMessage).toContain('Insufficient data');
    });

    it('handles drawdown command', () => {
      const outcomes = generateOutcomes(100, 0.8);
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(100));

      const payload = engine.handleDrawdownCommand();
      expect(payload.command).toBe('/analytics drawdown');
      expect(payload.drawdownDetails).not.toBeNull();
      expect(payload.formattedMessage).toContain('Drawdown');
    });
  });

  describe('Recommendations & Anomalies', () => {
    it('generates continue recommendation for healthy metrics', () => {
      // Use deterministic outcomes: 80 wins, 20 losses, interleaved to avoid large drawdown
      const outcomes: BetOutcomeRecord[] = [];
      for (let i = 0; i < 100; i++) {
        const isWin = i % 5 !== 0; // 80 wins, 20 losses distributed evenly
        outcomes.push({
          betId: `bet-${i}`,
          roundId: `round-${i}`,
          dailyKey: todayKey,
          timestamp: new Date(today.getTime() - 100 * 60000 + i * 60000).toISOString(),
          outcome: isWin ? 'win' : 'loss',
          pnl: isWin ? 210 : -700,
          stake: 700,
          target: 1.30,
          cashOutMultiplier: isWin ? 1.30 : null,
          latencyMs: 200,
          cashOutSuccess: true, // All cash-outs succeed in healthy scenario
          failureReason: null,
        });
      }
      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(100));
      engine.setBalance(15000);
      engine.setObservationConfidence('high');

      const snapshot = engine.getSnapshot('last_100');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.recommendations.length).toBeGreaterThan(0);
      expect(snapshot!.recommendations[0].type).toBe('continue');
    });

    it('generates stop recommendation for critical cash-out failures', () => {
      const outcomes: BetOutcomeRecord[] = [];
      for (let i = 0; i < 100; i++) {
        outcomes.push({
          betId: `bet-${i}`,
          roundId: `round-${i}`,
          dailyKey: todayKey,
          timestamp: new Date(today.getTime() - 100 * 60000 + i * 60000).toISOString(),
          outcome: i < 80 ? 'win' : 'loss',
          pnl: i < 80 ? 210 : -700,
          stake: 700,
          target: 1.30,
          cashOutMultiplier: null,
          latencyMs: 200,
          cashOutSuccess: false, // All cash-outs fail
          failureReason: 'timeout',
        });
      }

      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(100));

      const snapshot = engine.getSnapshot('last_100');
      expect(snapshot).not.toBeNull();
      const stopRec = snapshot!.recommendations.find((r) => r.type === 'stop');
      expect(stopRec).toBeDefined();
    });

    it('flags anomalies when metrics degrade', () => {
      const outcomes: BetOutcomeRecord[] = [];
      for (let i = 0; i < 100; i++) {
        outcomes.push({
          betId: `bet-${i}`,
          roundId: `round-${i}`,
          dailyKey: todayKey,
          timestamp: new Date(today.getTime() - 100 * 60000 + i * 60000).toISOString(),
          outcome: 'loss',
          pnl: -700,
          stake: 700,
          target: 1.30,
          cashOutMultiplier: null,
          latencyMs: 5000,
          cashOutSuccess: false,
          failureReason: 'timeout',
        });
      }

      engine.recordOutcomes(outcomes);
      engine.recordLatencies(
        Array.from({ length: 100 }, (_, i) => ({
          timestamp: new Date(today.getTime() - 100 * 60000 + i * 60000).toISOString(),
          type: 'cashout' as const,
          latencyMs: 5000,
          roundId: `round-${i}`,
          betId: `bet-${i}`,
        }))
      );

      const snapshot = engine.getSnapshot('last_100');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.anomalies.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty engine state gracefully', () => {
      const payload = engine.handleSummaryCommand();
      expect(payload.formattedMessage).toContain('No data available');
    });

    it('handles all failed outcomes', () => {
      const outcomes: BetOutcomeRecord[] = Array.from({ length: 50 }, (_, i) => ({
        betId: `bet-${i}`,
        roundId: `round-${i}`,
        dailyKey: todayKey,
        timestamp: new Date(today.getTime() - 100 * 60000 + i * 60000).toISOString(),
        outcome: 'failed',
        pnl: 0,
        stake: 700,
        target: 1.30,
        cashOutMultiplier: null,
        latencyMs: null,
        cashOutSuccess: null,
        failureReason: 'timeout',
      }));

      engine.recordOutcomes(outcomes);
      const snapshot = engine.getSnapshot('last_50');
      expect(snapshot).toBeNull(); // No resolved outcomes
    });

    it('handles mixed outcome types', () => {
      const outcomes: BetOutcomeRecord[] = [];
      for (let i = 0; i < 100; i++) {
        const type = i % 4 === 0 ? 'failed' : i % 4 === 1 ? 'unknown' : i % 2 === 0 ? 'win' : 'loss';
        outcomes.push({
          betId: `bet-${i}`,
          roundId: `round-${i}`,
          dailyKey: todayKey,
          timestamp: new Date(today.getTime() - 100 * 60000 + i * 60000).toISOString(),
          outcome: type,
          pnl: type === 'win' ? 210 : type === 'loss' ? -700 : 0,
          stake: 700,
          target: 1.30,
          cashOutMultiplier: type === 'win' ? 1.30 : null,
          latencyMs: type === 'win' || type === 'loss' ? 200 : null,
          cashOutSuccess: type === 'win' ? true : type === 'loss' ? false : null,
          failureReason: type === 'failed' ? 'timeout' : null,
        });
      }

      engine.recordOutcomes(outcomes);
      engine.recordLatencies(generateLatencySamples(100));

      const snapshot = engine.getSnapshot('last_100');
      expect(snapshot).not.toBeNull();
      // Only win/loss count toward hit rate
      expect(snapshot!.hitRate.sampleSize).toBeLessThan(100);
    });

    it('maintains data after session end', () => {
      const outcomes = generateOutcomes(50, 0.8);
      engine.recordOutcomes(outcomes);
      engine.endSession();

      const state = engine.getState();
      expect(state.outcomes).toHaveLength(50);
      expect(state.sessionId).toBeNull();
    });
  });
});
