/**
 * P1-02: Central settlement authority — only path that credits balances / closes bets.
 * Adapters must call this instead of mutating balances directly.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../persistence/client.js';
import { getLogger } from '../observability/logger.js';

const logger = getLogger();

export type SettleWinInput = {
  betId: string;
  userId: string;
  multiplier: number;
  amount: number;
  reason: 'manual_cashout' | 'auto_cashout' | 'round_settlement';
};

export class SettlementService {
  /**
   * Atomic win settlement: bet must be placed|active → cashed_out; credit balance once.
   */
  async settleWin(input: SettleWinInput, client?: PoolClient): Promise<{ ok: boolean; pnl: number }> {
    const own = !client;
    const c = client ?? (await getPool().connect());
    try {
      if (own) await c.query('BEGIN');
      const pnl = input.amount * (input.multiplier - 1);
      const payout = input.amount + pnl;
      const settled = await c.query(
        `UPDATE mini_app_bets
         SET state = 'cashed_out', cashout_multiplier = $1, pnl = $2, settled_at = NOW()
         WHERE id = $3 AND user_id = $4 AND state IN ('placed', 'active')
         RETURNING id`,
        [input.multiplier, pnl, input.betId, input.userId]
      );
      if (settled.rowCount === 0) {
        if (own) await c.query('ROLLBACK');
        return { ok: false, pnl: 0 };
      }
      await c.query(
        `INSERT INTO mini_app_balances(user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
        [input.userId]
      );
      await c.query(
        `UPDATE mini_app_balances SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2`,
        [payout, input.userId]
      );
      if (own) await c.query('COMMIT');
      logger.info(
        { component: 'SettlementService', betId: input.betId, reason: input.reason, pnl },
        'Win settled'
      );
      return { ok: true, pnl };
    } catch (err) {
      if (own) await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      if (own) c.release();
    }
  }
}

export const settlementService = new SettlementService();
