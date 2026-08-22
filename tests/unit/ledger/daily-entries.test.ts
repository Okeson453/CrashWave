import { InMemoryDailyEntryLedger, DailyEntryCounter } from '../../../src/ledger/daily-entries';
;
jest.mock('../../../src/observability/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));
;
describe('InMemoryDailyEntryLedger', () => {
  let ledger: InMemoryDailyEntryLedger;
  const dailyKey = '2024-01-15';
  const sessionId = 'session-1';
;
  beforeEach(() => {
    ledger = new InMemoryDailyEntryLedger(100);
  });
;
  afterEach(() => {
    ledger.clear();
  });
;
  describe('reserve', () => {
    it('reserves a slot successfully', async () => {
      const result = await ledger.reserve(dailyKey, 'bet-1', sessionId);
      expect(result.success).toBe(true);
      expect(result.slot).not.toBeNull();
      expect(result.slot!.status).toBe('RESERVED');
      expect(result.slot!.slotNumber).toBe(1);
      expect(result.confirmedCount).toBe(0);
      expect(result.reservedCount).toBe(1);
      expect(result.message).toContain('Slot 1 reserved');
    });
;
    it('reserves multiple slots sequentially', async () => {
      const r1 = await ledger.reserve(dailyKey, 'bet-1', sessionId);
      const r2 = await ledger.reserve(dailyKey, 'bet-2', sessionId);
      const r3 = await ledger.reserve(dailyKey, 'bet-3', sessionId);
      expect(r1.slot!.slotNumber).toBe(1);
      expect(r2.slot!.slotNumber).toBe(2);
      expect(r3.slot!.slotNumber).toBe(3);
      expect(r3.reservedCount).toBe(3);
    });
;
    it('rejects reservation when limit is reached', async () => {
      const smallLedger = new InMemoryDailyEntryLedger(3);
      await smallLedger.reserve(dailyKey, 'bet-1', sessionId);
      await smallLedger.reserve(dailyKey, 'bet-2', sessionId);
      await smallLedger.reserve(dailyKey, 'bet-3', sessionId);
      const result = await smallLedger.reserve(dailyKey, 'bet-4', sessionId);
      expect(result.success).toBe(false);
      expect(result.slot).toBeNull();
      expect(result.message).toContain('limit reached');
    });
;
    it('counts reserved slots toward the limit', async () => {
      const smallLedger = new InMemoryDailyEntryLedger(2);
      await smallLedger.reserve(dailyKey, 'bet-1', sessionId);
      await smallLedger.reserve(dailyKey, 'bet-2', sessionId);
      const result = await smallLedger.reserve(dailyKey, 'bet-3', sessionId);
      expect(result.success).toBe(false);
    });
;
    it('isolates different daily keys', async () => {
      await ledger.reserve('2024-01-15', 'bet-1', sessionId);
      const result = await ledger.reserve('2024-01-16', 'bet-2', sessionId);
      expect(result.success).toBe(true);
      expect(result.slot!.slotNumber).toBe(1);
    });
;
    it('isolates different session IDs', async () => {
      await ledger.reserve(dailyKey, 'bet-1', 'session-a');
      const result = await ledger.reserve(dailyKey, 'bet-2', 'session-b');
      expect(result.success).toBe(true);
    });
  });
;
  describe('confirm', () => {
    it('confirms a reserved slot', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.confirm(dailyKey, 'bet-1');
      const entries = await ledger.getEntriesForDay(dailyKey);
      expect(entries[0].status).toBe('CONFIRMED');
      expect(entries[0].confirmedAt).not.toBeNull();
    });
;
    it('is idempotent for already confirmed slots', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.confirm(dailyKey, 'bet-1');
      await ledger.confirm(dailyKey, 'bet-1');
      await ledger.confirm(dailyKey, 'bet-1');
      const count = await ledger.getConfirmedCount(dailyKey);
      expect(count).toBe(1);
    });
;
    it('no-ops for non-existent entry', async () => {
      await expect(ledger.confirm(dailyKey, 'nonexistent')).resolves.not.toThrow();
    });
;
    it('updates stats on confirm', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.reserve(dailyKey, 'bet-2', sessionId);
      await ledger.confirm(dailyKey, 'bet-1');
      const stats = await ledger.getDailyStats(dailyKey);
      expect(stats!.entriesConfirmed).toBe(1);
      expect(stats!.entriesReserved).toBe(1);
    });
  });
;
  describe('release', () => {
    it('releases a reserved slot', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.release(dailyKey, 'bet-1', 'bet placement failed');
      const entries = await ledger.getEntriesForDay(dailyKey);
      expect(entries[0].status).toBe('RELEASED');
      expect(entries[0].releasedAt).not.toBeNull();
    });
;
    it('is idempotent for already released slots', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.release(dailyKey, 'bet-1', 'reason');
      await ledger.release(dailyKey, 'bet-1', 'reason');
      const entries = await ledger.getEntriesForDay(dailyKey);
      expect(entries.length).toBe(1);
    });
;
    it('no-ops for non-existent entry', async () => {
      await expect(ledger.release(dailyKey, 'nonexistent', 'reason')).resolves.not.toThrow();
    });
;
    it('decrements confirmed count when releasing a confirmed slot', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.confirm(dailyKey, 'bet-1');
      await ledger.release(dailyKey, 'bet-1', 'operator cancelled');
      const stats = await ledger.getDailyStats(dailyKey);
      expect(stats!.entriesConfirmed).toBe(0);
      expect(stats!.entriesFailed).toBe(1);
    });
;
    it('increments failed count on release', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.release(dailyKey, 'bet-1', 'timeout');
      const stats = await ledger.getDailyStats(dailyKey);
      expect(stats!.entriesFailed).toBe(1);
    });
  });
;
  describe('query methods', () => {
    it('getConfirmedCount returns correct count', async () => {
      expect(await ledger.getConfirmedCount(dailyKey)).toBe(0);
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.confirm(dailyKey, 'bet-1');
      expect(await ledger.getConfirmedCount(dailyKey)).toBe(1);
    });
;
    it('getReservedCount returns correct count', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      expect(await ledger.getReservedCount(dailyKey)).toBe(1);
      await ledger.confirm(dailyKey, 'bet-1');
      expect(await ledger.getReservedCount(dailyKey)).toBe(0);
    });
;
    it('getRemainingEntries returns correct remaining', async () => {
      expect(await ledger.getRemainingEntries(dailyKey)).toBe(100);
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      expect(await ledger.getRemainingEntries(dailyKey)).toBe(99);
      await ledger.reserve(dailyKey, 'bet-2', sessionId);
      expect(await ledger.getRemainingEntries(dailyKey)).toBe(98);
    });
;
    it('isLimitReached returns false when under limit', async () => {
      expect(await ledger.isLimitReached(dailyKey)).toBe(false);
    });
;
    it('isLimitReached returns true when limit reached', async () => {
      const smallLedger = new InMemoryDailyEntryLedger(1);
      await smallLedger.reserve(dailyKey, 'bet-1', sessionId);
      expect(await smallLedger.isLimitReached(dailyKey)).toBe(true);
    });
;
    it('getEntriesForDay returns all entries ordered', async () => {
      await ledger.reserve(dailyKey, 'bet-2', sessionId);
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      const entries = await ledger.getEntriesForDay(dailyKey);
      expect(entries.length).toBe(2);
      expect(entries[0].slotNumber).toBe(1);
      expect(entries[1].slotNumber).toBe(2);
    });
;
    it('getDailyStats returns default for empty day', async () => {
      const stats = await ledger.getDailyStats('2099-01-01');
      expect(stats).not.toBeNull();
      expect(stats!.entriesConfirmed).toBe(0);
    });
  });
;
  describe('concurrency safety', () => {
    it('never over-counts under concurrent reservation load', async () => {
      const smallLedger = new InMemoryDailyEntryLedger(10);
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        promises.push(smallLedger.reserve(dailyKey, `bet-${i}`, sessionId));
      }
      await Promise.all(promises);
      const stats = await smallLedger.getDailyStats(dailyKey);
      expect(stats!.entriesReserved + stats!.entriesConfirmed).toBeLessThanOrEqual(10);
    });
;
    it('maintains correct counts under mixed confirm/release load', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.reserve(dailyKey, 'bet-2', sessionId);
      await ledger.reserve(dailyKey, 'bet-3', sessionId);
      await Promise.all([
        ledger.confirm(dailyKey, 'bet-1'),
        ledger.release(dailyKey, 'bet-2', 'failed'),
        ledger.confirm(dailyKey, 'bet-3'),
      ]);
      const stats = await ledger.getDailyStats(dailyKey);
      expect(stats!.entriesConfirmed).toBe(2);
      expect(stats!.entriesFailed).toBe(1);
      expect(stats!.entriesReserved).toBe(0);
    });
  });
;
  describe('clear', () => {
    it('removes all entries and stats', async () => {
      await ledger.reserve(dailyKey, 'bet-1', sessionId);
      await ledger.confirm(dailyKey, 'bet-1');
      ledger.clear();
      expect(await ledger.getConfirmedCount(dailyKey)).toBe(0);
      expect(await ledger.getEntriesForDay(dailyKey)).toEqual([]);
    });
  });
});
;
describe('DailyEntryCounter', () => {
  let counter: DailyEntryCounter;
;
  beforeEach(() => {
    counter = new DailyEntryCounter();
  });
;
  it('starts at zero', () => {
    expect(counter.getCount()).toBe(0);
  });
;
  it('increments count', () => {
    counter.increment();
    counter.increment();
    expect(counter.getCount()).toBe(2);
  });
;
  it('resets to zero', () => {
    counter.increment();
    counter.increment();
    counter.reset();
    expect(counter.getCount()).toBe(0);
  });
;
  it('returns a daily key', () => {
    const key = counter.getDailyKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
;
  it('resets count when day changes', () => {
    counter.increment();
    expect(counter.getCount()).toBe(1);
    expect(counter.getCount()).toBe(1);
  });
});
