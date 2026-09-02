/**
 * ACIE Dry-Run Virtual Trade Ledger
 *
 * In-memory (optional persist later) ledger for simulated trades.
 * Never touches BC.Game balance. Idempotent on tenantId+signalId / roundId.
 */

import { getLogger } from '../../observability/logger';

export type VirtualTradeStatus = 'OPEN' | 'WIN' | 'LOSS' | 'CANCELLED';

export interface VirtualTrade {
  virtualTradeId: string;
  tenantId: string | null;
  sessionId: string | null;
  predictionId?: string;
  signalId?: string;
  roundId: string;
  stake: number;
  target: number;
  entryTimestamp: string;
  mode: 'DRY_RUN';
  status: VirtualTradeStatus;
  crashPoint?: number;
  pnl?: number;
  resolvedAt?: string;
}

export interface VirtualLedgerSnapshot {
  virtualBalance: number;
  initialBalance: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  trades: number;
  equity: number;
  maxDrawdown: number;
}

export class VirtualTradeLedger {
  private readonly logger = getLogger();
  private readonly trades = new Map<string, VirtualTrade>();
  private readonly byRound = new Map<string, string[]>();
  private readonly bySignal = new Set<string>();
  private balance: number;
  private readonly initialBalance: number;
  private peakEquity: number;
  private maxDrawdown = 0;
  private wins = 0;
  private losses = 0;
  private netPnl = 0;

  constructor(initialBalance = 10_000) {
    this.initialBalance = initialBalance;
    this.balance = initialBalance;
    this.peakEquity = initialBalance;
  }

  getBalance(): number {
    return this.balance;
  }

  openTrade(params: {
    virtualTradeId: string;
    tenantId?: string | null;
    sessionId?: string | null;
    predictionId?: string;
    signalId?: string;
    roundId: string;
    stake: number;
    target: number;
  }): VirtualTrade | null {
    if (params.signalId && this.bySignal.has(params.signalId)) {
      this.logger.debug({ component: 'VirtualLedger', signalId: params.signalId }, 'Duplicate signal — ignored');
      return null;
    }
    if (params.stake > this.balance) {
      this.logger.warn({ component: 'VirtualLedger', stake: params.stake, balance: this.balance }, 'Insufficient virtual balance');
      return null;
    }

    const trade: VirtualTrade = {
      virtualTradeId: params.virtualTradeId,
      tenantId: params.tenantId ?? null,
      sessionId: params.sessionId ?? null,
      predictionId: params.predictionId,
      signalId: params.signalId,
      roundId: params.roundId,
      stake: params.stake,
      target: params.target,
      entryTimestamp: new Date().toISOString(),
      mode: 'DRY_RUN',
      status: 'OPEN',
    };

    this.trades.set(trade.virtualTradeId, trade);
    const list = this.byRound.get(params.roundId) ?? [];
    list.push(trade.virtualTradeId);
    this.byRound.set(params.roundId, list);
    if (params.signalId) this.bySignal.add(params.signalId);

    this.balance -= params.stake;
    this.updateDrawdown();

    this.logger.info(
      { component: 'VirtualLedger', tradeId: trade.virtualTradeId, roundId: params.roundId, stake: params.stake, target: params.target },
      'Virtual trade opened'
    );
    return trade;
  }

  /** Resolve all OPEN trades for a round when Crash ends. */
  resolveRound(roundId: string, crashPoint: number): VirtualTrade[] {
    const ids = this.byRound.get(roundId) ?? [];
    const resolved: VirtualTrade[] = [];

    for (const id of ids) {
      const trade = this.trades.get(id);
      if (!trade || trade.status !== 'OPEN') continue;

      const win = crashPoint >= trade.target;
      if (win) {
        const payout = trade.stake * trade.target;
        trade.status = 'WIN';
        trade.pnl = payout - trade.stake;
        this.balance += payout;
        this.wins++;
        this.netPnl += trade.pnl;
      } else {
        trade.status = 'LOSS';
        trade.pnl = -trade.stake;
        this.losses++;
        this.netPnl += trade.pnl;
      }
      trade.crashPoint = crashPoint;
      trade.resolvedAt = new Date().toISOString();
      this.updateDrawdown();
      resolved.push(trade);

      this.logger.info(
        {
          component: 'VirtualLedger',
          tradeId: trade.virtualTradeId,
          roundId,
          crashPoint,
          target: trade.target,
          status: trade.status,
          pnl: trade.pnl,
        },
        'Virtual trade resolved'
      );
    }

    return resolved;
  }

  snapshot(): VirtualLedgerSnapshot {
    const open = [...this.trades.values()].filter((t) => t.status === 'OPEN').length;
    const trades = this.wins + this.losses;
    return {
      virtualBalance: this.balance,
      initialBalance: this.initialBalance,
      openTrades: open,
      wins: this.wins,
      losses: this.losses,
      winRate: trades > 0 ? this.wins / trades : 0,
      netPnl: this.netPnl,
      trades,
      equity: this.balance,
      maxDrawdown: this.maxDrawdown,
    };
  }

  private updateDrawdown(): void {
    if (this.balance > this.peakEquity) this.peakEquity = this.balance;
    const dd = this.peakEquity > 0 ? (this.peakEquity - this.balance) / this.peakEquity : 0;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }
}

let globalLedger: VirtualTradeLedger | null = null;

export function getVirtualLedger(initialBalance = 10_000): VirtualTradeLedger {
  if (!globalLedger) globalLedger = new VirtualTradeLedger(initialBalance);
  return globalLedger;
}

export function resetVirtualLedger(initialBalance = 10_000): VirtualTradeLedger {
  globalLedger = new VirtualTradeLedger(initialBalance);
  return globalLedger;
}
