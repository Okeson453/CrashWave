/**
 * Daily Limit Simulation Scenario
 * Tests enforcement of the daily entry limit and edge cases around limit boundaries.
 */
import { InMemoryDailyEntryLedger } from '../../../src/ledger/daily-entries';

describe('Simulation: Daily Limit', () => {
  let ledger: InMemoryDailyEntryLedger;
  const dailyKey = '2026-08-18';

  beforeEach(() => {
    ledger = new InMemoryDailyEntryLedger(100);
  });

  afterEach(() => {
    ledger.clear();
  });

  describe('basic limit enforcement', () => {
    it('should allow entries under the daily limit', async () => {
      const result = await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      expect(result.success).toBe(true);
      expect(result.slot).not.toBeNull();
      expect(result.slot!.slotNumber).toBe(1);
    });

    it('should enforce the daily limit', async () => {
      ledger = new InMemoryDailyEntryLedger(3);
      await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      await ledger.reserve(dailyKey, 'bet-2', 'session-1');
      await ledger.reserve(dailyKey, 'bet-3', 'session-1');
      const result = await ledger.reserve(dailyKey, 'bet-4', 'session-1');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/limit reached/i);
      expect(result.slot).toBeNull();
    });

    it('should report remaining entries correctly', async () => {
      await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      await ledger.reserve(dailyKey, 'bet-2', 'session-1');
      const remaining = await ledger.getRemainingEntries(dailyKey);
      expect(remaining).toBe(98);
    });
  });

  describe('confirm and release', () => {
    it('should track confirmed entries', async () => {
      const result = await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      expect(result.success).toBe(true);
      await ledger.confirm(dailyKey, 'bet-1');
      const count = await ledger.getConfirmedCount(dailyKey);
      expect(count).toBe(1);
    });

    it('should release reserved slots', async () => {
      await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      await ledger.release(dailyKey, 'bet-1', 'bet failed');
      const remaining = await ledger.getRemainingEntries(dailyKey);
      expect(remaining).toBe(100);
    });

    it('should not allow re-reservation of released slots to exceed limit', async () => {
      ledger = new InMemoryDailyEntryLedger(2);
      await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      await ledger.reserve(dailyKey, 'bet-2', 'session-1');
      await ledger.release(dailyKey, 'bet-1', 'failed');
      // Released slot frees up capacity
      const result = await ledger.reserve(dailyKey, 'bet-3', 'session-1');
      expect(result.success).toBe(true);
      // But limit still enforced
      const blocked = await ledger.reserve(dailyKey, 'bet-4', 'session-1');
      expect(blocked.success).toBe(false);
    });
  });

  describe('boundary conditions', () => {
    it('should handle limit of 1', async () => {
      ledger = new InMemoryDailyEntryLedger(1);
      const r1 = await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      expect(r1.success).toBe(true);
      const r2 = await ledger.reserve(dailyKey, 'bet-2', 'session-1');
      expect(r2.success).toBe(false);
    });

    it('should handle limit of 0', async () => {
      ledger = new InMemoryDailyEntryLedger(0);
      const result = await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      expect(result.success).toBe(false);
    });

    it('should isolate limits across different days', async () => {
      await ledger.reserve('2026-08-18', 'bet-1', 'session-1');
      await ledger.reserve('2026-08-18', 'bet-2', 'session-1');
      const nextDay = await ledger.reserve('2026-08-19', 'bet-3', 'session-1');
      expect(nextDay.success).toBe(true);
      expect(nextDay.slot!.slotNumber).toBe(1);
    });

    it('should isolate limits across different sessions', async () => {
      await ledger.reserve(dailyKey, 'bet-1', 'session-a');
      const sessionB = await ledger.reserve(dailyKey, 'bet-2', 'session-b');
      expect(sessionB.success).toBe(true);
    });
  });

  describe('stats and queries', () => {
    it('should return accurate daily stats', async () => {
      await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      await ledger.reserve(dailyKey, 'bet-2', 'session-1');
      await ledger.confirm(dailyKey, 'bet-1');
      await ledger.release(dailyKey, 'bet-2', 'timeout');
      const stats = await ledger.getDailyStats(dailyKey);
      expect(stats!.entriesConfirmed).toBe(1);
      expect(stats!.entriesFailed).toBe(1);
      expect(stats!.entriesReserved).toBe(0);
    });

    it('should return all entries ordered by slot number', async () => {
      await ledger.reserve(dailyKey, 'bet-3', 'session-1');
      await ledger.reserve(dailyKey, 'bet-1', 'session-1');
      await ledger.reserve(dailyKey, 'bet-2', 'session-1');
      const entries = await ledger.getEntriesForDay(dailyKey);
      expect(entries.map((e: any) => e.slotNumber)).toEqual([1, 2, 3]);
    });
  });
});
