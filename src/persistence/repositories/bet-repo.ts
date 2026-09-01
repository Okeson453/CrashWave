import { Pool } from 'pg';
import { getLogger } from '../../observability/logger';
import { CriticalError, NotFoundError } from '../../utils/errors';
import { getPool } from '../client';
import { BetState } from '../../types/betting';
import { DailyStats } from '../../ledger/types';
import { randomUUID } from 'crypto';

/**
 * BetRecord represents a bet in the database.
 */
export interface BetRecord {
  id: string;
  sessionId: string | null;
  roundId: string | null;
  dailyKey: string;
  stake: number;
  cashOutTarget: number;
  state: BetState;
  requestedAt: string | null;
  placedAt: string | null;
  confirmedAt: string | null;
  cashOutRequestedAt: string | null;
  cashOutConfirmedAt: string | null;
  observedCashOutMultiplier: number | null;
  confirmedCashOutMultiplier: number | null;
  pnl: number | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input for creating a new bet record.
 */
export interface CreateBetInput {
  tenantId?: string | null;
  sessionId?: string | null;
  roundId?: string | null;
  dailyKey: string;
  stake: number;
  cashOutTarget: number;
  state?: BetState;
  balanceBefore?: number | null;
}

/**
 * Input for updating a bet record.
 */
export interface UpdateBetInput {
  sessionId?: string | null;
  roundId?: string | null;
  state?: BetState;
  requestedAt?: string | null;
  placedAt?: string | null;
  confirmedAt?: string | null;
  cashOutRequestedAt?: string | null;
  cashOutConfirmedAt?: string | null;
  observedCashOutMultiplier?: number | null;
  confirmedCashOutMultiplier?: number | null;
  pnl?: number | null;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  failureReason?: string | null;
  /** Immutable settlement evidence stored in the financial event, not mutable bet state. */
  externalReference?: string | null;
  settlementSource?: string | null;
  settlementEvidence?: Record<string, unknown>;
}

/**
 * BetRepository provides CRUD operations for bet records.
 *
 * Tracks the full lifecycle: PENDING → RESERVED → PLACED → CONFIRMED → ACTIVE
 * → CASH_OUT_REQUESTED → CASHED_OUT/LOST/FAILED/UNKNOWN/RECONCILED
 */
export class BetRepository {
  private readonly logger = getLogger();
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || getPool();
  }

  async create(input: CreateBetInput): Promise<BetRecord> {
    const query = `
      INSERT INTO bets (tenant_id, session_id, round_id, daily_key, stake, cash_out_target, state, balance_before)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(query, [
          input.tenantId ?? null, input.sessionId ?? null, input.roundId ?? null, input.dailyKey, input.stake,
          input.cashOutTarget, input.state ?? 'PENDING', input.balanceBefore ?? null,
        ]);
        const record = this.mapRow(result.rows[0]);
        const eventId = randomUUID();
        await client.query(
          `INSERT INTO financial_ledger_events
            (id, bet_id, tenant_id, event_type, amount, evidence, correlation_id)
           VALUES ($1, $2, NULLIF(current_setting('app.tenant_id', true), '')::uuid, 'BET_INTENDED', $3, $4::jsonb, $2)`,
          [eventId, record.id, record.stake, JSON.stringify({ state: record.state, target: record.cashOutTarget })]
        );
        await client.query(
          `SELECT enqueue_outbox_event($1,$2,$3::jsonb,$4,$5)`,
          [eventId, 'EntryApproved', JSON.stringify({ betId: record.id, roundId: record.roundId, stake: record.stake, target: record.cashOutTarget }), record.id, 'BetRepository']
        );
        await client.query('COMMIT');
        this.logger.info({ component: 'BetRepository', betId: record.id, state: record.state }, 'Bet created transactionally');
        return record;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to create bet');
      throw new CriticalError(`Bet creation failed: ${message}`, 'BET_CREATE_FAILED');
    }
  }

  async findById(id: string): Promise<BetRecord | null> {
    const query = `SELECT * FROM bets WHERE id = $1`;

    try {
      const result = await this.pool.query(query, [id]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to find bet');
      throw new CriticalError(`Bet find failed: ${message}`, 'BET_FIND_FAILED');
    }
  }

  async findByIdOrThrow(id: string): Promise<BetRecord> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundError('Bet', id);
    }
    return record;
  }

  async findBySessionId(sessionId: string, limit: number = 100): Promise<BetRecord[]> {
    const query = `
      SELECT * FROM bets
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [sessionId, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to find bets by session');
      throw new CriticalError(`Bet find by session failed: ${message}`, 'BET_FIND_SESSION_FAILED');
    }
  }

  async findByRoundId(roundId: string): Promise<BetRecord | null> {
    const query = `SELECT * FROM bets WHERE round_id = $1 ORDER BY created_at DESC LIMIT 1`;

    try {
      const result = await this.pool.query(query, [roundId]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to find bet by round');
      throw new CriticalError(`Bet find by round failed: ${message}`, 'BET_FIND_ROUND_FAILED');
    }
  }

  async findByUser(userId: string, opts: { limit?: number; status?: string; cursor?: string } = {}): Promise<BetRecord[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const params: unknown[] = [userId];
    const filters = ['tenant_id = $1'];
    if (opts.status) { params.push(opts.status.toUpperCase()); filters.push(`state = $${params.length}`); }
    if (opts.cursor) { params.push(opts.cursor); filters.push(`id < $${params.length}`); }
    params.push(limit);
    const query = `SELECT * FROM bets WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  async findByDailyKey(dailyKey: string): Promise<BetRecord[]> {
    const query = `
      SELECT * FROM bets
      WHERE daily_key = $1
      ORDER BY created_at ASC
    `;

    try {
      const result = await this.pool.query(query, [dailyKey]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to find bets by daily key');
      throw new CriticalError(`Bet find by daily key failed: ${message}`, 'BET_FIND_DAILY_FAILED');
    }
  }

  async findByState(state: BetState, limit: number = 100): Promise<BetRecord[]> {
    const query = `
      SELECT * FROM bets
      WHERE state = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [state, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to find bets by state');
      throw new CriticalError(`Bet find by state failed: ${message}`, 'BET_FIND_STATE_FAILED');
    }
  }

  /**
   * Stable-ordered pagination for balance reconciliation.
   * ORDER BY created_at ASC, id ASC is required so OFFSET pages do not overlap or skip rows.
   */
  async findByStatePaged(
    state: BetState,
    limit: number = 1000,
    offset: number = 0
  ): Promise<BetRecord[]> {
    const query = `
      SELECT * FROM bets
      WHERE state = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2
      OFFSET $3
    `;
    try {
      const result = await this.pool.query(query, [state, limit, offset]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'BetRepository', error: message, state, offset },
        'Failed to find bets by state (paged)'
      );
      throw new CriticalError(`Bet paged find by state failed: ${message}`, 'BET_FIND_STATE_PAGED_FAILED');
    }
  }

  async findActiveBets(): Promise<BetRecord[]> {
    const query = `
      SELECT * FROM bets
      WHERE state IN ('PLACED', 'CONFIRMED', 'ACTIVE', 'CASH_OUT_REQUESTED')
      ORDER BY created_at DESC
    `;

    try {
      const result = await this.pool.query(query);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to find active bets');
      throw new CriticalError(`Find active bets failed: ${message}`, 'BET_FIND_ACTIVE_FAILED');
    }
  }

  async findUnknownBets(limit: number = 100): Promise<BetRecord[]> {
    return this.findByState('UNKNOWN', limit);
  }

  async update(id: string, input: UpdateBetInput): Promise<BetRecord | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const addField = (name: string, value: unknown | undefined) => {
      if (value !== undefined) {
        fields.push(`${name} = $${paramIndex++}`);
        values.push(value);
      }
    };

    addField('session_id', input.sessionId);
    addField('round_id', input.roundId);
    addField('state', input.state);
    addField('requested_at', input.requestedAt);
    addField('placed_at', input.placedAt);
    addField('confirmed_at', input.confirmedAt);
    addField('cash_out_requested_at', input.cashOutRequestedAt);
    addField('cash_out_confirmed_at', input.cashOutConfirmedAt);
    addField('observed_cash_out_multiplier', input.observedCashOutMultiplier);
    addField('confirmed_cash_out_multiplier', input.confirmedCashOutMultiplier);
    addField('pnl', input.pnl);
    addField('balance_before', input.balanceBefore);
    addField('balance_after', input.balanceAfter);
    addField('failure_reason', input.failureReason);

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = NOW()');
    values.push(id);
    const query = `UPDATE bets SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const before = await client.query('SELECT * FROM bets WHERE id = $1 FOR UPDATE', [id]);
        if (before.rows.length === 0) {
          await client.query('ROLLBACK');
          return null;
        }
        const previous = this.mapRow(before.rows[0]);
        const result = await client.query(query, values);
        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          return null;
        }
        const record = this.mapRow(result.rows[0]);

        if (input.state && input.state !== previous.state) {
          const eventId = randomUUID();
          const eventType = this.financialEventType(input.state);
          await client.query(
            `INSERT INTO financial_ledger_events
              (id, bet_id, tenant_id, event_type, amount, multiplier, evidence, correlation_id)
             VALUES ($1, $2, NULLIF(current_setting('app.tenant_id', true), '')::uuid, $3, $4, $5, $6::jsonb, $7)`,
            [
              eventId, id, eventType, record.pnl, record.confirmedCashOutMultiplier,
              JSON.stringify({ previousState: previous.state, newState: record.state, failureReason: record.failureReason, externalReference: input.externalReference ?? null, settlementSource: input.settlementSource ?? null, settlementEvidence: input.settlementEvidence ?? {} }), id,
            ]
          );
          const systemEvent = this.systemEventForState(input.state);
          if (systemEvent) {
            await client.query(
              `SELECT enqueue_outbox_event($1,$2,$3::jsonb,$4,$5)`,
              [eventId, systemEvent, JSON.stringify({ betId: id, previousState: previous.state, state: record.state, pnl: record.pnl, multiplier: record.confirmedCashOutMultiplier }), id, 'BetRepository']
            );
          }
        }

        await client.query('COMMIT');
        this.logger.debug({ component: 'BetRepository', betId: id, previousState: previous.state, newState: record.state }, 'Bet updated transactionally');
        return record;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to update bet');
      throw new CriticalError(`Bet update failed: ${message}`, 'BET_UPDATE_FAILED');
    }
  }

  private financialEventType(state: BetState): string {
    const map: Partial<Record<BetState, string>> = {
      RESERVED: 'BET_RESERVED', PLACED: 'BET_PLACED', CONFIRMED: 'BET_CONFIRMED',
      CASH_OUT_REQUESTED: 'CASH_OUT_REQUESTED', CASHED_OUT: 'CASH_OUT_CONFIRMED',
      LOST: 'BET_LOST', FAILED: 'BET_FAILED', UNKNOWN: 'BET_UNKNOWN', RECONCILED: 'RECONCILED',
    };
    return map[state] ?? 'BET_UNKNOWN';
  }

  private systemEventForState(state: BetState): string | null {
    const map: Partial<Record<BetState, string>> = {
      PLACED: 'BetPlaced', FAILED: 'BetFailed', CASH_OUT_REQUESTED: 'CashOutRequested',
      CASHED_OUT: 'CashOutConfirmed', LOST: 'CashOutFailed', UNKNOWN: 'CashOutFailed',
    };
    return map[state] ?? null;
  }

  async updateState(id: string, state: BetState, reason?: string): Promise<BetRecord | null> {
    return this.update(id, {
      state,
      failureReason: reason,
    });
  }

  async delete(id: string): Promise<boolean> {
    const query = `DELETE FROM bets WHERE id = $1`;

    try {
      const result = await this.pool.query(query, [id]);
      const deleted = result.rowCount !== null && result.rowCount > 0;
      if (deleted) {
        this.logger.info({ component: 'BetRepository', betId: id }, 'Bet deleted');
      }
      return deleted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to delete bet');
      throw new CriticalError(`Bet delete failed: ${message}`, 'BET_DELETE_FAILED');
    }
  }

  async count(): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM bets`;

    try {
      const result = await this.pool.query(query);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to count bets');
      throw new CriticalError(`Bet count failed: ${message}`, 'BET_COUNT_FAILED');
    }
  }

  async countByState(state: BetState): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM bets WHERE state = $1`;

    try {
      const result = await this.pool.query(query, [state]);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to count bets by state');
      throw new CriticalError(`Bet count by state failed: ${message}`, 'BET_COUNT_STATE_FAILED');
    }
  }

  async countByDailyKey(dailyKey: string): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM bets WHERE daily_key = $1`;

    try {
      const result = await this.pool.query(query, [dailyKey]);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BetRepository', error: message }, 'Failed to count bets by daily key');
      throw new CriticalError(`Bet count by daily key failed: ${message}`, 'BET_COUNT_DAILY_FAILED');
    }
  }

  private mapRow(row: Record<string, unknown>): BetRecord {
    return {
      id: String(row.id),
      sessionId: row.session_id ? String(row.session_id) : null,
      roundId: row.round_id ? String(row.round_id) : null,
      dailyKey: String(row.daily_key),
      stake: Number(row.stake),
      cashOutTarget: Number(row.cash_out_target),
      state: String(row.state) as BetState,
      requestedAt: row.requested_at ? String(row.requested_at) : null,
      placedAt: row.placed_at ? String(row.placed_at) : null,
      confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
      cashOutRequestedAt: row.cash_out_requested_at ? String(row.cash_out_requested_at) : null,
      cashOutConfirmedAt: row.cash_out_confirmed_at ? String(row.cash_out_confirmed_at) : null,
      observedCashOutMultiplier: row.observed_cash_out_multiplier !== null ? Number(row.observed_cash_out_multiplier) : null,
      confirmedCashOutMultiplier: row.confirmed_cash_out_multiplier !== null ? Number(row.confirmed_cash_out_multiplier) : null,
      pnl: row.pnl !== null ? Number(row.pnl) : null,
      balanceBefore: row.balance_before !== null ? Number(row.balance_before) : null,
      balanceAfter: row.balance_after !== null ? Number(row.balance_after) : null,
      failureReason: row.failure_reason ? String(row.failure_reason) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async getDailyStats(dailyKey: string): Promise<DailyStats | null> {
    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE state IN ('CASHED_OUT', 'RECONCILED')) AS wins,
           COUNT(*) FILTER (WHERE state = 'LOST') AS losses,
           COUNT(*) AS total,
           COALESCE(SUM(pnl) FILTER (WHERE state IN ('CASHED_OUT', 'RECONCILED', 'LOST')), 0) AS net_pnl
         FROM bets WHERE daily_key = $1`,
        [dailyKey]
      );
      const row = result.rows[0];
      if (!row || Number(row.total) === 0) return null;
      const wins = Number(row.wins);
      const losses = Number(row.losses);
      const total = Number(row.total);
      const netPnl = Number(row.net_pnl);
      return {
        dailyKey,
        entriesConfirmed: wins + losses,
        entriesAttempted: total,
        entriesFailed: 0,
        entriesReserved: 0,
        entriesRemaining: 0,
        totalBets: total,
        wins,
        losses,
        consecutiveLosses: 0,
        grossProfit: netPnl > 0 ? netPnl : 0,
        grossLoss: netPnl < 0 ? netPnl : 0,
        netPnl: Number(row.net_pnl),
        balanceStart: null,
        balanceEnd: null,
        maxDrawdown: 0,
        currentDrawdown: 0,
        hitRate: total > 0 ? wins / total : null,
        averageLatencyMs: null,
        cashOutSuccessRate: null,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CriticalError(`Daily stats query failed: ${message}`, 'DAILY_STATS_FAILED');
    }
  }
}

/**
 * InMemoryBetRepository provides an in-memory implementation for testing.
 */
export class InMemoryBetRepository {
  private bets: Map<string, BetRecord> = new Map();
  private nextId = 1;
  // Public structural compatibility with BetRepository (private props must match structurally)
  readonly logger = getLogger();
  pool: Pool = {} as Pool;

  constructor() {}

  async create(input: CreateBetInput): Promise<BetRecord> {
    const now = new Date().toISOString();
    const bet: BetRecord = {
      id: `bet-${this.nextId++}`,
      sessionId: input.sessionId ?? null,
      roundId: input.roundId ?? null,
      dailyKey: input.dailyKey,
      stake: input.stake,
      cashOutTarget: input.cashOutTarget,
      state: input.state ?? 'RESERVED',
      requestedAt: null,
      placedAt: null,
      confirmedAt: null,
      cashOutRequestedAt: null,
      cashOutConfirmedAt: null,
      observedCashOutMultiplier: null,
      confirmedCashOutMultiplier: null,
      pnl: null,
      balanceBefore: input.balanceBefore ?? null,
      balanceAfter: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.bets.set(bet.id, bet);
    return bet;
  }

  async findById(id: string): Promise<BetRecord | null> {
    return this.bets.get(id) ?? null;
  }

  async findByIdOrThrow(id: string): Promise<BetRecord> {
    const record = await this.findById(id);
    if (!record) throw new NotFoundError('Bet', id);
    return record;
  }

  async findByRoundId(roundId: string): Promise<BetRecord | null> {
    const bets = Array.from(this.bets.values()).filter((b) => b.roundId === roundId);
    return bets[0] ?? null;
  }

  async findBySessionId(sessionId: string, _limit?: number): Promise<BetRecord[]> {
    return Array.from(this.bets.values()).filter((b) => b.sessionId === sessionId);
  }

  async findByUser(userId: string, opts: { limit?: number; status?: string; cursor?: string } = {}): Promise<BetRecord[]> {
    void userId;
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    let rows = Array.from(this.bets.values());
    if (opts.status) {
      rows = rows.filter((b) => String(b.state).toUpperCase() === opts.status!.toUpperCase());
    }
    return rows.slice(0, limit);
  }

  async findByDailyKey(dailyKey: string): Promise<BetRecord[]> {
    return Array.from(this.bets.values()).filter((b) => b.dailyKey === dailyKey);
  }

  async findByState(state: BetState, limit: number = 100): Promise<BetRecord[]> {
    return Array.from(this.bets.values())
      .filter((b) => b.state === state)
      .slice(0, limit);
  }

  async findByStatePaged(
    state: BetState,
    limit: number = 1000,
    offset: number = 0
  ): Promise<BetRecord[]> {
    const all = Array.from(this.bets.values())
      .filter((b) => b.state === state)
      .sort((a, b) => {
        const ta = Date.parse(a.createdAt) || 0;
        const tb = Date.parse(b.createdAt) || 0;
        if (ta !== tb) return ta - tb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    return all.slice(offset, offset + limit);
  }

  async findActiveBets(): Promise<BetRecord[]> {
    const activeStates: BetState[] = ['PLACED', 'CONFIRMED', 'ACTIVE', 'CASH_OUT_REQUESTED'];
    return Array.from(this.bets.values()).filter((b) => activeStates.includes(b.state));
  }

  async findUnknownBets(limit: number = 100): Promise<BetRecord[]> {
    return this.findByState('UNKNOWN', limit);
  }

  async update(id: string, input: UpdateBetInput): Promise<BetRecord | null> {
    const bet = this.bets.get(id);
    if (!bet) return null;
    const updated: BetRecord = {
      ...bet,
      sessionId: input.sessionId !== undefined ? input.sessionId : bet.sessionId,
      roundId: input.roundId !== undefined ? input.roundId : bet.roundId,
      state: input.state ?? bet.state,
      requestedAt: input.requestedAt !== undefined ? input.requestedAt : bet.requestedAt,
      placedAt: input.placedAt !== undefined ? input.placedAt : bet.placedAt,
      confirmedAt: input.confirmedAt !== undefined ? input.confirmedAt : bet.confirmedAt,
      cashOutRequestedAt: input.cashOutRequestedAt !== undefined ? input.cashOutRequestedAt : bet.cashOutRequestedAt,
      cashOutConfirmedAt: input.cashOutConfirmedAt !== undefined ? input.cashOutConfirmedAt : bet.cashOutConfirmedAt,
      observedCashOutMultiplier: input.observedCashOutMultiplier !== undefined ? input.observedCashOutMultiplier : bet.observedCashOutMultiplier,
      confirmedCashOutMultiplier: input.confirmedCashOutMultiplier !== undefined ? input.confirmedCashOutMultiplier : bet.confirmedCashOutMultiplier,
      pnl: input.pnl !== undefined ? input.pnl : bet.pnl,
      balanceBefore: input.balanceBefore !== undefined ? input.balanceBefore : bet.balanceBefore,
      balanceAfter: input.balanceAfter !== undefined ? input.balanceAfter : bet.balanceAfter,
      failureReason: input.failureReason !== undefined ? input.failureReason : bet.failureReason,
      updatedAt: new Date().toISOString(),
    };
    this.bets.set(id, updated);
    return updated;
  }

  async getDailyStats(dailyKey: string): Promise<DailyStats | null> {
    const bets = Array.from(this.bets.values()).filter((b) => b.dailyKey === dailyKey);
    if (bets.length === 0) return null;
    const wins = bets.filter((b) => b.state === 'CASHED_OUT' || b.state === 'RECONCILED').length;
    const losses = bets.filter((b) => b.state === 'LOST').length;
    const total = bets.length;
    const netPnl = bets.reduce((sum, b) => sum + (b.pnl ?? 0), 0);
    const grossProfit = bets.filter((b) => (b.pnl ?? 0) > 0).reduce((sum, b) => sum + (b.pnl ?? 0), 0);
    const grossLoss = bets.filter((b) => (b.pnl ?? 0) < 0).reduce((sum, b) => sum + (b.pnl ?? 0), 0);
    return {
      dailyKey,
      entriesConfirmed: wins + losses,
      entriesAttempted: total,
      entriesFailed: bets.filter((b) => b.state === 'FAILED').length,
      entriesReserved: bets.filter((b) => b.state === 'RESERVED').length,
      entriesRemaining: 0,
      totalBets: total,
      wins,
      losses,
      consecutiveLosses: 0,
      grossProfit,
      grossLoss,
      netPnl,
      balanceStart: bets[0]?.balanceBefore ?? null,
      balanceEnd: bets[bets.length - 1]?.balanceAfter ?? null,
      maxDrawdown: 0,
      currentDrawdown: 0,
      hitRate: total > 0 ? wins / total : null,
      averageLatencyMs: null,
      cashOutSuccessRate: null,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
  }

  async updateState(id: string, state: BetState, reason?: string): Promise<BetRecord | null> {
    return this.update(id, { state, failureReason: reason });
  }

  async delete(id: string): Promise<boolean> {
    return this.bets.delete(id);
  }

  async count(): Promise<number> {
    return this.bets.size;
  }

  async countByState(state: BetState): Promise<number> {
    return Array.from(this.bets.values()).filter((b) => b.state === state).length;
  }

  async countByDailyKey(dailyKey: string): Promise<number> {
    return Array.from(this.bets.values()).filter((b) => b.dailyKey === dailyKey).length;
  }
}
