/**
 * Telegram Operator Interface — Report Formatters
 *
 * Daily summaries, learning-curve updates, structured report cards.
 */

import { FormattedMessage, formatDailySummary } from './templates';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

export interface DailyReportData {
  dailyKey: string;
  entriesConfirmed: number;
  entriesAttempted: number;
  entriesFailed: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  balanceStart: number | null;
  balanceEnd: number | null;
  maxDrawdown: number;
  currentDrawdown: number;
  hitRate: number | null;
  averageLatencyMs: number | null;
  cashOutSuccessRate: number | null;
}

export interface LearningCurveData {
  totalRoundsObserved: number;
  totalBetsPlaced: number;
  cumulativePnl: number;
  winRateTrend: number[];
  pnlTrend: number[];
  avgLatencyTrend: number[];
}

export interface ReportCardData {
  period: string;
  grade: string;
  metrics: Array<{ label: string; value: string; status: 'good' | 'warning' | 'bad' }>;
  recommendations: string[];
}

/**
 * Format a daily report from ledger data.
 */
export function formatDailyReport(data: DailyReportData): FormattedMessage {
  logger.debug(
    { component: 'ReportFormatter', dailyKey: data.dailyKey },
    'Formatting daily report'
  );

  return formatDailySummary({
    dailyKey: data.dailyKey,
    entriesConfirmed: data.entriesConfirmed,
    wins: data.wins,
    losses: data.losses,
    netPnl: data.netPnl,
    maxDrawdown: data.maxDrawdown,
    hitRate: data.hitRate,
  });
}

/**
 * Format a learning-curve update showing trend data.
 */
export function formatLearningCurve(data: LearningCurveData): FormattedMessage {
  const { totalRoundsObserved, totalBetsPlaced, cumulativePnl, winRateTrend, pnlTrend } = data;

  const pnlEmoji = cumulativePnl >= 0 ? '🟢' : '🔴';
  const latestWinRate = winRateTrend.length > 0
    ? winRateTrend[winRateTrend.length - 1]
    : null;
  const winRateTrendEmoji = winRateTrend.length >= 2 && latestWinRate !== null
    ? (latestWinRate > winRateTrend[winRateTrend.length - 2] ? '📈' : '📉')
    : '➡️';

  const lines = [
    '📚 *Learning Curve Update*',
    '',
    `*Rounds Observed:* ${totalRoundsObserved}`,
    `*Bets Placed:* ${totalBetsPlaced}`,
    `*Cumulative P&L:* ${pnlEmoji} ${formatCurrency(cumulativePnl)}`,
    `*Latest Win Rate:* ${winRateTrendEmoji} ${latestWinRate !== null ? `${(latestWinRate * 100).toFixed(1)}%` : 'N/A'}`,
    '',
  ];

  if (pnlTrend.length > 0) {
    lines.push('*P&L Trend (last 10):*');
    const recent = pnlTrend.slice(-10);
    const sparkline = recent.map((v) => v >= 0 ? '▲' : '▼').join('');
    lines.push(`\`${sparkline}\``);
    lines.push('');
  }

  lines.push('_The system continuously learns from each round._');

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

/**
 * Format a structured report card with grades and recommendations.
 */
export function formatReportCard(data: ReportCardData): FormattedMessage {
  const gradeEmoji = data.grade === 'A' ? '🏆' : data.grade === 'B' ? '✅' : data.grade === 'C' ? '⚠️' : '❌';

  const lines = [
    `📋 *Report Card — ${escapeMarkdown(data.period)}*`,
    '',
    `*Grade:* ${gradeEmoji} ${data.grade}`,
    '',
    '*Metrics:*',
  ];

  for (const metric of data.metrics) {
    const emoji = metric.status === 'good' ? '🟢' : metric.status === 'warning' ? '🟡' : '🔴';
    lines.push(`${emoji} *${escapeMarkdown(metric.label)}:* ${escapeMarkdown(metric.value)}`);
  }

  if (data.recommendations.length > 0) {
    lines.push('', '*Recommendations:*');
    for (const rec of data.recommendations) {
      lines.push(`• ${escapeMarkdown(rec)}`);
    }
  }

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_');
}
