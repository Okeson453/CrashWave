/**
 * BacktestEngine — historical simulation of the decision pipeline.
 * NEVER invokes live browser executor or mutates real ledger.
 *
 * Equity curve:
 *   equity = initialBalance + cumulativePnL
 *   peakEquity = max(previousPeakEquity, equity)
 *   drawdown = peakEquity - equity
 *   drawdownPct = drawdown / peakEquity  (0 if peakEquity <= 0)
 */

import {
  HistoricalRound,
  BacktestConfig,
  BacktestResult,
  BacktestDecision,
  PredictionSignal,
} from '../types.js';
import { PredictionEngine } from '../prediction-engine.js';
import { isSignalFresh } from '../signals/signal.js';
import { getLogger } from '../../observability/logger.js';

export interface SimulatedRiskContext {
  dailyEntries: number;
  equity: number;
  peakEquity: number;
  initialBalance: number;
}

const DEFAULT_INITIAL_BALANCE = 10_000;

export class BacktestEngine {
  private readonly logger = getLogger();
  private readonly predictionEngine: PredictionEngine;

  constructor(predictionEngine?: PredictionEngine) {
    this.predictionEngine = predictionEngine ?? new PredictionEngine();
  }

  run(rounds: HistoricalRound[], config: BacktestConfig, initialBalance = DEFAULT_INITIAL_BALANCE): BacktestResult {
    const minHistory = 30;
    const decisions: BacktestDecision[] = [];
    let dailyEntries = 0;
    let cumulativePnl = 0;
    let equity = initialBalance;
    let peakEquity = initialBalance;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    let wins = 0;
    let losses = 0;
    let signalsGenerated = 0;
    let signalsAccepted = 0;
    let signalsRejected = 0;
    let lastDay = '';

    for (let i = minHistory; i < rounds.length; i++) {
      const prior = rounds.slice(0, i);
      const current = rounds[i];
      const ts = current.startedAt ?? current.crashedAt ?? current.createdAt;
      const dayKey = ts.slice(0, 10);
      if (dayKey !== lastDay) {
        dailyEntries = 0;
        lastDay = dayKey;
      }

      const signal = this.predictionEngine.predict({
        priorRounds: prior,
        targetRoundId: current.id,
        timestamp: ts,
        target: config.target,
        modelName: config.modelName,
        modelVersion: config.modelVersion,
      });
      signalsGenerated++;

      const risk = this.simulateRisk(
        signal,
        { dailyEntries, equity, peakEquity, initialBalance },
        config
      );

      let entered = false;
      let outcome: BacktestDecision['outcome'] = 'skip';
      let pnl = 0;

      if (risk.approved) {
        signalsAccepted++;
        entered = true;
        dailyEntries++;
        const hit = current.crashPoint >= config.cashoutTarget;
        if (hit) {
          outcome = 'win';
          pnl = config.stake * (config.cashoutTarget - 1);
          wins++;
        } else {
          outcome = 'loss';
          pnl = -config.stake;
          losses++;
        }
        cumulativePnl += pnl;
        equity = initialBalance + cumulativePnl;
        peakEquity = Math.max(peakEquity, equity);
        const dd = peakEquity - equity;
        maxDrawdown = Math.max(maxDrawdown, dd);
        if (peakEquity > 0) {
          maxDrawdownPct = Math.max(maxDrawdownPct, (dd / peakEquity) * 100);
        }
      } else {
        signalsRejected++;
      }

      const currentDd = peakEquity - equity;
      decisions.push({
        roundId: current.id,
        timestamp: ts,
        signal,
        riskApproved: risk.approved,
        riskRejectionReason: risk.reason,
        entered,
        outcome,
        pnl,
        cumulativePnl,
        drawdown: currentDd,
      });
    }

    const hitRate = wins + losses > 0 ? wins / (wins + losses) : 0;
    const grossWin = decisions.filter((d) => d.pnl > 0).reduce((s, d) => s + d.pnl, 0);
    const grossLoss = Math.abs(decisions.filter((d) => d.pnl < 0).reduce((s, d) => s + d.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

    const result: BacktestResult = {
      config,
      decisions,
      metrics: {
        totalRounds: rounds.length,
        signalsGenerated,
        signalsAccepted,
        signalsRejected,
        wins,
        losses,
        hitRate,
        totalPnl: cumulativePnl,
        maxDrawdown,
        profitFactor: Number.isFinite(profitFactor) ? profitFactor : 999,
        expectedValue: wins + losses > 0 ? cumulativePnl / (wins + losses) : 0,
        exposure: (wins + losses) / Math.max(1, rounds.length - minHistory),
      },
      generatedAt: new Date().toISOString(),
    };

    this.logger.info(
      {
        component: 'BacktestEngine',
        signalsAccepted,
        hitRate,
        totalPnl: cumulativePnl,
        maxDrawdown,
        maxDrawdownPct,
      },
      'Backtest complete'
    );

    return result;
  }

  private simulateRisk(
    signal: PredictionSignal,
    ctx: SimulatedRiskContext,
    config: BacktestConfig
  ): { approved: boolean; reason?: string } {
    if (!isSignalFresh(signal, 120_000, new Date(signal.timestamp))) {
      return { approved: false, reason: 'STALE_SIGNAL' };
    }
    if (signal.probability < config.entryProbabilityThreshold) {
      return { approved: false, reason: 'LOW_PROBABILITY' };
    }
    if (signal.confidence < config.minConfidence) {
      return { approved: false, reason: 'LOW_CONFIDENCE' };
    }
    if (ctx.dailyEntries >= config.maxDailyEntries) {
      return { approved: false, reason: 'DAILY_ENTRY_LIMIT' };
    }
    // Equity-based drawdown: reject if current drawdown from peak exceeds limit
    const dd = ctx.peakEquity - ctx.equity;
    const ddPct = ctx.peakEquity > 0 ? (dd / ctx.peakEquity) * 100 : 0;
    if (ddPct >= config.maxDrawdownPct) {
      return { approved: false, reason: 'MAX_DRAWDOWN' };
    }
    if (ctx.equity < config.stake) {
      return { approved: false, reason: 'INSUFFICIENT_BALANCE' };
    }
    return { approved: true };
  }
}
