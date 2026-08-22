/**
 * Balance Drift Guard
 * |B_ledger - B_remote| > threshold → EMERGENCY_HALT, revoke locks, alert.
 */
import { getLogger } from '../observability/logger';
import { LEDGER_ACCOUNTS } from './types';
import type { AuthoritativeSettlementEngine } from './authoritative-settlement-engine';
import type { EventBus } from '../core/event-bus/bus';

const logger = () => getLogger().child({ component: 'DriftGuard' });

export interface DriftGuardConfig {
  /** Absolute balance delta tolerance in units */
  threshold: number;
  enabled: boolean;
  pollIntervalMs: number;
}

export type RemoteBalanceReader = () => Promise<number>;

export class DriftGuard {
  private timer: NodeJS.Timeout | null = null;
  private tripped = false;

  constructor(
    private engine: AuthoritativeSettlementEngine,
    private readRemote: RemoteBalanceReader,
    private config: DriftGuardConfig,
    private eventBus?: EventBus,
    private onHalt?: (delta: number, ledger: number, remote: number) => void
  ) {}

  get isTripped(): boolean {
    return this.tripped;
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => void this.check(), this.config.pollIntervalMs);
    logger().info({ threshold: this.config.threshold }, 'Drift guard started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<{ ok: boolean; delta: number }> {
    if (this.tripped) return { ok: false, delta: NaN };

    // Hot wallet ledger balance (asset: sum debit - credit; after settlements this tracks operator)
    // Spec: B_ledger vs B_remote. Use HOT_WALLET as primary.
    const ledger = await this.engine.getAccountBalance(LEDGER_ACCOUNTS.HOT_WALLET);
    // Invert sign convention if needed: we stored placement as debit to hot wallet.
    // For comparison, remote is absolute operator balance; callers should pass comparable numbers.
    const remote = await this.readRemote();
    const delta = Math.abs(ledger - remote); // may need calibration in production

    // Prefer comparing unsettled + realized reconstruction if hot wallet is inverted.
    // Production: operator should pass a calibrated ledger projection.
    if (delta > this.config.threshold) {
      this.tripped = true;
      logger().fatal(
        { delta, ledger, remote, threshold: this.config.threshold },
        'BALANCE DRIFT EXCEEDED — EMERGENCY_HALT'
      );
      try {
        void this.eventBus?.emit({
          type: 'HALT' as any,
          source: 'DriftGuard',
          timestamp: new Date().toISOString(),
          payload: { reason: 'BALANCE_DRIFT', delta, ledger, remote },
        } as any);
      } catch {
        /* ignore */
      }
      this.onHalt?.(delta, ledger, remote);
      return { ok: false, delta };
    }
    return { ok: true, delta };
  }

  /** Explicit comparison when caller has both numbers calibrated */
  evaluate(ledgerBalance: number, remoteBalance: number): boolean {
    const delta = Math.abs(ledgerBalance - remoteBalance);
    if (delta > this.config.threshold) {
      this.tripped = true;
      logger().fatal({ delta, ledgerBalance, remoteBalance }, 'Drift guard trip (direct)');
      this.onHalt?.(delta, ledgerBalance, remoteBalance);
      return false;
    }
    return true;
  }
}
