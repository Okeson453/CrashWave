/**
 * Admin performance monitoring — per-user and platform-wide metrics.
 * Queries tenant_instances, bets, daily_stats for real-time and historical views.
 */

import { getPool } from '../../persistence/client.js';

export interface UserPerformance {
  pnlToday: number;
  pnlTotal: number;
  winRate: number;
  totalBets: number;
  wins: number;
  losses: number;
  avgMultiplier: number;
  biggestWin: number;
  biggestLoss: number;
  currentStreak: number;
  engineStatus: string;
  mode: string;
  uptimeMinutes: number;
  entriesUsed: number;
  entriesLimit: number;
  lastHeartbeat: string | null;
  dailyTrend: Array<{ date: string; pnl: number; bets: number }>;
  last10Bets: Array<{
    time: string;
    stake: number;
    target: number;
    actual: number | null;
    result: string;
    profit: number | null;
  }>;
}

export interface PlatformStats {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  bannedUsers: number;
  activeEngines: number;
  pausedEngines: number;
  errorEngines: number;
  totalPnlToday: number;
  totalPnlAllTime: number;
  avgWinRate: number;
  subsActive: number;
  topPerformer: { userId: string; telegramId: string; pnl: number } | null;
  worstPerformer: { userId: string; telegramId: string; pnl: number } | null;
}

export class PerformanceMonitor {
  

  async getUserPerformance(userId: string, entriesLimit = 100): Promise<UserPerformance | null> {
    const db = getPool();

    const instanceResult = await db.query(
      `SELECT status, mode, daily_entries_used, pnl_today, pnl_total, last_heartbeat,
              EXTRACT(EPOCH FROM (NOW() - COALESCE(last_heartbeat, NOW()))) AS age_sec
       FROM tenant_instances WHERE user_id = $1`,
      [userId]
    );
    if (instanceResult.rows.length === 0) {
      // Still return zeros if user exists but no instance
      const userCheck = await db.query(`SELECT id FROM users WHERE id = $1`, [userId]);
      if (userCheck.rows.length === 0) return null;
    }

    const instance = instanceResult.rows[0] ?? {};

    const todayStats = await db.query(
      `SELECT
         COUNT(*)::int AS total_bets,
         COUNT(*) FILTER (WHERE state = 'CASHED_OUT')::int AS wins,
         COUNT(*) FILTER (WHERE state = 'LOST')::int AS losses,
         AVG(confirmed_cash_out_multiplier) FILTER (WHERE confirmed_cash_out_multiplier IS NOT NULL) AS avg_multiplier,
         MAX(pnl) FILTER (WHERE pnl IS NOT NULL AND pnl > 0) AS biggest_win,
         MIN(pnl) FILTER (WHERE pnl IS NOT NULL AND pnl < 0) AS biggest_loss
       FROM bets
       WHERE tenant_id = $1 AND created_at >= CURRENT_DATE`,
      [userId]
    );
    const stats = todayStats.rows[0] ?? {};

    // Streak from most recent terminal bets
    const streakResult = await db.query(
      `SELECT state FROM bets
       WHERE tenant_id = $1 AND state IN ('CASHED_OUT', 'LOST')
       ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );
    let currentStreak = 0;
    if (streakResult.rows.length > 0) {
      const first = String(streakResult.rows[0].state);
      for (const row of streakResult.rows) {
        if (String(row.state) !== first) break;
        currentStreak += first === 'CASHED_OUT' ? 1 : -1;
      }
    }

    const trendResult = await db.query(
      `SELECT
         COALESCE(daily_key, to_char(created_at, 'YYYY-MM-DD')) AS date,
         COALESCE(SUM(pnl), 0) AS pnl,
         COUNT(*)::int AS bets
       FROM bets
       WHERE tenant_id = $1 AND created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY 1
       ORDER BY 1 DESC`,
      [userId]
    );

    const recentBets = await db.query(
      `SELECT created_at AS time, stake, cash_out_target AS target,
              confirmed_cash_out_multiplier AS actual, state AS result, pnl AS profit
       FROM bets
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    const totalBets = parseInt(String(stats.total_bets ?? 0), 10);
    const wins = parseInt(String(stats.wins ?? 0), 10);

    return {
      pnlToday: parseFloat(String(instance.pnl_today ?? 0)),
      pnlTotal: parseFloat(String(instance.pnl_total ?? 0)),
      winRate: totalBets > 0 ? (wins / totalBets) * 100 : 0,
      totalBets,
      wins,
      losses: parseInt(String(stats.losses ?? 0), 10),
      avgMultiplier: parseFloat(String(stats.avg_multiplier ?? 0)) || 0,
      biggestWin: parseFloat(String(stats.biggest_win ?? 0)) || 0,
      biggestLoss: parseFloat(String(stats.biggest_loss ?? 0)) || 0,
      currentStreak,
      engineStatus: String(instance.status ?? 'not_provisioned'),
      mode: String(instance.mode ?? 'n/a'),
      uptimeMinutes: Math.max(0, Math.floor((parseFloat(String(instance.age_sec ?? 0)) || 0) / 60)),
      entriesUsed: parseInt(String(instance.daily_entries_used ?? 0), 10),
      entriesLimit,
      lastHeartbeat: instance.last_heartbeat
        ? new Date(instance.last_heartbeat).toISOString()
        : null,
      dailyTrend: trendResult.rows.map((r) => ({
        date: String(r.date),
        pnl: parseFloat(String(r.pnl ?? 0)),
        bets: parseInt(String(r.bets ?? 0), 10),
      })),
      last10Bets: recentBets.rows.map((r) => ({
        time: r.time ? new Date(r.time).toISOString() : '',
        stake: parseFloat(String(r.stake ?? 0)),
        target: parseFloat(String(r.target ?? 0)),
        actual: r.actual != null ? parseFloat(String(r.actual)) : null,
        result: String(r.result ?? ''),
        profit: r.profit != null ? parseFloat(String(r.profit)) : null,
      })),
    };
  }

  async getPlatformStats(): Promise<PlatformStats> {
    const db = getPool();
    const result = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM users)::int AS total_users,
         (SELECT COUNT(*) FROM users WHERE status = 'active')::int AS active_users,
         (SELECT COUNT(*) FROM users WHERE status = 'suspended')::int AS suspended_users,
         (SELECT COUNT(*) FROM users WHERE status = 'banned')::int AS banned_users,
         (SELECT COUNT(*) FROM tenant_instances WHERE status = 'running')::int AS active_engines,
         (SELECT COUNT(*) FROM tenant_instances WHERE status = 'paused')::int AS paused_engines,
         (SELECT COUNT(*) FROM tenant_instances WHERE status = 'error')::int AS error_engines,
         (SELECT COALESCE(SUM(pnl_today), 0) FROM tenant_instances) AS total_pnl_today,
         (SELECT COALESCE(SUM(pnl_total), 0) FROM tenant_instances) AS total_pnl_all_time,
         (SELECT COUNT(*) FROM subscriptions WHERE status = 'active')::int AS subs_active`
    );
    const row = result.rows[0] ?? {};

    const winRateResult = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'CASHED_OUT')::float /
         NULLIF(COUNT(*) FILTER (WHERE state IN ('CASHED_OUT', 'LOST')), 0) * 100 AS avg_win_rate
       FROM bets WHERE created_at >= CURRENT_DATE`
    );

    const top = await db.query(
      `SELECT i.user_id, i.pnl_total, u.telegram_id
       FROM tenant_instances i
       JOIN users u ON u.id = i.user_id
       ORDER BY i.pnl_total DESC NULLS LAST LIMIT 1`
    );
    const worst = await db.query(
      `SELECT i.user_id, i.pnl_total, u.telegram_id
       FROM tenant_instances i
       JOIN users u ON u.id = i.user_id
       WHERE i.pnl_total < 0
       ORDER BY i.pnl_total ASC NULLS LAST LIMIT 1`
    );

    return {
      totalUsers: parseInt(String(row.total_users ?? 0), 10),
      activeUsers: parseInt(String(row.active_users ?? 0), 10),
      suspendedUsers: parseInt(String(row.suspended_users ?? 0), 10),
      bannedUsers: parseInt(String(row.banned_users ?? 0), 10),
      activeEngines: parseInt(String(row.active_engines ?? 0), 10),
      pausedEngines: parseInt(String(row.paused_engines ?? 0), 10),
      errorEngines: parseInt(String(row.error_engines ?? 0), 10),
      totalPnlToday: parseFloat(String(row.total_pnl_today ?? 0)),
      totalPnlAllTime: parseFloat(String(row.total_pnl_all_time ?? 0)),
      avgWinRate: parseFloat(String(winRateResult.rows[0]?.avg_win_rate ?? 0)) || 0,
      subsActive: parseInt(String(row.subs_active ?? 0), 10),
      topPerformer: top.rows[0]
        ? {
            userId: String(top.rows[0].user_id),
            telegramId: String(top.rows[0].telegram_id),
            pnl: parseFloat(String(top.rows[0].pnl_total ?? 0)),
          }
        : null,
      worstPerformer: worst.rows[0]
        ? {
            userId: String(worst.rows[0].user_id),
            telegramId: String(worst.rows[0].telegram_id),
            pnl: parseFloat(String(worst.rows[0].pnl_total ?? 0)),
          }
        : null,
    };
  }

  async getLeaderboard(limit = 10): Promise<Array<{ telegramId: string; username: string | null; pnl: number }>> {
    const result = await getPool().query(
      `SELECT u.telegram_id, u.telegram_username, i.pnl_total
       FROM tenant_instances i
       JOIN users u ON u.id = i.user_id
       WHERE u.status = 'active'
       ORDER BY i.pnl_total DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((r) => ({
      telegramId: String(r.telegram_id),
      username: r.telegram_username ? String(r.telegram_username) : null,
      pnl: parseFloat(String(r.pnl_total ?? 0)),
    }));
  }

  async getLosers(limit = 10): Promise<Array<{ telegramId: string; username: string | null; pnl: number }>> {
    const result = await getPool().query(
      `SELECT u.telegram_id, u.telegram_username, i.pnl_total
       FROM tenant_instances i
       JOIN users u ON u.id = i.user_id
       WHERE i.pnl_total < 0 AND u.status = 'active'
       ORDER BY i.pnl_total ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((r) => ({
      telegramId: String(r.telegram_id),
      username: r.telegram_username ? String(r.telegram_username) : null,
      pnl: parseFloat(String(r.pnl_total ?? 0)),
    }));
  }

  async getInactiveUsers(hours = 24): Promise<Array<{ userId: string; telegramId: string; lastBet: string | null }>> {
    const result = await getPool().query(
      `SELECT u.id, u.telegram_id, MAX(b.created_at) AS last_bet
       FROM users u
       LEFT JOIN bets b ON b.tenant_id = u.id
       WHERE u.status = 'active'
       GROUP BY u.id, u.telegram_id
       HAVING MAX(b.created_at) IS NULL OR MAX(b.created_at) < NOW() - ($1 || ' hours')::interval
       ORDER BY last_bet ASC NULLS FIRST
       LIMIT 50`,
      [String(hours)]
    );
    return result.rows.map((r) => ({
      userId: String(r.id),
      telegramId: String(r.telegram_id),
      lastBet: r.last_bet ? new Date(r.last_bet).toISOString() : null,
    }));
  }

  async getRecentBets(userId: string, n = 20): Promise<
    Array<{ time: string; stake: number; target: number; actual: number | null; state: string; pnl: number | null }>
  > {
    const result = await getPool().query(
      `SELECT created_at, stake, cash_out_target, confirmed_cash_out_multiplier, state, pnl
       FROM bets WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, n]
    );
    return result.rows.map((r) => ({
      time: r.created_at ? new Date(r.created_at).toISOString() : '',
      stake: parseFloat(String(r.stake ?? 0)),
      target: parseFloat(String(r.cash_out_target ?? 0)),
      actual: r.confirmed_cash_out_multiplier != null ? parseFloat(String(r.confirmed_cash_out_multiplier)) : null,
      state: String(r.state ?? ''),
      pnl: r.pnl != null ? parseFloat(String(r.pnl)) : null,
    }));
  }
}
