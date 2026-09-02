/**
 * Authoritative Settlement Engine
 * Double-entry ledger, SERIALIZABLE transactions, idempotent by client_order_id.
 *
 * Accounting model (balanced per order):
 *
 * INTENT (lock wager W):
 *   Debit  LIABILITY:UNSETTLED_EXPOSURE  W   (open exposure / restricted capital)
 *   Credit ASSET:CASINO_HOT_WALLET       W   (available hot-wallet ↓)
 *
 * SETTLEMENT LOSS (grossPayout = 0):
 *   Debit  EQUITY:REALIZED_PNL           W
 *   Credit LIABILITY:UNSETTLED_EXPOSURE  W   (close exposure; loss recognized)
 *
 * SETTLEMENT WIN (grossPayout = G ≥ W):
 *   Debit  ASSET:CASINO_HOT_WALLET       G   (payout received)
 *   Credit LIABILITY:UNSETTLED_EXPOSURE  W   (close exposure)
 *   Credit EQUITY:REALIZED_PNL         G−W   (profit)
 *
 * SETTLEMENT VOID (no external execution / refund):
 *   Debit  ASSET:CASINO_HOT_WALLET       W
 *   Credit LIABILITY:UNSETTLED_EXPOSURE  W   (release lock, no PnL)
 *
 * assertBalanced() enforces Σ debit = Σ credit for the order.
 */
import type { Pool, PoolClient } from 'pg';
import { getLogger } from '../observability/logger';
import { OperationalError } from '../utils/errors';
import { withRetry } from '../utils/retry';
import {
  SettlementPayloadSchema,
  type SettlementPayload,
  type CreateOrderIntent,
  LEDGER_ACCOUNTS,
} from './types';

const logger = () => getLogger().child({ component: 'AuthoritativeSettlement' });

export class AuthoritativeSettlementEngine {
  constructor(private readonly pool: Pool) {}

  /**
   * Phase 1 — Intent: debit UNSETTLED (open exposure), credit HOT_WALLET (lock funds).
   * Must run inside the same logical unit as bet creation when possible.
   */
  async createOrderIntent(intent: CreateOrderIntent): Promise<{ orderId: string }> {
    return withRetry(() => this.createOrderIntentOnce(intent), { maxRetries: 4, baseDelayMs: 25, maxDelayMs: 500, shouldRetry: (e) => String((e as { code?: string }).code ?? '') === '40001' });
  }

  private async createOrderIntentOnce(intent: CreateOrderIntent): Promise<{ orderId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      const existing = await client.query(
        `SELECT id, status FROM settlement_orders WHERE client_order_id = $1 FOR UPDATE`,
        [intent.clientOrderId]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        await client.query('ROLLBACK');
        return { orderId: existing.rows[0].id };
      }

      const ins = await client.query<{ id: string }>(
        `INSERT INTO settlement_orders (
           client_order_id, tenant_id, bet_id, game_id, round_id,
           wager_amount, target_multiplier, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ORDER_INTENT')
         RETURNING id`,
        [
          intent.clientOrderId,
          intent.tenantId ?? null,
          intent.betId ?? null,
          intent.gameId ?? null,
          intent.roundId ?? null,
          intent.wagerAmount,
          intent.targetMultiplier,
        ]
      );
      const orderId = ins.rows[0]!.id;

      // Balanced pair: Debit UNSETTLED (open exposure), Credit HOT_WALLET (lock capital)
      await this.insertEntry(client, orderId, LEDGER_ACCOUNTS.UNSETTLED, intent.wagerAmount, 0, 'exposure open');
      await this.insertEntry(client, orderId, LEDGER_ACCOUNTS.HOT_WALLET, 0, intent.wagerAmount, 'wager lock');

      await this.assertBalanced(client, orderId);
      await client.query('COMMIT');
      logger().info({ orderId, clientOrderId: intent.clientOrderId }, 'Order intent created');
      return { orderId };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async markDispatched(clientOrderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE settlement_orders SET status = 'DISPATCHED', updated_at = now()
       WHERE client_order_id = $1 AND status = 'ORDER_INTENT'`,
      [clientOrderId]
    );
  }

  async markReconciling(clientOrderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE settlement_orders SET status = 'RECONCILING', updated_at = now()
       WHERE client_order_id = $1 AND status IN ('DISPATCHED','PENDING_SETTLEMENT','ORDER_INTENT')`,
      [clientOrderId]
    );
  }

  /**
   * Phase 3–4 — Authoritative settlement (idempotent).
   */
  async settleOrder(payload: SettlementPayload): Promise<{ settled: boolean; alreadyFinal?: boolean }> {
    return withRetry(() => this.settleOrderOnce(payload), { maxRetries: 4, baseDelayMs: 25, maxDelayMs: 500, shouldRetry: (e) => String((e as { code?: string }).code ?? '') === '40001' });
  }

  private async settleOrderOnce(payload: SettlementPayload): Promise<{ settled: boolean; alreadyFinal?: boolean }> {
    const data = SettlementPayloadSchema.parse(payload);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      const orderRes = await client.query(
        `SELECT id, status, wager_amount FROM settlement_orders
         WHERE client_order_id = $1 FOR UPDATE`,
        [data.clientOrderId]
      );

      if (!orderRes.rowCount) {
        throw new OperationalError(`Order intent not found: ${data.clientOrderId}`, 'SETTLEMENT_ORDER_NOT_FOUND');
      }

      const order = orderRes.rows[0];
      if (['SETTLED_WIN', 'SETTLED_LOSS', 'VOID'].includes(order.status)) {
        await client.query('ROLLBACK');
        return { settled: false, alreadyFinal: true };
      }

      const wager = Number(order.wager_amount);
      const gross = Number(data.grossPayout);
      const netPnl = gross - wager;
      const finalStatus =
        data.status === 'WIN' ? 'SETTLED_WIN' : data.status === 'LOSS' ? 'SETTLED_LOSS' : 'VOID';

      if (data.status === 'VOID') {
        // Release lock: reverse the intent (refund to hot wallet, close exposure)
        await this.insertEntry(client, order.id, LEDGER_ACCOUNTS.HOT_WALLET, wager, 0, 'void refund');
        await this.insertEntry(client, order.id, LEDGER_ACCOUNTS.UNSETTLED, 0, wager, 'exposure close void');
      } else if (data.status === 'LOSS') {
        // Close exposure against realized loss (no payout)
        await this.insertEntry(client, order.id, LEDGER_ACCOUNTS.REALIZED_PNL, wager, 0, 'pnl loss');
        await this.insertEntry(client, order.id, LEDGER_ACCOUNTS.UNSETTLED, 0, wager, 'exposure close');
      } else {
        // WIN: receive gross payout, close exposure, book net profit
        if (gross > 0) {
          await this.insertEntry(
            client,
            order.id,
            LEDGER_ACCOUNTS.HOT_WALLET,
            gross,
            0,
            'payout'
          );
        }
        await this.insertEntry(client, order.id, LEDGER_ACCOUNTS.UNSETTLED, 0, wager, 'exposure close');
        if (netPnl > 0) {
          await this.insertEntry(client, order.id, LEDGER_ACCOUNTS.REALIZED_PNL, 0, netPnl, 'pnl profit');
        } else if (netPnl < 0) {
          // Edge case: reported WIN with gross < wager — treat residual as loss
          await this.insertEntry(client, order.id, LEDGER_ACCOUNTS.REALIZED_PNL, Math.abs(netPnl), 0, 'pnl residual');
        }
      }

      await this.assertBalanced(client, order.id);

      await client.query(
        `UPDATE settlement_orders
         SET status = $1, gross_payout = $2, exit_multiplier = $3,
             settled_at = to_timestamp($4 / 1000.0),
             external_reference = COALESCE($5, external_reference),
             evidence = COALESCE(evidence, '{}'::jsonb) || COALESCE($6::jsonb, '{}'::jsonb),
             updated_at = now()
         WHERE id = $7`,
        [
          finalStatus,
          data.grossPayout,
          data.multiplier,
          data.settledAt,
          data.externalReference ?? null,
          JSON.stringify(data.evidence ?? {}),
          order.id,
        ]
      );

      await client.query('COMMIT');
      logger().info(
        { clientOrderId: data.clientOrderId, finalStatus, netPnl },
        'Order settled authoritatively'
      );
      return { settled: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertEntry(
    client: PoolClient,
    orderId: string,
    account: string,
    debit: number,
    credit: number,
    memo?: string
  ): Promise<void> {
    if (debit === 0 && credit === 0) return;
    await client.query(
      `INSERT INTO ledger_entries (order_id, account, debit, credit, memo)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, account, debit.toFixed(8), credit.toFixed(8), memo ?? null]
    );
  }

  private async assertBalanced(client: PoolClient, orderId: string): Promise<void> {
    const r = await client.query<{ d: string; c: string }>(
      `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c
       FROM ledger_entries WHERE order_id = $1`,
      [orderId]
    );
    const d = Number(r.rows[0]?.d ?? 0);
    const c = Number(r.rows[0]?.c ?? 0);
    if (Math.abs(d - c) > 1e-8) {
      throw new Error(`Ledger imbalance for order ${orderId}: debit=${d} credit=${c}`);
    }
  }

  /**
   * Account balance from journal.
   * Assets: debits − credits (positive = higher asset)
   * Liabilities / Equity: credits − debits (positive = higher liability/equity)
   * This helper returns raw debit−credit; callers interpret by account type.
   */
  async getAccountBalance(account: string): Promise<number> {
    const r = await this.pool.query<{ balance: string }>(
      `SELECT balance FROM ledger_balance_cache WHERE account = $1`,
      [account],
    );
    return Number(r.rows[0]?.balance ?? 0);
  }
}
