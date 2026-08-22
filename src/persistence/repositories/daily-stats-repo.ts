/**
 * DailyStatsRepository — persistence for aggregated daily metrics.
 */

import { getPool } from '../client.js';

export interface DailyStatsRecord {
  dailyKey: string;
  entriesConfirmed: number;
  entriesAttempted: number;
  entriesFailed: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  balanceStart: number | null;
  balanceEnd: number | null;
  maxDrawdown: number;
  currentDrawdown: number;
  hitRate: number | null;
  averageLatencyMs: number | null;
  cashOutSuccessRate: number | null;
  tenantId?: string | null;
  updatedAt?: Date;
  createdAt?: Date;
}

function rowToRecord(row: Record<string, unknown>): DailyStatsRecord {
  return {
    dailyKey: String(row.daily_key),
    entriesConfirmed: Number(row.entries_confirmed ?? 0),
    entriesAttempted: Number(row.entries_attempted ?? 0),
    entriesFailed: Number(row.entries_failed ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    grossProfit: parseFloat(String(row.gross_profit ?? 0)),
    grossLoss: parseFloat(String(row.gross_loss ?? 0)),
    netPnl: parseFloat(String(row.net_pnl ?? 0)),
    balanceStart: row.balance_start != null ? parseFloat(String(row.balance_start)) : null,
    balanceEnd: row.balance_end != null ? parseFloat(String(row.balance_end)) : null,
    maxDrawdown: parseFloat(String(row.max_drawdown ?? 0)),
    currentDrawdown: parseFloat(String(row.current_drawdown ?? 0)),
    hitRate: row.hit_rate != null ? parseFloat(String(row.hit_rate)) : null,
    averageLatencyMs: row.average_latency_ms != null ? parseFloat(String(row.average_latency_ms)) : null,
    cashOutSuccessRate:
      row.cash_out_success_rate != null ? parseFloat(String(row.cash_out_success_rate)) : null,
    tenantId: row.tenant_id != null ? String(row.tenant_id) : null,
    updatedAt: row.updated_at as Date | undefined,
    createdAt: row.created_at as Date | undefined,
  };
}

export class DailyStatsRepository {
  async findByKey(dailyKey: string, tenantId?: string): Promise<DailyStatsRecord | null> {
    const pool = getPool();
    if (tenantId) {
      const r = await pool.query(
        `SELECT * FROM daily_stats WHERE daily_key = $1 AND tenant_id = $2`,
        [dailyKey, tenantId]
      );
      return r.rows[0] ? rowToRecord(r.rows[0]) : null;
    }
    const r = await pool.query(`SELECT * FROM daily_stats WHERE daily_key = $1`, [dailyKey]);
    return r.rows[0] ? rowToRecord(r.rows[0]) : null;
  }

  async upsert(stats: Partial<DailyStatsRecord> & { dailyKey: string }): Promise<DailyStatsRecord> {
    const pool = getPool();
    const r = await pool.query(
      `INSERT INTO daily_stats (
         daily_key, entries_confirmed, entries_attempted, entries_failed,
         wins, losses, gross_profit, gross_loss, net_pnl,
         balance_start, balance_end, max_drawdown, current_drawdown,
         hit_rate, average_latency_ms, cash_out_success_rate, tenant_id, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW()
       )
       ON CONFLICT (daily_key) DO UPDATE SET
         entries_confirmed = EXCLUDED.entries_confirmed,
         entries_attempted = EXCLUDED.entries_attempted,
         entries_failed = EXCLUDED.entries_failed,
         wins = EXCLUDED.wins,
         losses = EXCLUDED.losses,
         gross_profit = EXCLUDED.gross_profit,
         gross_loss = EXCLUDED.gross_loss,
         net_pnl = EXCLUDED.net_pnl,
         balance_start = COALESCE(EXCLUDED.balance_start, daily_stats.balance_start),
         balance_end = COALESCE(EXCLUDED.balance_end, daily_stats.balance_end),
         max_drawdown = EXCLUDED.max_drawdown,
         current_drawdown = EXCLUDED.current_drawdown,
         hit_rate = EXCLUDED.hit_rate,
         average_latency_ms = EXCLUDED.average_latency_ms,
         cash_out_success_rate = EXCLUDED.cash_out_success_rate,
         tenant_id = COALESCE(EXCLUDED.tenant_id, daily_stats.tenant_id),
         updated_at = NOW()
       RETURNING *`,
      [
        stats.dailyKey,
        stats.entriesConfirmed ?? 0,
        stats.entriesAttempted ?? 0,
        stats.entriesFailed ?? 0,
        stats.wins ?? 0,
        stats.losses ?? 0,
        stats.grossProfit ?? 0,
        stats.grossLoss ?? 0,
        stats.netPnl ?? 0,
        stats.balanceStart ?? null,
        stats.balanceEnd ?? null,
        stats.maxDrawdown ?? 0,
        stats.currentDrawdown ?? 0,
        stats.hitRate ?? null,
        stats.averageLatencyMs ?? null,
        stats.cashOutSuccessRate ?? null,
        stats.tenantId ?? null,
      ]
    );
    return rowToRecord(r.rows[0]);
  }

  async increment(
    dailyKey: string,
    delta: {
      entriesConfirmed?: number;
      entriesAttempted?: number;
      entriesFailed?: number;
      wins?: number;
      losses?: number;
      grossProfit?: number;
      grossLoss?: number;
      netPnl?: number;
    }
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO daily_stats (daily_key, entries_confirmed, entries_attempted, entries_failed, wins, losses, gross_profit, gross_loss, net_pnl, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (daily_key) DO UPDATE SET
         entries_confirmed = daily_stats.entries_confirmed + EXCLUDED.entries_confirmed,
         entries_attempted = daily_stats.entries_attempted + EXCLUDED.entries_attempted,
         entries_failed = daily_stats.entries_failed + EXCLUDED.entries_failed,
         wins = daily_stats.wins + EXCLUDED.wins,
         losses = daily_stats.losses + EXCLUDED.losses,
         gross_profit = daily_stats.gross_profit + EXCLUDED.gross_profit,
         gross_loss = daily_stats.gross_loss + EXCLUDED.gross_loss,
         net_pnl = daily_stats.net_pnl + EXCLUDED.net_pnl,
         updated_at = NOW()`,
      [
        dailyKey,
        delta.entriesConfirmed ?? 0,
        delta.entriesAttempted ?? 0,
        delta.entriesFailed ?? 0,
        delta.wins ?? 0,
        delta.losses ?? 0,
        delta.grossProfit ?? 0,
        delta.grossLoss ?? 0,
        delta.netPnl ?? 0,
      ]
    );
  }

  async listRecent(limit = 30, tenantId?: string): Promise<DailyStatsRecord[]> {
    const pool = getPool();
    const r = tenantId
      ? await pool.query(
          `SELECT * FROM daily_stats WHERE tenant_id = $1 ORDER BY daily_key DESC LIMIT $2`,
          [tenantId, limit]
        )
      : await pool.query(`SELECT * FROM daily_stats ORDER BY daily_key DESC LIMIT $1`, [limit]);
    return r.rows.map(rowToRecord);
  }
}
