/**
 * Day-boundary helpers for daily entry limits.
 * "Day" is defined by the configured timezone (default UTC).
 * All keys are YYYY-MM-DD in that timezone.
 */

/**
 * Returns the daily key (YYYY-MM-DD) for a given instant in the given IANA timezone.
 * Uses Intl so no extra dependency is required.
 */
export function getDailyKey(
  date: Date = new Date(),
  timezone: string = 'UTC'
): string {
  try {
    // en-CA yields YYYY-MM-DD
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(date);
  } catch {
    // Invalid timezone — fall back to UTC ISO date
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Returns the Date (as epoch ms) of the next day boundary after `date` in the given timezone.
 */
export function getNextDayBoundaryMs(
  date: Date = new Date(),
  timezone: string = 'UTC'
): number {
  const currentKey = getDailyKey(date, timezone);
  // Search forward in 15-minute steps until key changes (max 25h)
  let t = date.getTime();
  const step = 15 * 60 * 1000;
  for (let i = 0; i < 100; i++) {
    t += step;
    if (getDailyKey(new Date(t), timezone) !== currentKey) {
      // Binary-refine to nearest second within the step window
      let lo = t - step;
      let hi = t;
      while (hi - lo > 1000) {
        const mid = Math.floor((lo + hi) / 2);
        if (getDailyKey(new Date(mid), timezone) === currentKey) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return hi;
    }
  }
  // Fallback: UTC midnight + 24h
  const utcMidnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1
  );
  return utcMidnight;
}

/**
 * Returns true if `a` and `b` fall on different calendar days in `timezone`.
 */
export function crossesDayBoundary(
  a: Date,
  b: Date,
  timezone: string = 'UTC'
): boolean {
  return getDailyKey(a, timezone) !== getDailyKey(b, timezone);
}

/**
 * Milliseconds remaining until the next day boundary.
 */
export function msUntilDayBoundary(
  date: Date = new Date(),
  timezone: string = 'UTC'
): number {
  return Math.max(0, getNextDayBoundaryMs(date, timezone) - date.getTime());
}
