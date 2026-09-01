/**
 * DryRunExecutor — production-compatible adapter that never submits real wagers.
 */
import { getLogger } from '../../observability/logger';
import { DryRunController, DryRunSignal } from './dry-run-controller';
import { randomUUID } from 'crypto';

export type DryRunOutcome = 'WIN' | 'LOSS' | 'VOID';

export interface DryRunExecution {
  tenantId: string;
  signalId: string;
  roundId: string;
  stake: number;
  targetMultiplier: number;
  entryMultiplier?: number;
  exitMultiplier?: number;
  outcome: DryRunOutcome;
  pnl: number;
  latencyMs: number;
  executedAt: Date;
}

export class DryRunExecutor {
  private readonly logger = getLogger();
  private readonly controller: DryRunController;
  private readonly pending = new Map<
    string,
    { signal: DryRunSignal; openedAt: number; stake: number; target: number }
  >();

  constructor(controller?: DryRunController) {
    this.controller = controller ?? new DryRunController();
  }

  getController(): DryRunController {
    return this.controller;
  }

  executeSignal(signal: DryRunSignal, tenantId = 'default'): DryRunExecution | null {
    const started = Date.now();
    const result = this.controller.evaluateAndSimulate(signal);
    if (!result.accepted) {
      this.logger.debug(
        { component: 'DryRunExecutor', reason: result.reason, signalId: signal.signalId },
        'Dry-run signal rejected'
      );
      return null;
    }
    const stake = signal.stake ?? 700;
    const target = signal.target ?? 1.3;
    this.pending.set(signal.roundId, { signal, openedAt: started, stake, target });
    return {
      tenantId,
      signalId: signal.signalId,
      roundId: signal.roundId,
      stake,
      targetMultiplier: target,
      outcome: 'VOID',
      pnl: 0,
      latencyMs: Date.now() - started,
      executedAt: new Date(),
    };
  }

  onRoundComplete(roundId: string, crashMultiplier: number, tenantId = 'default'): DryRunExecution[] {
    this.controller.onRoundCompleted(roundId, crashMultiplier);
    const open = this.pending.get(roundId);
    this.pending.delete(roundId);
    if (!open) return [];

    const win = crashMultiplier >= open.target;
    const pnl = win ? open.stake * (open.target - 1) : -open.stake;
    const exec: DryRunExecution = {
      tenantId,
      signalId: open.signal.signalId,
      roundId,
      stake: open.stake,
      targetMultiplier: open.target,
      entryMultiplier: 1,
      exitMultiplier: win ? open.target : crashMultiplier,
      outcome: win ? 'WIN' : 'LOSS',
      pnl,
      latencyMs: Date.now() - open.openedAt,
      executedAt: new Date(),
    };
    this.logger.info(
      { component: 'DryRunExecutor', roundId, outcome: exec.outcome, pnl: exec.pnl },
      'Dry-run execution completed (simulated)'
    );
    return [exec];
  }

  formatSignalMessage(signal: DryRunSignal, stake: number): string {
    return [
      '🧪 DRY-RUN SIGNAL',
      '',
      `Round: #${signal.roundId}`,
      'Signal: ENTER',
      `Target: ${signal.target.toFixed(2)}x`,
      `Confidence: ${Math.round(signal.confidence * 100)}%`,
      `Stake: ₦${stake} (SIMULATED)`,
      '',
      'No real wager was placed.',
    ].join('\n');
  }

  formatResultMessage(exec: DryRunExecution): string {
    const sign = exec.pnl >= 0 ? '+' : '';
    return [
      '🧪 DRY-RUN RESULT',
      '',
      `Round: #${exec.roundId}`,
      `Target: ${exec.targetMultiplier.toFixed(2)}x`,
      `Result: ${exec.outcome}`,
      `Simulated P/L: ${sign}₦${exec.pnl.toFixed(0)}`,
      '',
      'No real wager was placed.',
    ].join('\n');
  }
}

export function createDryRunExecutor(
  cfg?: ConstructorParameters<typeof DryRunController>[0]
): DryRunExecutor {
  return new DryRunExecutor(new DryRunController(cfg));
}

export function newDryRunSignalId(): string {
  return randomUUID();
}
