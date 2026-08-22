import { Pool, PoolClient } from 'pg';
import { getLogger } from '../observability/logger';
import { getPool } from '../persistence/client';
import { OperationalError, ConflictError } from '../utils/errors';
import { EntryReservationResult, DailyEntryRecord, EntrySlotStatus, DailyStats } from './types';
import { getDailyKey } from '../utils/day-boundary';

/**
 * DailyEntryLedger manages the atomic daily entry counter.
 *
 * Core invariant: confirmed entries for a day never exceed 100.
 * This is enforced at the database level using SERIALIZABLE isolation
 * and an explicit check within the transaction.
 *
 * Operations:
 * - reserve(): Atomically reserve a slot (RESERVED)
 * - confirm(): Mark a reserved slot as CONFIRMED
 * - release(): Mark a reserved slot as RELEASED (if bet failed)
 * - getCount(): Get current confirmed count for a day
 *
 * The ledger uses a pessimistic locking strategy:
 * 1. BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE
 * 2. SELECT FOR UPDATE on the daily_stats row
 * 3. Check count < 100
 * 4. INSERT daily entry record
 * 5. UPDATE daily_stats
 * 6. COMMIT
 */
export class DailyEntryLedger {
  private readonly logger = getLogger();
  private _pool: Pool | null = null;
  protected readonly maxEntries: number;

  constructor(pool?: Pool, maxEntries: number = 100) {
    this._pool = pool ?? null;
    this.maxEntries = maxEntries;
  }

  private get pool(): Pool {
    if (!this._pool) {
      this._pool = getPool();
    }
    return this._pool;
  }

  /**
   * Atomically reserve a daily entry slot.
   *
   * This is the critical path for enforcing the daily limit.
   * It uses SERIALIZABLE isolation to prevent phantom reads
   * and SELECT FOR UPDATE to prevent concurrent reservations
   * from over-counting.
   *
   * Returns the reserved slot on success, or a rejection reason on failure.
   */
  async reserve(
    dailyKey: string,
    betId: string,
    sessionId: string
  ): Promise<EntryReservationResult> {
    return this.withSerializableTransaction(async (client) => {
      // 1. Lock the daily stats row (creates it if not exists)
      const stats = await this.lockDailyStats(client, dailyKey);

      // 2. Count confirmed + reserved slots (reserved count toward limit to prevent over-subscription)
      const activeCount = stats.entries_confirmed + stats.entries_reserved;

      if (activeCount >= this.maxEntries) {
        return {
          success: false,
          slot: null,
          dailyKey,
          confirmedCount: stats.entries_confirmed,
          reservedCount: stats.entries_reserved,
          message: `Daily entry limit reached: ${activeCount}/${this.maxEntries} entries used for ${dailyKey}`,
        };
      }

      // 3. Insert the daily entry record
      const slotNumber = activeCount + 1;
      const entryResult = await client.query(
        `
        INSERT INTO daily_entries (daily_key, bet_id, slot_number, status, session_id, reserved_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING id, daily_key, bet_id, slot_number, status, session_id, reserved_at, confirmed_at, released_at, reason
        `,
        [dailyKey, betId, slotNumber, 'RESERVED', sessionId]
      );

      const slot = this.mapEntryRow(entryResult.rows[0]);

      // 4. Update daily stats (increment reserved count)
      await client.query(
        `
        UPDATE daily_stats
        SET entries_reserved = entries_reserved + 1,
            entries_attempted = entries_attempted + 1,
            updated_at = NOW()
        WHERE daily_key = $1
        `,
        [dailyKey]
      );

      this.logger.info(
        {
          component: 'DailyEntryLedger',
          dailyKey,
          betId,
          sessionId,
          slotNumber,
          confirmedCount: stats.entries_confirmed,
          reservedCount: stats.entries_reserved + 1,
        },
        `Daily entry slot reserved: ${slotNumber}/${this.maxEntries}`
      );

      return {
        success: true,
        slot,
        dailyKey,
        confirmedCount: stats.entries_confirmed,
        reservedCount: stats.entries_reserved + 1,
        message: `Slot ${slotNumber} reserved for ${dailyKey}`,
      };
    });
  }

  /**
   * Confirm a previously reserved slot.
   * This moves the slot from RESERVED to CONFIRMED and updates counts.
   */
  async confirm(dailyKey: string, betId: string): Promise<void> {
    return this.withSerializableTransaction(async (client) => {
      // 1. Find and lock the entry
      const entryResult = await client.query(
        `SELECT id, status FROM daily_entries WHERE daily_key = $1 AND bet_id = $2 FOR UPDATE`,
        [dailyKey, betId]
      );

      if (entryResult.rows.length === 0) {
        throw new OperationalError(`Daily entry not found: ${dailyKey}/${betId}`, 'LEDGER_ENTRY_NOT_FOUND');
      }

      const entry = entryResult.rows[0];
      if (entry.status === 'CONFIRMED') {
        // Already confirmed — idempotent
        return;
      }
      if (entry.status !== 'RESERVED') {
        throw new ConflictError(
          `Cannot confirm entry in status ${entry.status} — must be RESERVED`,
          { dailyKey, betId, status: entry.status }
        );
      }

      // 2. Update entry status
      await client.query(
        `UPDATE daily_entries SET status = 'CONFIRMED', confirmed_at = NOW() WHERE id = $1`,
        [entry.id]
      );

      // 3. Update daily stats: move from reserved to confirmed
      await client.query(
        `
        UPDATE daily_stats
        SET entries_confirmed = entries_confirmed + 1,
            entries_reserved = GREATEST(entries_reserved - 1, 0),
            updated_at = NOW()
        WHERE daily_key = $1
        `,
        [dailyKey]
      );

      this.logger.info(
        { component: 'DailyEntryLedger', dailyKey, betId },
        'Daily entry slot confirmed'
      );
    });
  }

  /**
   * Release a previously reserved slot (e.g., bet placement failed).
   * This frees the slot so it can be used by another bet.
   */
  async release(dailyKey: string, betId: string, reason: string): Promise<void> {
    return this.withSerializableTransaction(async (client) => {
      // 1. Find and lock the entry
      const entryResult = await client.query(
        `SELECT id, status FROM daily_entries WHERE daily_key = $1 AND bet_id = $2 FOR UPDATE`,
        [dailyKey, betId]
      );

      if (entryResult.rows.length === 0) {
        this.logger.warn(
          { component: 'DailyEntryLedger', dailyKey, betId },
          'Release called for non-existent entry'
        );
        return;
      }

      const entry = entryResult.rows[0];
      if (entry.status === 'RELEASED' || entry.status === 'FAILED') {
        // Already released — idempotent
        return;
      }

      // 2. Update entry status
      await client.query(
        `UPDATE daily_entries SET status = 'RELEASED', released_at = NOW(), reason = $3 WHERE id = $1`,
        [entry.id, reason]
      );

      // 3. Update daily stats
      const wasConfirmed = entry.status === 'CONFIRMED';
      await client.query(
        `
        UPDATE daily_stats
        SET entries_reserved = GREATEST(entries_reserved - 1, 0),
            entries_failed = entries_failed + 1,
            ${wasConfirmed ? 'entries_confirmed = GREATEST(entries_confirmed - 1, 0),' : ''}
            updated_at = NOW()
        WHERE daily_key = $1
        `,
        [dailyKey]
      );

      this.logger.info(
        { component: 'DailyEntryLedger', dailyKey, betId, reason },
        'Daily entry slot released'
      );
    });
  }

  /**
   * Get the current confirmed entry count for a day.
   */
  async getConfirmedCount(dailyKey: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT entries_confirmed FROM daily_stats WHERE daily_key = $1`,
      [dailyKey]
    );
    if (result.rows.length === 0) {
      return 0;
    }
    return Number(result.rows[0].entries_confirmed);
  }

  /**
   * Get the current reserved entry count for a day.
   */
  async getReservedCount(dailyKey: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT entries_reserved FROM daily_stats WHERE daily_key = $1`,
      [dailyKey]
    );
    if (result.rows.length === 0) {
      return 0;
    }
    return Number(result.rows[0].entries_reserved);
  }

  /**
   * Get full daily stats for a day.
   */
  async getDailyStats(dailyKey: string): Promise<DailyStats | null> {
    const result = await this.pool.query(`SELECT * FROM daily_stats WHERE daily_key = $1`, [
      dailyKey,
    ]);
    if (result.rows.length === 0) return null;
    return this.mapStatsRow(result.rows[0]);
  }

  /**
   * Get the number of entries remaining for a day.
   */
  async getRemainingEntries(dailyKey: string): Promise<number> {
    const stats = await this.getDailyStats(dailyKey);
    if (!stats) return this.maxEntries;
    const used = stats.entriesConfirmed + stats.entriesReserved;
    return Math.max(0, this.maxEntries - used);
  }

  /**
   * Check if the daily limit has been reached.
   */
  async isLimitReached(dailyKey: string): Promise<boolean> {
    const remaining = await this.getRemainingEntries(dailyKey);
    return remaining <= 0;
  }

  /**
   * Get all entries for a day.
   */
  async getEntriesForDay(dailyKey: string): Promise<DailyEntryRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM daily_entries WHERE daily_key = $1 ORDER BY slot_number ASC`,
      [dailyKey]
    );
    return result.rows.map((row) => this.mapEntryRow(row));
  }

  /**
   * Initialize daily stats for a day if not exists.
   */
  async ensureDailyStats(dailyKey: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO daily_stats (daily_key)
      VALUES ($1)
      ON CONFLICT (daily_key) DO NOTHING
      `,
      [dailyKey]
    );
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private async withSerializableTransaction<T>(
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockDailyStats(
    client: PoolClient,
    dailyKey: string
  ): Promise<{ entries_confirmed: number; entries_reserved: number }> {
    // Ensure row exists
    await client.query(
      `
      INSERT INTO daily_stats (daily_key)
      VALUES ($1)
      ON CONFLICT (daily_key) DO NOTHING
      `,
      [dailyKey]
    );

    // Lock and read
    const result = await client.query(
      `SELECT entries_confirmed, entries_reserved FROM daily_stats WHERE daily_key = $1 FOR UPDATE`,
      [dailyKey]
    );

    if (result.rows.length === 0) {
      // Should not happen after INSERT above, but defensive
      return { entries_confirmed: 0, entries_reserved: 0 };
    }

    return {
      entries_confirmed: Number(result.rows[0].entries_confirmed),
      entries_reserved: Number(result.rows[0].entries_reserved),
    };
  }

  private mapEntryRow(row: Record<string, unknown>): DailyEntryRecord {
    return {
      id: String(row.id),
      dailyKey: String(row.daily_key),
      betId: String(row.bet_id),
      slotNumber: Number(row.slot_number),
      status: String(row.status) as EntrySlotStatus,
      sessionId: String(row.session_id),
      reservedAt: String(row.reserved_at),
      confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
      releasedAt: row.released_at ? String(row.released_at) : null,
      reason: row.reason ? String(row.reason) : null,
    };
  }

  private mapStatsRow(row: Record<string, unknown>): DailyStats {
    return {
      dailyKey: String(row.daily_key),
      entriesConfirmed: Number(row.entries_confirmed),
      entriesAttempted: Number(row.entries_attempted),
      entriesFailed: Number(row.entries_failed),
      entriesReserved: Number(row.entries_reserved),
      wins: Number(row.wins),
      losses: Number(row.losses),
      grossProfit: Number(row.gross_profit),
      grossLoss: Number(row.gross_loss),
      netPnl: Number(row.net_pnl),
      balanceStart: row.balance_start !== null ? Number(row.balance_start) : null,
      balanceEnd: row.balance_end !== null ? Number(row.balance_end) : null,
      maxDrawdown: Number(row.max_drawdown),
      currentDrawdown: Number(row.current_drawdown),
      hitRate: row.hit_rate !== null ? Number(row.hit_rate) : null,
      averageLatencyMs: row.average_latency_ms !== null ? Number(row.average_latency_ms) : null,
      cashOutSuccessRate: row.cash_out_success_rate !== null ? Number(row.cash_out_success_rate) : null,
      updatedAt: String(row.updated_at),
      createdAt: String(row.created_at),
    };
  }
}

/**
 * Simple daily entry counter for use by ExecutionSafeguards and tests.
 * Completely standalone — does not require a database pool.
 */
export class DailyEntryCounter {
  private count = 0;
  private dailyKey: string;
  private readonly timezone: string;

  constructor(timezone: string = 'UTC') {
    this.timezone = timezone;
    this.dailyKey = this.computeDailyKey();
  }

  getCount(): number {
    // Reset if day rolled over (same key as durable ledger)
    const currentKey = this.computeDailyKey();
    if (currentKey !== this.dailyKey) {
      this.dailyKey = currentKey;
      this.count = 0;
    }
    return this.count;
  }

  getDailyKey(): string {
    // Keep key current
    this.getCount();
    return this.dailyKey;
  }

  increment(): void {
    this.getCount(); // rollover check
    this.count++;
  }

  reset(): void {
    this.count = 0;
    this.dailyKey = this.computeDailyKey();
  }

  private computeDailyKey(): string {
    return getDailyKey(new Date(), this.timezone);
  }
}

/**
 * In-memory daily entry ledger for testing.
 * Not atomic across processes, but thread-safe within a single process.
 */
export class InMemoryDailyEntryLedger extends DailyEntryLedger {
  private entries = new Map<string, DailyEntryRecord[]>();
  private stats = new Map<string, DailyStats>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(maxEntries: number = 100) {
    super(undefined, maxEntries);
  }

  override async reserve(
    dailyKey: string,
    betId: string,
    sessionId: string
  ): Promise<EntryReservationResult> {
    return this.withLock(async () => {
      const stats = this.getOrCreateStats(dailyKey);
      stats.entriesAttempted++;
      const activeCount = stats.entriesConfirmed + stats.entriesReserved;

      if (activeCount >= this.maxEntries) {
        this.stats.set(dailyKey, stats);
        return {
          success: false,
          slot: null,
          dailyKey,
          confirmedCount: stats.entriesConfirmed,
          reservedCount: stats.entriesReserved,
          message: `Daily entry limit reached: ${activeCount}/${this.maxEntries} entries used for ${dailyKey}`,
        };
      }

      const slotNumber = activeCount + 1;
      const slot: DailyEntryRecord = {
        id: `${dailyKey}-${slotNumber}`,
        dailyKey,
        betId,
        slotNumber,
        status: 'RESERVED',
        sessionId,
        reservedAt: new Date().toISOString(),
        confirmedAt: null,
        releasedAt: null,
        reason: null,
      };

      const dayEntries = this.entries.get(dailyKey) ?? [];
      dayEntries.push(slot);
      this.entries.set(dailyKey, dayEntries);

      stats.entriesReserved++;
      this.stats.set(dailyKey, stats);

      return {
        success: true,
        slot,
        dailyKey,
        confirmedCount: stats.entriesConfirmed,
        reservedCount: stats.entriesReserved,
        message: `Slot ${slotNumber} reserved for ${dailyKey}`,
      };
    });
  }

  override async confirm(dailyKey: string, betId: string): Promise<void> {
    return this.withLock(async () => {
      const dayEntries = this.entries.get(dailyKey) ?? [];
      const entry = dayEntries.find((e) => e.betId === betId);
      if (!entry) return;
      if (entry.status === 'CONFIRMED') return;

      entry.status = 'CONFIRMED';
      entry.confirmedAt = new Date().toISOString();

      const stats = this.getOrCreateStats(dailyKey);
      stats.entriesConfirmed++;
      stats.entriesReserved = Math.max(0, stats.entriesReserved - 1);
      this.stats.set(dailyKey, stats);
    });
  }

  override async release(dailyKey: string, betId: string, _reason: string): Promise<void> {
    return this.withLock(async () => {
      const dayEntries = this.entries.get(dailyKey) ?? [];
      const entry = dayEntries.find((e) => e.betId === betId);
      if (!entry) return;
      if (entry.status === 'RELEASED' || entry.status === 'FAILED') return;

      const wasConfirmed = entry.status === 'CONFIRMED';
      entry.status = 'RELEASED';
      entry.releasedAt = new Date().toISOString();

      const stats = this.getOrCreateStats(dailyKey);
      stats.entriesReserved = Math.max(0, stats.entriesReserved - 1);
      stats.entriesFailed++;
      if (wasConfirmed) {
        stats.entriesConfirmed = Math.max(0, stats.entriesConfirmed - 1);
      }
      this.stats.set(dailyKey, stats);
    });
  }

  override async getConfirmedCount(dailyKey: string): Promise<number> {
    return this.getOrCreateStats(dailyKey).entriesConfirmed;
  }

  override async getReservedCount(dailyKey: string): Promise<number> {
    return this.getOrCreateStats(dailyKey).entriesReserved;
  }

  override async getDailyStats(dailyKey: string): Promise<DailyStats | null> {
    return this.getOrCreateStats(dailyKey);
  }

  override async getRemainingEntries(dailyKey: string): Promise<number> {
    const stats = this.getOrCreateStats(dailyKey);
    const used = stats.entriesConfirmed + stats.entriesReserved;
    return Math.max(0, this.maxEntries - used);
  }

  override async isLimitReached(dailyKey: string): Promise<boolean> {
    return (await this.getRemainingEntries(dailyKey)) <= 0;
  }

  override async getEntriesForDay(dailyKey: string): Promise<DailyEntryRecord[]> {
    return this.entries.get(dailyKey) ?? [];
  }

  override async ensureDailyStats(_dailyKey: string): Promise<void> {
    // No-op for in-memory
  }

  clear(): void {
    this.entries.clear();
    this.stats.clear();
  }

  private getOrCreateStats(dailyKey: string): DailyStats {
    let stats = this.stats.get(dailyKey);
    if (!stats) {
      stats = {
        dailyKey,
        entriesConfirmed: 0,
        entriesAttempted: 0,
        entriesFailed: 0,
        entriesReserved: 0,
        wins: 0,
        losses: 0,
        grossProfit: 0,
        grossLoss: 0,
        netPnl: 0,
        balanceStart: null,
        balanceEnd: null,
        maxDrawdown: 0,
        currentDrawdown: 0,
        hitRate: null,
        averageLatencyMs: null,
        cashOutSuccessRate: null,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      this.stats.set(dailyKey, stats);
    }
    return stats;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const acquire = this.lock;
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lock = acquire.then(() => nextLock, () => nextLock);
    await acquire;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}
