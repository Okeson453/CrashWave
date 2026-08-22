import {
  now,
  nowISO,
  sleep,
  getUTCStartOfDay,
  getUTCEndOfDay,
  getDayKey,
  isSameDay,
  addDays,
  formatDuration,
  parseISO,
  elapsedSince,
} from '../../../src/utils/time';

describe('time utilities', () => {
  it('now() should return current timestamp', () => {
    const before = Date.now();
    const n = now();
    const after = Date.now();
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(after);
  });

  it('nowISO() should return ISO string', () => {
    const iso = nowISO();
    expect(typeof iso).toBe('string');
    expect(new Date(iso).toISOString()).toBe(iso);
  });

  it('sleep() should delay execution', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it('getUTCStartOfDay() should return midnight UTC', () => {
    const d = new Date('2026-06-17T15:30:00Z');
    const start = getUTCStartOfDay(d);
    expect(start.toISOString()).toBe('2026-06-17T00:00:00.000Z');
  });

  it('getUTCEndOfDay() should return end of day UTC', () => {
    const d = new Date('2026-06-17T15:30:00Z');
    const end = getUTCEndOfDay(d);
    expect(end.toISOString()).toBe('2026-06-17T23:59:59.999Z');
  });

  it('getDayKey() should return YYYY-MM-DD', () => {
    const d = new Date('2026-06-17T15:30:00Z');
    expect(getDayKey(d)).toBe('2026-06-17');
  });

  it('isSameDay() should compare days correctly', () => {
    const a = new Date('2026-06-17T10:00:00Z');
    const b = new Date('2026-06-17T20:00:00Z');
    const c = new Date('2026-06-18T10:00:00Z');
    expect(isSameDay(a, b)).toBe(true);
    expect(isSameDay(a, c)).toBe(false);
  });

  it('addDays() should add days', () => {
    const d = new Date('2026-06-17T10:00:00Z');
    const result = addDays(d, 3);
    expect(result.toISOString()).toBe('2026-06-20T10:00:00.000Z');
  });

  it('formatDuration() should format correctly', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toMatch(/1\.5s/);
    expect(formatDuration(65000)).toMatch(/1m 5s/);
    expect(formatDuration(3661000)).toMatch(/1h 1m/);
  });

  it('parseISO() should parse valid ISO', () => {
    const d = parseISO('2026-06-17T10:00:00Z');
    expect(d.toISOString()).toBe('2026-06-17T10:00:00.000Z');
  });

  it('parseISO() should throw on invalid', () => {
    expect(() => parseISO('not-a-date')).toThrow('Invalid ISO date string');
  });

  it('elapsedSince() should calculate elapsed time', () => {
    const start = Date.now() - 100;
    const elapsed = elapsedSince(start);
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});
