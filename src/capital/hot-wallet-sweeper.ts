/**
 * Hot-Wallet Sweeping
 * Keep only session liquidity buffer L_hot on the platform.
 * Auto-withdraw net earnings above thresholds.
 */
import { getLogger } from '../observability/logger';
const logger = () => getLogger().child({ component: 'HotWalletSweeper' });

export interface SweeperConfig {
  /** Max balance to keep on platform (hot buffer) */
  hotBuffer: number;
  /** Trigger withdrawal when balance exceeds this */
  withdrawThreshold: number;
  /** Minimum withdrawal amount */
  minWithdrawAmount: number;
  /** Cooldown between sweeps (ms) */
  cooldownMs: number;
  enabled: boolean;
}

export type WithdrawFn = (amount: number) => Promise<{ ok: boolean; txId?: string; error?: string }>;

export class HotWalletSweeper {
  private lastSweepAt = 0;
  constructor(private config: SweeperConfig, private withdraw: WithdrawFn) {}

  async maybeSweep(currentBalance: number): Promise<{ swept: boolean; amount?: number; txId?: string }> {
    if (!this.config.enabled) return { swept: false };
    if (currentBalance < this.config.withdrawThreshold) return { swept: false };
    if (Date.now() - this.lastSweepAt < this.config.cooldownMs) return { swept: false };

    const excess = currentBalance - this.config.hotBuffer;
    if (excess < this.config.minWithdrawAmount) return { swept: false };

    logger().info({ currentBalance, excess }, 'Initiating hot-wallet sweep');
    const result = await this.withdraw(excess);
    this.lastSweepAt = Date.now();
    if (result.ok) {
      logger().info({ amount: excess, txId: result.txId }, 'Sweep completed');
      return { swept: true, amount: excess, txId: result.txId };
    }
    logger().error({ error: result.error }, 'Sweep failed');
    return { swept: false };
  }
}
