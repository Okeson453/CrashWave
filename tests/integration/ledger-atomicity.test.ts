import { InMemoryDailyEntryLedger } from '../../src/ledger/daily-entries';

describe('Integration: Ledger Atomicity', () => {
  it('never over-counts under concurrent reservation load', async () => {
    const ledger = new InMemoryDailyEntryLedger(100);
    const dailyKey = '2026-08-18';

    // Launch 200 concurrent reservations
    const promises = Array.from({ length: 200 }, (_, i) =>
      ledger.reserve(dailyKey, `bet-${i}`, 'session-1')
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.success).length;

    // Only 100 should succeed
    expect(successes).toBe(100);

    const stats = await ledger.getDailyStats(dailyKey);
    expect(stats?.entriesReserved).toBe(100);
    expect(stats?.entriesAttempted).toBe(200);
  });

  it('maintains correct counts with mixed confirm/release operations', async () => {
    const ledger = new InMemoryDailyEntryLedger(100);
    const dailyKey = '2026-08-18';

    // Reserve 50 slots
    for (let i = 0; i < 50; i++) {
      await ledger.reserve(dailyKey, `bet-${i}`, 'session-1');
    }

    // Confirm 30
    const confirmPromises = Array.from({ length: 30 }, (_, i) =>
      ledger.confirm(dailyKey, `bet-${i}`)
    );
    await Promise.all(confirmPromises);

    // Release 10
    const releasePromises = Array.from({ length: 10 }, (_, i) =>
      ledger.release(dailyKey, `bet-${30 + i}`, 'cancelled')
    );
    await Promise.all(releasePromises);

    const stats = await ledger.getDailyStats(dailyKey);
    expect(stats?.entriesConfirmed).toBe(30);
    expect(stats?.entriesReserved).toBe(10); // 50 - 30 confirmed - 10 released
    expect(stats?.entriesFailed).toBe(10);
    expect(stats?.entriesAttempted).toBe(50);

    const remaining = await ledger.getRemainingEntries(dailyKey);
    expect(remaining).toBe(60); // 100 - 30 confirmed - 10 reserved
  });

  it('prevents over-counting when confirming already-confirmed entries', async () => {
    const ledger = new InMemoryDailyEntryLedger(100);
    const dailyKey = '2026-08-18';

    await ledger.reserve(dailyKey, 'bet-1', 'session-1');
    await ledger.confirm(dailyKey, 'bet-1');
    await ledger.confirm(dailyKey, 'bet-1');
    await ledger.confirm(dailyKey, 'bet-1');

    const count = await ledger.getConfirmedCount(dailyKey);
    expect(count).toBe(1);
  });

  it('prevents over-counting when releasing already-released entries', async () => {
    const ledger = new InMemoryDailyEntryLedger(100);
    const dailyKey = '2026-08-18';

    await ledger.reserve(dailyKey, 'bet-1', 'session-1');
    await ledger.release(dailyKey, 'bet-1', 'failed');
    await ledger.release(dailyKey, 'bet-1', 'failed again');

    const stats = await ledger.getDailyStats(dailyKey);
    expect(stats?.entriesFailed).toBe(1);
    expect(stats?.entriesReserved).toBe(0);
  });
});
