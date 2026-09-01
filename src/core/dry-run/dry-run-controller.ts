/**
 * ACIE Dry-Run Controller
 *
 * First-class dry-run mode:
 * - observation + prediction + signal + simulation ENABLED
 * - live execution DISABLED
 * - BC.Game authentication NOT required
 */

import { getLogger } from '../../observability/logger';
import { getVirtualLedger, VirtualTradeLedger, VirtualLedgerSnapshot } from './virtual-ledger';
import { randomUUID } from 'crypto';

export interface DryRunConfig {
  stake: number;
  target: number;
  initialVirtualBalance: number;
  maxDailyVirtualTrades: number;
  minProbability: number;
  minConfidence: number;
}

const DEFAULT_CFG: DryRunConfig = {
  stake: 700,
  target: 1.3,
  initialVirtualBalance: 10_000,
  maxDailyVirtualTrades: 100,
  minProbability: 0.35,
  minConfidence: 0.3,
};

export interface DryRunSignal {
  signalId: string;
  predictionId?: string;
  roundId: string;
  probability: number;
  confidence: number;
  target: number;
  stake?: number;
}

export class DryRunController {
  private readonly logger = getLogger();
  private readonly cfg: DryRunConfig;
  private readonly ledger: VirtualTradeLedger;
  private dailyTrades = 0;
  private dailyKey = new Date().toISOString().slice(0, 10);
  private predictions = 0;
  private signals = 0;
  private signalsAccepted = 0;
  private signalsRejected = 0;
  private roundsObserved = 0;
  private sessionId: string | null = null;
  private tenantId: string | null = null;
  private running = false;

  constructor(cfg?: Partial<DryRunConfig>) {
    this.cfg = { ...DEFAULT_CFG, ...cfg };
    this.ledger = getVirtualLedger(this.cfg.initialVirtualBalance);
  }

  start(sessionId: string, tenantId?: string | null): void {
    this.sessionId = sessionId;
    this.tenantId = tenantId ?? null;
    this.running = true;
    this.logger.info(
      { component: 'DryRunController', sessionId, tenantId },
      'Dry-run session started — auth not required, live execution disabled'
    );
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  onRoundCompleted(roundId: string, crashPoint: number): void {
    if (!this.running) return;
    this.roundsObserved++;
    this.ledger.resolveRound(roundId, crashPoint);
  }

  recordPrediction(): void {
    this.predictions++;
  }

  /**
   * Evaluate signal against dry-run risk gate (no auth / real balance required).
   * On accept, open a virtual trade.
   */
  evaluateAndSimulate(signal: DryRunSignal): { accepted: boolean; reason?: string } {
    if (!this.running) {
      return { accepted: false, reason: 'dry-run not running' };
    }

    this.signals++;
    this.rollDaily();

    if (signal.probability < this.cfg.minProbability) {
      this.signalsRejected++;
      return { accepted: false, reason: `probability ${signal.probability} < ${this.cfg.minProbability}` };
    }
    if (signal.confidence < this.cfg.minConfidence) {
      this.signalsRejected++;
      return { accepted: false, reason: `confidence ${signal.confidence} < ${this.cfg.minConfidence}` };
    }
    if (this.dailyTrades >= this.cfg.maxDailyVirtualTrades) {
      this.signalsRejected++;
      return { accepted: false, reason: 'daily virtual trade limit' };
    }

    const stake = signal.stake ?? this.cfg.stake;
    const target = signal.target || this.cfg.target;
    const trade = this.ledger.openTrade({
      virtualTradeId: randomUUID(),
      tenantId: this.tenantId,
      sessionId: this.sessionId,
      predictionId: signal.predictionId,
      signalId: signal.signalId,
      roundId: signal.roundId,
      stake,
      target,
    });

    if (!trade) {
      this.signalsRejected++;
      return { accepted: false, reason: 'ledger rejected (duplicate or insufficient virtual balance)' };
    }

    this.dailyTrades++;
    this.signalsAccepted++;
    return { accepted: true };
  }

  getLedgerSnapshot(): VirtualLedgerSnapshot {
    return this.ledger.snapshot();
  }

  getStatus(): {
    running: boolean;
    mode: 'DRY_RUN';
    liveExecution: false;
    authRequired: false;
    roundsObserved: number;
    predictions: number;
    signals: number;
    signalsAccepted: number;
    signalsRejected: number;
    ledger: VirtualLedgerSnapshot;
  } {
    return {
      running: this.running,
      mode: 'DRY_RUN',
      liveExecution: false,
      authRequired: false,
      roundsObserved: this.roundsObserved,
      predictions: this.predictions,
      signals: this.signals,
      signalsAccepted: this.signalsAccepted,
      signalsRejected: this.signalsRejected,
      ledger: this.ledger.snapshot(),
    };
  }

  formatTelegramStatus(): string {
    const s = this.getStatus();
    const L = s.ledger;
    const wr = (L.winRate * 100).toFixed(2);
    return [
      'ACIE DRY RUN',
      '',
      `Status: ${s.running ? 'RUNNING' : 'STOPPED'}`,
      '',
      `Rounds observed: ${s.roundsObserved}`,
      `Predictions: ${s.predictions}`,
      `Signals: ${s.signals} (accepted ${s.signalsAccepted} / rejected ${s.signalsRejected})`,
      `Virtual trades: ${L.trades}`,
      '',
      `Wins: ${L.wins}`,
      `Losses: ${L.losses}`,
      `Win rate: ${wr}%`,
      '',
      `Virtual P&L: ${L.netPnl >= 0 ? '+' : ''}${L.netPnl.toFixed(2)}`,
      `Virtual balance: ${L.virtualBalance.toFixed(2)}`,
      '',
      'BC.Game Login: NOT REQUIRED',
      'Live Execution: DISABLED',
    ].join('\n');
  }

  private rollDaily(): void {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== this.dailyKey) {
      this.dailyKey = key;
      this.dailyTrades = 0;
    }
  }
}
