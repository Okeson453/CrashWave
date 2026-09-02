/**
 * Telegram Operator Interface — Analytics
 *
 *   /analytics — ACIE signal statistics (signals emitted, accepted,
 *                rejected, avg probability, regime, calibration)
 */
import { CommandHandler, CommandResult } from '../types';
import { RouterDependencies } from '../router';

function num(x: unknown, digits = 2): string {
  const n = typeof x === 'number' ? x : Number(x ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}

export function createAnalyticsHandlers(deps: RouterDependencies): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();
  const reply = (message: string): CommandResult => ({
    success: true,
    message,
    parseMode: 'Markdown',
  });

  handlers.set('/analytics', async (): Promise<CommandResult> => {
    let analytics: Record<string, unknown> = {};
    try {
      const w = deps.getWindowedAnalytics?.(7, 'd');
      if (w && typeof w === 'object') analytics = w as Record<string, unknown>;
    } catch {
      // ignore
    }

    const signals = Number(analytics.signals ?? analytics.signalsEmitted ?? 0);
    const accepted = Number(analytics.signalsAccepted ?? analytics.accepted ?? 0);
    const rejected = Number(analytics.signalsRejected ?? analytics.rejected ?? 0);
    const avgProb = Number(analytics.avgProbability ?? 0);
    const avgConf = Number(analytics.avgConfidence ?? 0);
    const ev = Number(analytics.expectedValue ?? 0);
    const regime = String(analytics.regime ?? 'unknown');
    const modelVersion = String(analytics.modelVersion ?? '—');

    return reply([
      '*ACIE Analytics (last 7 days)*',
      '',
      `Signals: ${signals}  (accepted: ${accepted}, rejected: ${rejected})`,
      `Avg probability: ${num(avgProb, 3)}`,
      `Avg confidence: ${num(avgConf, 3)}`,
      `Expected value: ${num(ev, 4)}`,
      `Regime: ${regime}`,
      `Model: ${modelVersion}`,
      '',
      signals === 0 ? '_(no signals observed in the window yet — let dry-run run for a while)_' : '',
    ].filter(Boolean).join('\n'));
  });

  return handlers;
}