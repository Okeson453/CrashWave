import { InMemoryDailyEntryLedger } from '../../../src/ledger/in-memory-daily-ledger';
import { getDailyKey, crossesDayBoundary } from '../../../src/utils/day-boundary';

describe('Day-boundary concurrent reservations', () => {
  it('never exceeds max entries under concurrent reserve', async () => {
    const max = 20;
    const ledger = new InMemoryDailyEntryLedger(max, 'UTC');
    const key = ledger.getDailyKey(new Date('2026-08-20T15:00:00.000Z'));

    const attempts = 50;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        ledger.reserve(key, `bet-${i}`, `session-${i % 3}`)
      )
    );

    const successes = results.filter((r) => r.success);
    expect(successes.length).toBe(max);
    const counts = ledger.getCounts(key);
    expect(counts.active).toBe(max);
    expect(counts.active).toBeLessThanOrEqual(max);
  });

  it('isolates slots across day keys at boundary', async () => {
    const ledger = new InMemoryDailyEntryLedger(5, 'UTC');
    const before = new Date('2026-08-20T23:59:00.000Z');
    const after = new Date('2026-08-21T00:01:00.000Z');
    expect(crossesDayBoundary(before, after, 'UTC')).toBe(true);

    const keyBefore = getDailyKey(before, 'UTC');
    const keyAfter = getDailyKey(after, 'UTC');
    expect(keyBefore).not.toBe(keyAfter);

    await Promise.all([
      ledger.reserve(keyBefore, 'b1', 's'),
      ledger.reserve(keyBefore, 'b2', 's'),
      ledger.reserve(keyAfter, 'a1', 's'),
      ledger.reserve(keyAfter, 'a2', 's'),
      ledger.reserve(keyAfter, 'a3', 's'),
    ]);

    expect(ledger.getCounts(keyBefore).active).toBe(2);
    expect(ledger.getCounts(keyAfter).active).toBe(3);
  });

  it('confirm and release maintain invariants under concurrency', async () => {
    const ledger = new InMemoryDailyEntryLedger(10, 'UTC');
    const key = '2026-08-20';
    const reserved = await Promise.all(
      Array.from({ length: 10 }, (_, i) => ledger.reserve(key, `bet-${i}`, 's'))
    );
    expect(reserved.every((r) => r.success)).toBe(true);

    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => ledger.confirm(key, `bet-${i}`)),
      ...Array.from({ length: 5 }, (_, i) => ledger.release(key, `bet-${i + 5}`)),
    ]);

    const counts = ledger.getCounts(key);
    expect(counts.confirmed).toBe(5);
    expect(counts.reserved).toBe(0);
    expect(counts.active).toBe(5);
  });
});
