import { HistoricalRound, Regime } from '../types.js';
import { mean, std, hitRate } from '../features/calculators.js';
import { randomUUID } from 'crypto';

export class RegimeDetector {
  detect(priorRounds: HistoricalRound[], atTimestamp = new Date().toISOString()): Regime {
    const window = priorRounds.slice(-50);
    const recentCps = window.map((r) => r.crashPoint);
    const n = recentCps.length;
    const lowConc = n ? recentCps.filter((c) => c < 1.5).length / n : 0;
    const highConc = n ? recentCps.filter((c) => c >= 5).length / n : 0;
    const vol = std(recentCps);
    const meanCp = mean(recentCps);
    let streakState: Regime['dimensions']['streakState'] = 'neutral';
    const consecLow = this.countConsec(recentCps, (c) => c < 1.3);
    const consecHigh = this.countConsec(recentCps, (c) => c >= 2.0);
    if (consecLow >= 5) streakState = 'low';
    else if (consecHigh >= 3) streakState = 'high';
    else if (consecLow >= 2 && consecHigh >= 1) streakState = 'mixed';
    const thresholdFrequency = {
      '1.30': hitRate(window, 1.3), '2.00': hitRate(window, 2.0),
      '5.00': hitRate(window, 5.0), '10.00': hitRate(window, 10.0),
    };
    const anomalyState = n < 10 || vol > 20 || meanCp > 50;
    const explanation: string[] = [];
    if (lowConc > 0.7) explanation.push(`High low-multiplier concentration (${(lowConc * 100).toFixed(0)}%)`);
    if (highConc > 0.15) explanation.push(`Elevated high-multiplier frequency`);
    if (vol > 5) explanation.push(`Elevated volatility (σ=${vol.toFixed(2)})`);
    if (streakState === 'low') explanation.push(`Consecutive low streak of ${consecLow}`);
    if (anomalyState) explanation.push('Anomaly flags active');
    if (explanation.length === 0) explanation.push('Neutral regime');
    let name = 'neutral';
    if (anomalyState) name = 'anomalous';
    else if (lowConc > 0.75 && streakState === 'low') name = 'deep-low';
    else if (highConc > 0.2) name = 'high-activity';
    else if (vol > 8) name = 'high-volatility';
    else if (lowConc > 0.6) name = 'low-concentration';
    return {
      id: randomUUID(), name,
      dimensions: { lowMultiplierConcentration: lowConc, highMultiplierConcentration: highConc, volatility: vol, streakState, thresholdFrequency, anomalyState },
      confidence: Math.min(1, Math.max(0.2, n / 50)),
      explanation, detectedAt: atTimestamp,
    };
  }
  private countConsec(cps: number[], pred: (c: number) => boolean): number {
    let s = 0;
    for (let i = cps.length - 1; i >= 0; i--) { if (pred(cps[i])) s++; else break; }
    return s;
  }
}
