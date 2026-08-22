/**
 * In-memory DailyEntryLedger for unit/concurrency tests.
 * Mirrors the serializable reservation semantics of the Postgres-backed ledger
 * using an async mutex per dailyKey so concurrent reserves cannot over-subscribe.
 */

import { getDailyKey } from '../utils/day-boundary';
import {
  EntryReservationResult,
  DailyEntryRecord,
  EntrySlotStatus,
} from './types';

interface DayBucket {
  confirmed: number;
  reserved: number;
  slots: DailyEntryRecord[];
  /** Simple promise chain lock */
  lock: Promise<void>;
}

export class InMemoryDailyEntryLedger {
  private readonly maxEntries: number;
  private readonly timezone: string;
  private readonly days = new Map<string, DayBucket>();
  private idCounter = 0;

  constructor(maxEntries = 100, timezone = 'UTC') {
    this.maxEntries = maxEntries;
    this.timezone = timezone;
  }

  getDailyKey(date: Date = new Date()): string {
    return getDailyKey(date, this.timezone);
  }

  private getBucket(dailyKey: string): DayBucket {
    let b = this.days.get(dailyKey);
    if (!b) {
      b = { confirmed: 0, reserved: 0, slots: [], lock: Promise.resolve() };
      this.days.set(dailyKey, b);
    }
    return b;
  }

  private async withLock<T>(dailyKey: string, fn: () => Promise<T> | T): Promise<T> {
    const bucket = this.getBucket(dailyKey);
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = bucket.lock;
    bucket.lock = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async reserve(
    dailyKey: string,
    betId: string,
    sessionId: string
  ): Promise<EntryReservationResult> {
    return this.withLock(dailyKey, () => {
      const bucket = this.getBucket(dailyKey);
      const active = bucket.confirmed + bucket.reserved;
      if (active >= this.maxEntries) {
        return {
          success: false,
          slot: null,
          dailyKey,
          confirmedCount: bucket.confirmed,
          reservedCount: bucket.reserved,
          message: `Daily entry limit reached: ${active}/${this.maxEntries}`,
        };
      }
      this.idCounter += 1;
      const slotNumber = active + 1;
      const slot: DailyEntryRecord = {
        id: `mem-${this.idCounter}`,
        dailyKey,
        betId,
        slotNumber,
        status: 'RESERVED' as EntrySlotStatus,
        sessionId,
        reservedAt: new Date().toISOString(),
        confirmedAt: null,
        releasedAt: null,
        reason: null,
      };
      bucket.slots.push(slot);
      bucket.reserved += 1;
      return {
        success: true,
        slot,
        dailyKey,
        confirmedCount: bucket.confirmed,
        reservedCount: bucket.reserved,
        message: `Reserved slot ${slotNumber}`,
      };
    });
  }

  async confirm(dailyKey: string, betId: string): Promise<boolean> {
    return this.withLock(dailyKey, () => {
      const bucket = this.getBucket(dailyKey);
      const slot = bucket.slots.find((s) => s.betId === betId && s.status === 'RESERVED');
      if (!slot) return false;
      slot.status = 'CONFIRMED' as EntrySlotStatus;
      slot.confirmedAt = new Date().toISOString();
      bucket.reserved = Math.max(0, bucket.reserved - 1);
      bucket.confirmed += 1;
      return true;
    });
  }

  async release(dailyKey: string, betId: string): Promise<boolean> {
    return this.withLock(dailyKey, () => {
      const bucket = this.getBucket(dailyKey);
      const slot = bucket.slots.find((s) => s.betId === betId && s.status === 'RESERVED');
      if (!slot) return false;
      slot.status = 'RELEASED' as EntrySlotStatus;
      slot.releasedAt = new Date().toISOString();
      bucket.reserved = Math.max(0, bucket.reserved - 1);
      return true;
    });
  }

  getCounts(dailyKey: string): { confirmed: number; reserved: number; active: number } {
    const b = this.getBucket(dailyKey);
    return {
      confirmed: b.confirmed,
      reserved: b.reserved,
      active: b.confirmed + b.reserved,
    };
  }

  /** Test helper: force a specific daily key context */
  clear(): void {
    this.days.clear();
  }
}
