import { HistoricalRound } from '../types.js';

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
export function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}
export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
}
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
export function hitRate(rounds: HistoricalRound[], threshold: number): number {
  if (rounds.length === 0) return 0;
  return rounds.filter((r) => r.crashPoint >= threshold).length / rounds.length;
}
export function roundsSince(rounds: HistoricalRound[], threshold: number): number {
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i].crashPoint >= threshold) return rounds.length - 1 - i;
  }
  return rounds.length;
}
export function consecutiveStreak(rounds: HistoricalRound[], predicate: (cp: number) => boolean): number {
  let streak = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (predicate(rounds[i].crashPoint)) streak++;
    else break;
  }
  return streak;
}
export function dayOfWeek(iso: string | null): number {
  if (!iso) return -1;
  return new Date(iso).getUTCDay();
}
export function hourOfDay(iso: string | null): number {
  if (!iso) return -1;
  return new Date(iso).getUTCHours();
}
export function computeFeatures(priorRounds: HistoricalRound[], predictionTimestamp: string): Record<string, number> {
  const cps = priorRounds.map((r) => r.crashPoint);
  const last10 = cps.slice(-10);
  const last50 = cps.slice(-50);
  const last100 = cps.slice(-100);
  return {
    roll_mean_50: mean(last50),
    roll_median_50: median(last50),
    roll_min_50: last50.length ? Math.min(...last50) : 0,
    roll_max_50: last50.length ? Math.max(...last50) : 0,
    roll_std_50: std(last50),
    roll_var_50: variance(last50),
    roll_p25_50: percentile(last50, 25),
    roll_p75_50: percentile(last50, 75),
    roll_p90_50: percentile(last50, 90),
    roll_mean_10: mean(last10),
    roll_std_10: std(last10),
    roll_mean_100: mean(last100),
    roll_std_100: std(last100),
    hit_1_30_50: hitRate(priorRounds.slice(-50), 1.3),
    hit_2_00_50: hitRate(priorRounds.slice(-50), 2.0),
    hit_5_00_50: hitRate(priorRounds.slice(-50), 5.0),
    hit_10_00_50: hitRate(priorRounds.slice(-50), 10.0),
    hit_1_30_100: hitRate(priorRounds.slice(-100), 1.3),
    hit_2_00_100: hitRate(priorRounds.slice(-100), 2.0),
    since_1_30: roundsSince(priorRounds, 1.3),
    since_2_00: roundsSince(priorRounds, 2.0),
    since_5_00: roundsSince(priorRounds, 5.0),
    since_10_00: roundsSince(priorRounds, 10.0),
    consec_below_1_30: consecutiveStreak(priorRounds, (cp) => cp < 1.3),
    consec_below_2_00: consecutiveStreak(priorRounds, (cp) => cp < 2.0),
    consec_above_2_00: consecutiveStreak(priorRounds, (cp) => cp >= 2.0),
    consec_above_5_00: consecutiveStreak(priorRounds, (cp) => cp >= 5.0),
    sample_size: cps.length,
    quality_score: priorRounds.length
      ? priorRounds.reduce((s, r) => s + (r.dataQuality === 'high' ? 1 : r.dataQuality === 'medium' ? 0.6 : 0.3), 0) / priorRounds.length
      : 0,
    hour_utc: hourOfDay(predictionTimestamp),
    dow_utc: dayOfWeek(predictionTimestamp),
  };
}
