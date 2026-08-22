export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export function now(): number {
  return Date.now();
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getUTCStartOfDay(date?: Date | string): Date {
  const d = date ? new Date(date) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function getUTCEndOfDay(date?: Date | string): Date {
  const start = getUTCStartOfDay(date);
  return new Date(start.getTime() + MS_PER_DAY - 1);
}

export function getDayKey(date?: Date | string, timezone = 'UTC'): string {
  const d = date ? new Date(date) : new Date();
  if (timezone === 'UTC') {
    return d.toISOString().slice(0, 10);
  }
  try {
    return d.toLocaleDateString('en-CA', { timeZone: timezone });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function isSameDay(a: Date | string, b: Date | string, timezone = 'UTC'): boolean {
  return getDayKey(a, timezone) === getDayKey(b, timezone);
}

export function addDays(date: Date | string, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return `${hours}h ${minutes}m`;
}

export function parseISO(isoString: string): Date {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid ISO date string: ${isoString}`);
  }
  return d;
}

export function elapsedSince(start: Date | string | number): number {
  const startTime = typeof start === 'number' ? start : new Date(start).getTime();
  return Date.now() - startTime;
}
