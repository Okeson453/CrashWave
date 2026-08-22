/**
 * Descriptive Analysis — Historical Crash Distribution & Pattern Detection
 *
 * Analyzes historical crash distributions, time-of-day patterns,
 * session effects, and latency correlations. All analysis is
 * descriptive only — no predictions are generated.
 */

import {
  DescriptiveAnalysis,
  CrashDistribution,
  TimeOfDayPattern,
  SessionEffect,
  BetOutcomeRecord,
  RoundObservationRecord,
} from '../types';

/**
 * Compute descriptive analysis from bet outcomes and round observations.
 *
 * @param outcomes — array of bet outcome records
 * @param rounds — array of round observation records
 * @returns DescriptiveAnalysis with full pattern analysis
 */
export function computeDescriptiveAnalysis(
  outcomes: BetOutcomeRecord[],
  rounds: RoundObservationRecord[]
): DescriptiveAnalysis {
  return {
    crashDistribution: computeCrashDistribution(rounds),
    timeOfDayPatterns: computeTimeOfDayPatterns(outcomes),
    sessionEffects: computeSessionEffects(outcomes),
    dayOfWeekPatterns: computeDayOfWeekPatterns(outcomes),
    latencyCorrelation: computeLatencyCorrelation(outcomes),
  };
}

/**
 * Compute crash point distribution across multiplier buckets.
 *
 * Buckets:
 *   < 1.00x, 1.00-1.29x, 1.30-1.99x, 2.00-4.99x, 5.00-9.99x, >= 10.00x
 */
export function computeCrashDistribution(
  rounds: RoundObservationRecord[]
): CrashDistribution[] {
  const buckets: { label: string; min: number; max: number | null; count: number }[] = [
    { label: '< 1.00x', min: 0, max: 1.0, count: 0 },
    { label: '1.00-1.29x', min: 1.0, max: 1.3, count: 0 },
    { label: '1.30-1.99x', min: 1.3, max: 2.0, count: 0 },
    { label: '2.00-4.99x', min: 2.0, max: 5.0, count: 0 },
    { label: '5.00-9.99x', min: 5.0, max: 10.0, count: 0 },
    { label: '>= 10.00x', min: 10.0, max: null, count: 0 },
  ];

  const validRounds = rounds.filter((r) => r.crashPoint !== null);

  for (const round of validRounds) {
    const cp = round.crashPoint!;
    for (const bucket of buckets) {
      if (bucket.max === null) {
        if (cp >= bucket.min) {
          bucket.count++;
          break;
        }
      } else {
        if (cp >= bucket.min && cp < bucket.max) {
          bucket.count++;
          break;
        }
      }
    }
  }

  const total = validRounds.length;
  let cumulative = 0;

  return buckets.map((bucket) => {
    const frequency = total > 0 ? bucket.count / total : 0;
    cumulative += frequency;
    return {
      bucket: bucket.label,
      minMultiplier: bucket.min,
      maxMultiplier: bucket.max ?? Infinity,
      count: bucket.count,
      frequency,
      cumulativeFrequency: cumulative,
    };
  });
}

/**
 * Compute time-of-day patterns from bet outcomes.
 *
 * Groups outcomes by hour of day and computes hit rate and average P&L.
 */
export function computeTimeOfDayPatterns(
  outcomes: BetOutcomeRecord[]
): TimeOfDayPattern[] {
  const hourStats = new Map<
    number,
    { entries: number; wins: number; totalPnl: number }
  >();

  for (const outcome of outcomes) {
    const hour = new Date(outcome.timestamp).getUTCHours();
    const stats = hourStats.get(hour) || { entries: 0, wins: 0, totalPnl: 0 };

    stats.entries++;
    stats.totalPnl += outcome.pnl;
    if (outcome.outcome === 'win') {
      stats.wins++;
    }

    hourStats.set(hour, stats);
  }

  const patterns: TimeOfDayPattern[] = [];

  for (let hour = 0; hour < 24; hour++) {
    const stats = hourStats.get(hour);
    if (stats && stats.entries > 0) {
      patterns.push({
        hour,
        entries: stats.entries,
        hitRate: stats.wins / stats.entries,
        avgPnl: stats.totalPnl / stats.entries,
      });
    }
  }

  return patterns.sort((a, b) => a.hour - b.hour);
}

/**
 * Compute day-of-week patterns from bet outcomes.
 */
export function computeDayOfWeekPatterns(
  outcomes: BetOutcomeRecord[]
): { day: string; entries: number; hitRate: number; pnl: number }[] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayStats = new Map<
    number,
    { entries: number; wins: number; totalPnl: number }
  >();

  for (const outcome of outcomes) {
    const day = new Date(outcome.timestamp).getUTCDay();
    const stats = dayStats.get(day) || { entries: 0, wins: 0, totalPnl: 0 };

    stats.entries++;
    stats.totalPnl += outcome.pnl;
    if (outcome.outcome === 'win') {
      stats.wins++;
    }

    dayStats.set(day, stats);
  }

  const patterns: { day: string; entries: number; hitRate: number; pnl: number }[] = [];

  for (let day = 0; day < 7; day++) {
    const stats = dayStats.get(day);
    if (stats && stats.entries > 0) {
      patterns.push({
        day: dayNames[day],
        entries: stats.entries,
        hitRate: stats.wins / stats.entries,
        pnl: stats.totalPnl,
      });
    }
  }

  return patterns;
}

/**
 * Compute session effects — how performance changes with session duration.
 *
 * Groups outcomes into time buckets and computes per-bucket metrics.
 */
export function computeSessionEffects(
  outcomes: BetOutcomeRecord[]
): SessionEffect[] {
  if (outcomes.length === 0) return [];

  // Sort by timestamp
  const sorted = [...outcomes].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const sessionStart = new Date(sorted[0].timestamp).getTime();
  const bucketMinutes = 30; // 30-minute buckets

  const bucketStats = new Map<
    number,
    { entries: number; wins: number; totalPnl: number; totalLatency: number; latencyCount: number }
  >();

  for (const outcome of sorted) {
    const elapsedMinutes =
      (new Date(outcome.timestamp).getTime() - sessionStart) / (1000 * 60);
    const bucket = Math.floor(elapsedMinutes / bucketMinutes);

    const stats = bucketStats.get(bucket) || {
      entries: 0,
      wins: 0,
      totalPnl: 0,
      totalLatency: 0,
      latencyCount: 0,
    };

    stats.entries++;
    stats.totalPnl += outcome.pnl;
    if (outcome.outcome === 'win') {
      stats.wins++;
    }
    if (outcome.latencyMs !== null) {
      stats.totalLatency += outcome.latencyMs;
      stats.latencyCount++;
    }

    bucketStats.set(bucket, stats);
  }

  const effects: SessionEffect[] = [];

  for (const [bucket, stats] of bucketStats) {
    if (stats.entries > 0) {
      effects.push({
        sessionDurationMinutes: (bucket + 1) * bucketMinutes,
        entries: stats.entries,
        hitRate: stats.wins / stats.entries,
        pnl: stats.totalPnl,
        latencyMs:
          stats.latencyCount > 0 ? stats.totalLatency / stats.latencyCount : 0,
      });
    }
  }

  return effects.sort((a, b) => a.sessionDurationMinutes - b.sessionDurationMinutes);
}

/**
 * Compute latency correlation — how hit rate varies with latency.
 *
 * Groups outcomes into latency buckets and computes hit rate per bucket.
 */
export function computeLatencyCorrelation(
  outcomes: BetOutcomeRecord[]
): { latencyRange: string; hitRate: number; count: number }[] {
  const buckets = [
    { label: '< 200ms', min: 0, max: 200 },
    { label: '200-499ms', min: 200, max: 500 },
    { label: '500-999ms', min: 500, max: 1000 },
    { label: '1000-1999ms', min: 1000, max: 2000 },
    { label: '>= 2000ms', min: 2000, max: Infinity },
  ];

  const bucketStats = new Map<
    string,
    { entries: number; wins: number }
  >();

  for (const outcome of outcomes) {
    if (outcome.latencyMs === null) continue;

    const latency = outcome.latencyMs;
    let label = 'unknown';

    for (const bucket of buckets) {
      if (latency >= bucket.min && latency < bucket.max) {
        label = bucket.label;
        break;
      }
    }

    const stats = bucketStats.get(label) || { entries: 0, wins: 0 };
    stats.entries++;
    if (outcome.outcome === 'win') {
      stats.wins++;
    }
    bucketStats.set(label, stats);
  }

  const correlations: { latencyRange: string; hitRate: number; count: number }[] = [];

  for (const bucket of buckets) {
    const stats = bucketStats.get(bucket.label);
    if (stats && stats.entries > 0) {
      correlations.push({
        latencyRange: bucket.label,
        hitRate: stats.wins / stats.entries,
        count: stats.entries,
      });
    }
  }

  return correlations;
}

/**
 * Compute the frequency of crashes below the target multiplier.
 *
 * @param rounds — round observation records
 * @param target — cash-out target
 * @returns frequency as a proportion (0-1)
 */
export function computeCrashBelowTargetFrequency(
  rounds: RoundObservationRecord[],
  target: number
): number {
  const valid = rounds.filter((r) => r.crashPoint !== null);
  if (valid.length === 0) return 0;

  const belowTarget = valid.filter((r) => r.crashPoint! < target).length;
  return belowTarget / valid.length;
}

/**
 * Compute the frequency of crashes below 1.00x (instant crashes).
 *
 * @param rounds — round observation records
 * @returns frequency as a proportion (0-1)
 */
export function computeInstantCrashFrequency(
  rounds: RoundObservationRecord[]
): number {
  const valid = rounds.filter((r) => r.crashPoint !== null);
  if (valid.length === 0) return 0;

  const instant = valid.filter((r) => r.crashPoint! < 1.0).length;
  return instant / valid.length;
}

/**
 * Format descriptive analysis for human-readable display.
 */
export function formatDescriptiveAnalysis(analysis: DescriptiveAnalysis): string {
  const lines: string[] = ['=== Crash Distribution ==='];

  for (const bucket of analysis.crashDistribution) {
    lines.push(
      `  ${bucket.bucket}: ${bucket.count} (${(bucket.frequency * 100).toFixed(1)}%)`
    );
  }

  lines.push('', '=== Time-of-Day Patterns ===');
  for (const pattern of analysis.timeOfDayPatterns) {
    lines.push(
      `  ${pattern.hour.toString().padStart(2, '0')}:00 UTC — ${pattern.entries} entries, HR ${(pattern.hitRate * 100).toFixed(1)}%, Avg P&L ${pattern.avgPnl.toFixed(2)}`
    );
  }

  lines.push('', '=== Session Effects ===');
  for (const effect of analysis.sessionEffects) {
    lines.push(
      `  ${effect.sessionDurationMinutes}m — ${effect.entries} entries, HR ${(effect.hitRate * 100).toFixed(1)}%, P&L ${effect.pnl.toFixed(2)}, Latency ${effect.latencyMs.toFixed(0)}ms`
    );
  }

  return lines.join('\n');
}
