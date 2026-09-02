/**
 * Boot-time reconcile of all open settlement_orders.
 * Runs once at process start before accepting new strategy signals.
 */
import type { Pool } from 'pg';
import { getLogger } from '../observability/logger';
import { AuthoritativeSettlementEngine } from './authoritative-settlement-engine';
import type { SettlementEvidenceProvider } from './evidence-provider';

const logger = () => getLogger().child({ component: 'BootReconcile' });

export interface BootReconcileResult {
  open: number;
  settled: number;
  voided: number;
  stillOpen: number;
  errors: number;
}

/**
 * Reconcile every non-final settlement order at boot.
 * - Evidence WIN/LOSS/VOID → settleOrder
 * - Evidence PENDING → mark RECONCILING
 * - No evidence → keep open / reconcile later; never infer VOID from age
 * - No evidence & young → leave open (stillOpen)
 */
export async function bootReconcileOpenOrders(
  pool: Pool,
  evidenceProvider: SettlementEvidenceProvider | null,
  opts?: { limit?: number }
): Promise<BootReconcileResult> {
  const limit = opts?.limit ?? 200;
  const engine = new AuthoritativeSettlementEngine(pool);
  const result: BootReconcileResult = { open: 0, settled: 0, voided: 0, stillOpen: 0, errors: 0 };

  const res = await pool.query<{
    id: string;
    client_order_id: string;
    status: string;
    wager_amount: string;
    created_at: Date;
  }>(
    `SELECT id, client_order_id, status, wager_amount, created_at
     FROM settlement_orders
     WHERE status NOT IN ('SETTLED_WIN', 'SETTLED_LOSS', 'VOID', 'FAILED')
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );

  result.open = res.rowCount ?? 0;
  logger().info({ open: result.open }, 'Boot reconcile scanning open settlement orders');

  for (const row of res.rows) {
    try {
      if (evidenceProvider) {
        const ev = await evidenceProvider.getEvidence({ clientOrderId: row.client_order_id });
        if (ev && (ev.status === 'WIN' || ev.status === 'LOSS' || ev.status === 'VOID')) {
          await engine.settleOrder({
            clientOrderId: row.client_order_id,
            status: ev.status,
            grossPayout:
              ev.grossPayout ??
              (ev.status === 'WIN' ? Number(row.wager_amount) : ev.status === 'VOID' ? Number(row.wager_amount) : 0),
            multiplier: Math.max(1, ev.multiplier ?? 1),
            settledAt: Date.now(),
            externalReference: ev.externalTxRef ?? ev.externalBetId,
            evidence: { source: ev.source, raw: ev.raw, boot: true },
          });
          result.settled++;
          continue;
        }
        if (ev?.status === 'PENDING') {
          await engine.markReconciling(row.client_order_id);
          result.stillOpen++;
          continue;
        }
      }

      // No evidence is never evidence of VOID. Keep the order open and reconcile later.
      await engine.markReconciling(row.client_order_id);
      result.stillOpen++;
    } catch (err) {
      result.errors++;
      logger().error({ clientOrderId: row.client_order_id, error: String(err) }, 'Boot reconcile item failed');
    }
  }

  logger().info(result, 'Boot reconcile complete');
  return result;
}
