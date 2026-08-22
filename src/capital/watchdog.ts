/**
 * Out-of-Band Watchdog
 * Independent OS-level supervisor that queries balances on an isolated loop.
 * If B_panic breached → SIGKILL primary process + force-close sockets.
 *
 * This file is both importable logic and the basis for scripts/capital-watchdog.ts
 */
import { getLogger } from '../observability/logger';
const logger = () => getLogger().child({ component: 'CapitalWatchdog' });

export interface WatchdogConfig {
  panicBalanceFloor: number;
  pollIntervalMs: number;
  /** PID of the primary trading process */
  targetPid: number;
  enabled: boolean;
}

export type BalanceReader = () => Promise<number>;

export class CapitalWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private killed = false;

  constructor(private config: WatchdogConfig, private readBalance: BalanceReader) {}

  start(): void {
    if (!this.config.enabled || this.timer) return;
    logger().info({ floor: this.config.panicBalanceFloor, pid: this.config.targetPid }, 'Capital watchdog started');
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tick(): Promise<void> {
    if (this.killed) return;
    try {
      const bal = await this.readBalance();
      if (bal <= this.config.panicBalanceFloor) {
        logger().fatal({ balance: bal, floor: this.config.panicBalanceFloor }, 'PANIC FLOOR BREACHED — SIGKILL');
        this.killed = true;
        try { process.kill(this.config.targetPid, 'SIGKILL'); } catch (e) {
          logger().error({ err: e }, 'Failed to SIGKILL target');
        }
        // Also exit ourselves
        process.exit(99);
      }
    } catch (err) {
      logger().error({ err }, 'Watchdog balance read failed');
    }
  }
}
