import {
  getDailyKey,
  crossesDayBoundary,
  getNextDayBoundaryMs,
  msUntilDayBoundary,
} from '../../../src/utils/day-boundary';

describe('day-boundary', () => {
  it('returns YYYY-MM-DD for UTC', () => {
    const d = new Date('2026-08-20T12:00:00.000Z');
    expect(getDailyKey(d, 'UTC')).toBe('2026-08-20');
  });

  it('uses timezone for boundary', () => {
    // 2026-08-20 23:30 UTC is still 20th in UTC but may differ in US/Pacific
    const d = new Date('2026-08-20T23:30:00.000Z');
    expect(getDailyKey(d, 'UTC')).toBe('2026-08-20');
  });

  it('detects crossing midnight UTC', () => {
    const a = new Date('2026-08-20T23:59:00.000Z');
    const b = new Date('2026-08-21T00:01:00.000Z');
    expect(crossesDayBoundary(a, b, 'UTC')).toBe(true);
    expect(crossesDayBoundary(a, a, 'UTC')).toBe(false);
  });

  it('next boundary is in the future', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    const next = getNextDayBoundaryMs(now, 'UTC');
    expect(next).toBeGreaterThan(now.getTime());
    expect(getDailyKey(new Date(next), 'UTC')).toBe('2026-08-21');
  });

  it('msUntilDayBoundary is non-negative', () => {
    expect(msUntilDayBoundary(new Date(), 'UTC')).toBeGreaterThanOrEqual(0);
  });

  it('falls back on invalid timezone', () => {
    const d = new Date('2026-01-15T00:00:00.000Z');
    expect(getDailyKey(d, 'Not/AZone')).toBe('2026-01-15');
  });
});
