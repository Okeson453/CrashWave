/**
 * Settlement reconciler — durable UNKNOWN/RECONCILING semantics.
 *
 * Orders stuck in DISPATCHED / PENDING_SETTLEMENT / RECONCILING past deadline
 * are marked RECONCILING and left for operator/provider resolution.
 * Absence of evidence is NEVER treated as proof of VOID.
 */
import type { Pool } from 'pg';
import { getLogger } from '../observability/logger';
import { AuthoritativeSettlementEngine } from '../settlement/authoritative-settlement-engine';
import type { SettlementEvidenceProvider } from '../settlement/evidence-provider';

const logger = () => getLogger().child({ component: 'SettlementReconciler' });

export interface ReconcilerConfig {
  /** Age after which non-final orders enter RECONCILING (ms) */
  reconcileDeadlineMs: number;
  pollIntervalMs: number;
  enabled: boolean;
  batchSize: number;
}

const DEFAULTS: ReconcilerConfig = {
  reconcileDeadlineMs: 15 * 60 * 1000, // 15 min
  pollIntervalMs: 60_000,
  enabled: true,
  batchSize: 50,
};

export class SettlementReconciler {
  private timer: NodeJS.Timeout | null = null;
  private readonly config: ReconcilerConfig;
  private readonly engine: AuthoritativeSettlementEngine;

  constructor(
    private readonly pool: Pool,
    private readonly evidenceProvider: SettlementEvidenceProvider | null,
    config?: Partial<ReconcilerConfig>
  ) {
    this.config = { ...DEFAULTS, ...config };
    this.engine = new AuthoritativeSettlementEngine(pool);
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    logger().info({ deadlineMs: this.config.reconcileDeadlineMs }, 'Settlement reconciler started');
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<{ processed: number; voided: number; settled: number; reconciling: number }> {
    let processed = 0;
    let voided = 0;
    let settled = 0;
    let reconciling = 0;

    const cutoff = new Date(Date.now() - this.config.reconcileDeadlineMs);
    const res = await this.pool.query<{
      id: string;
      client_order_id: string;
      status: string;
      wager_amount: string;
    }>(
      `SELECT id, client_order_id, status, wager_amount
       FROM settlement_orders
       WHERE status IN ('DISPATCHED', 'PENDING_SETTLEMENT', 'RECONCILING', 'ORDER_INTENT')
         AND created_at < $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [cutoff.toISOString(), this.config.batchSize]
    );

    for (const row of res.rows) {
      processed++;
      try {
        // Try authoritative evidence first
        if (this.evidenceProvider) {
          const ev = await this.evidenceProvider.getEvidence({
            clientOrderId: row.client_order_id,
          });
          if (ev && (ev.status === 'WIN' || ev.status === 'LOSS' || ev.status === 'VOID')) {
            // Only VOID when evidence explicitly proves no external execution
            await this.engine.settleOrder({
              clientOrderId: row.client_order_id,
              status: ev.status,
              grossPayout:
                ev.grossPayout ??
                (ev.status === 'WIN' ? Number(row.wager_amount) : ev.status === 'VOID' ? Number(row.wager_amount) : 0),
              multiplier: Math.max(1, ev.multiplier ?? 1),
              settledAt: Date.now(),
              externalReference: ev.externalTxRef ?? ev.externalBetId,
              evidence: { source: ev.source, raw: ev.raw },
            });
            if (ev.status === 'VOID') voided++;
            else settled++;
            logger().info(
              { clientOrderId: row.client_order_id, status: ev.status },
              'Reconciler settled from authoritative evidence'
            );
            continue;
          }
          if (ev && ev.status === 'PENDING') {
            await this.engine.markReconciling(row.client_order_id);
            reconciling++;
            continue;
          }
        }

        // No evidence after deadline → durable RECONCILING (UNKNOWN).
        // Never equate absence of evidence with VOID.
        if (row.status !== 'RECONCILING') {
          await this.engine.markReconciling(row.client_order_id);
          reconciling++;
          logger().warn(
            { clientOrderId: row.client_order_id, ageCutoff: cutoff.toISOString() },
            'Order marked RECONCILING — no authoritative evidence after deadline (requires operator/provider resolution)'
          );
        }
      } catch (err) {
        logger().error(
          { clientOrderId: row.client_order_id, error: String(err) },
          'Reconciler tick item failed'
        );
      }
    }

    if (processed > 0) {
      logger().info({ processed, settled, voided, reconciling }, 'Reconciler tick complete');
    }
    return { processed, settled, voided, reconciling };
  }
}
