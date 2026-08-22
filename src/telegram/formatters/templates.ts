/**
 * Telegram Operator Interface — Message Templates
 *
 * Markdown/HTML message templates, emoji indicators, severity colors.
 * All templates are pure functions that accept data and return formatted strings.
 */

import { NotificationSeverity, NotificationCategory, NotificationPayload } from '../types';

// ─── Severity Indicators ─────────────────────────────────────────────────────

export const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  critical: '🚨',
  warning: '⚠️',
  info: 'ℹ️',
  debug: '🔍',
};

export const SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  critical: 'CRITICAL',
  warning: 'WARNING',
  info: 'INFO',
  debug: 'DEBUG',
};

export const CATEGORY_EMOJI: Record<NotificationCategory, string> = {
  win: '🏆',
  loss: '💸',
  error: '❌',
  health: '💓',
  milestone: '🎯',
  system: '⚙️',
  config: '🔧',
};

// ─── Template Functions ──────────────────────────────────────────────────────

export interface FormattedMessage {
  text: string;
  parseMode: 'MarkdownV2' | 'HTML';
}

/**
 * Format a single notification payload into a Telegram message.
 */
export function formatNotification(payload: NotificationPayload): FormattedMessage {
  const emoji = SEVERITY_EMOJI[payload.severity];
  const catEmoji = CATEGORY_EMOJI[payload.category];
  const label = SEVERITY_LABEL[payload.severity];

  const lines = [
    `${emoji} *${label}* ${catEmoji}`,
    '',
    `*${escapeMarkdown(payload.title)}*`,
    escapeMarkdown(payload.message),
  ];

  if (payload.metadata && Object.keys(payload.metadata).length > 0) {
    lines.push('', '*Details:*');
    for (const [key, value] of Object.entries(payload.metadata)) {
      lines.push(`• \`${escapeMarkdown(key)}\`: \`${escapeMarkdown(String(value))}\``);
    }
  }

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

/**
 * Format a batch of notifications into a single consolidated message.
 */
export function formatBatch(notifications: NotificationPayload[]): FormattedMessage {
  if (notifications.length === 0) {
    return { text: '', parseMode: 'MarkdownV2' };
  }

  if (notifications.length === 1) {
    return formatNotification(notifications[0]);
  }

  // Group by severity
  const bySeverity: Record<string, NotificationPayload[]> = {};
  for (const n of notifications) {
    if (!bySeverity[n.severity]) bySeverity[n.severity] = [];
    bySeverity[n.severity].push(n);
  }

  const lines = [
    `📬 *${notifications.length} Notifications*`,
    '',
  ];

  for (const severity of ['critical', 'warning', 'info', 'debug'] as NotificationSeverity[]) {
    const group = bySeverity[severity];
    if (!group || group.length === 0) continue;

    const emoji = SEVERITY_EMOJI[severity];
    lines.push(`${emoji} *${SEVERITY_LABEL[severity]}* (${group.length})`);

    for (const n of group) {
      const catEmoji = CATEGORY_EMOJI[n.category];
      lines.push(`  ${catEmoji} ${escapeMarkdown(n.title)}`);
    }
    lines.push('');
  }

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

/**
 * Format a win notification.
 */
export function formatWin(params: {
  betId: string;
  roundId: string;
  stake: number;
  cashOutMultiplier: number;
  pnl: number;
}): FormattedMessage {
  const { betId, roundId, stake, cashOutMultiplier, pnl } = params;
  const lines = [
    '🏆 *WIN*',
    '',
    `*Bet ID:* \`${betId}\``,
    `*Round:* \`${roundId}\``,
    `*Stake:* ${stake.toFixed(2)}`,
    `*Cash Out:* ${cashOutMultiplier.toFixed(2)}x`,
    `*P&L:* 🟢 +${pnl.toFixed(2)}`,
  ];

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

/**
 * Format a loss notification.
 */
export function formatLoss(params: {
  betId: string;
  roundId: string;
  stake: number;
  crashPoint: number;
  pnl: number;
}): FormattedMessage {
  const { betId, roundId, stake, crashPoint, pnl } = params;
  const lines = [
    '💸 *LOSS*',
    '',
    `*Bet ID:* \`${betId}\``,
    `*Round:* \`${roundId}\``,
    `*Stake:* ${stake.toFixed(2)}`,
    `*Crashed At:* ${crashPoint.toFixed(2)}x`,
    `*P&L:* 🔴 ${pnl.toFixed(2)}`,
  ];

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

/**
 * Format a critical error notification.
 */
export function formatCriticalError(params: {
  message: string;
  code: string;
  component: string;
}): FormattedMessage {
  const { message, code, component } = params;
  const lines = [
    '🚨 *CRITICAL ERROR*',
    '',
    `*Component:* \`${escapeMarkdown(component)}\``,
    `*Code:* \`${escapeMarkdown(code)}\``,
    '',
    escapeMarkdown(message),
    '',
    '_Immediate operator attention required._',
  ];

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

/**
 * Format a health warning.
 */
export function formatHealthWarning(params: {
  component: string;
  status: string;
  message: string;
}): FormattedMessage {
  const { component, status, message } = params;
  const lines = [
    '💓 *Health Warning*',
    '',
    `*Component:* \`${escapeMarkdown(component)}\``,
    `*Status:* ${escapeMarkdown(status)}`,
    '',
    escapeMarkdown(message),
  ];

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

/**
 * Format a milestone notification.
 */
export function formatMilestone(params: {
  milestone: string;
  value: string | number;
  context?: string;
}): FormattedMessage {
  const { milestone, value, context } = params;
  const lines = [
    '🎯 *Milestone Reached*',
    '',
    `*${escapeMarkdown(milestone)}:* ${escapeMarkdown(String(value))}`,
  ];

  if (context) {
    lines.push('', escapeMarkdown(context));
  }

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

/**
 * Format a daily summary report.
 */
export function formatDailySummary(params: {
  dailyKey: string;
  entriesConfirmed: number;
  wins: number;
  losses: number;
  netPnl: number;
  maxDrawdown: number;
  hitRate: number | null;
}): FormattedMessage {
  const { dailyKey, entriesConfirmed, wins, losses, netPnl, maxDrawdown, hitRate } = params;
  const pnlEmoji = netPnl >= 0 ? '🟢' : '🔴';

  const lines = [
    `📋 *Daily Report — ${dailyKey}*`,
    '',
    `*Entries:* ${entriesConfirmed}`,
    `*Wins/Losses:* ${wins}W / ${losses}L`,
    `*Hit Rate:* ${hitRate !== null ? `${(hitRate * 100).toFixed(1)}%` : 'N/A'}`,
    `*Net P&L:* ${pnlEmoji} ${formatCurrency(netPnl)}`,
    `*Max Drawdown:* ${formatPercentage(maxDrawdown)}`,
  ];

  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
