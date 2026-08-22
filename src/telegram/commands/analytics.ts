/**
 * Telegram Operator Interface — Analytics Commands
 *
 * /analytics summary
 * /analytics today
 * /analytics <window>
 * /analytics drawdown
 */

import { CommandHandler, CommandResult, OperatorContext } from '../types';
import { RouterDependencies } from '../router';
export function createAnalyticsHandlers(
  deps: RouterDependencies
): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();

  handlers.set('/analytics', async (_ctx: OperatorContext, args: string[]): Promise<CommandResult> => {
    const subcommand = args[0]?.toLowerCase() ?? 'summary';

    if (subcommand === 'summary') {
      return handleSummary(deps);
    }

    if (subcommand === 'today') {
      return handleToday(deps);
    }

    if (subcommand === 'drawdown') {
      return handleDrawdown(deps);
    }

    // Try to parse as a window (e.g., "7d", "24h", "1w")
    const windowMatch = subcommand.match(/^(\d+)([dhwm])$/);
    if (windowMatch) {
      return handleWindow(deps, parseInt(windowMatch[1], 10), windowMatch[2]);
    }

    return {
      success: false,
      message: [
        '📈 *Analytics Commands*',
        '',
        '`/analytics summary` — Full performance summary',
        '`/analytics today` — Today\'s performance',
        '`/analytics <window>` — Windowed analysis (e.g., `7d`, `24h`, `1w`)',
        '`/analytics drawdown` — Drawdown analysis',
      ].join('\n'),
      parseMode: 'MarkdownV2',
    };
  });

  return handlers;
}

async function handleSummary(deps: RouterDependencies): Promise<CommandResult> {
  const summary = deps.getLedgerSummary?.() as Record<string, unknown> | undefined;

  const totalBets = (summary?.totalBets as number) ?? 0;
  const wins = (summary?.wins as number) ?? 0;
  const losses = (summary?.losses as number) ?? 0;
  const netPnl = (summary?.netPnl as number) ?? 0;
  const hitRate = (summary?.hitRate as number) ?? null;
  const maxDrawdown = (summary?.maxDrawdown as number) ?? 0;
  const expectedValue = (summary?.expectedValue as number) ?? 0;
  const currentStreak = (summary?.currentStreak as number) ?? 0;
  const currentStreakType = (summary?.currentStreakType as string) ?? 'none';

  const pnlEmoji = netPnl >= 0 ? '🟢' : '🔴';
  const streakEmoji = currentStreakType === 'win' ? '🔥' : currentStreakType === 'loss' ? '❄️' : '➖';

  const message = [
    '📊 *Performance Summary*',
    '',
    `*Total Bets:* ${totalBets}`,
    `*Wins/Losses:* ${wins}W / ${losses}L`,
    `*Hit Rate:* ${hitRate !== null ? `${(hitRate * 100).toFixed(1)}%` : 'N/A'}`,
    `*Net P&L:* ${pnlEmoji} ${formatCurrency(netPnl)}`,
    `*Expected Value:* ${formatCurrency(expectedValue)}`,
    `*Max Drawdown:* ${formatPercentage(maxDrawdown)}`,
    `*Current Streak:* ${streakEmoji} ${currentStreak} ${currentStreakType}`,
  ].join('\n');

  return { success: true, message, parseMode: 'MarkdownV2' };
}

async function handleToday(deps: RouterDependencies): Promise<CommandResult> {
  const summary = deps.getLedgerSummary?.() as Record<string, unknown> | undefined;

  const dailyKey = (summary?.dailyKey as string) ?? new Date().toISOString().slice(0, 10);
  const entriesConfirmed = (summary?.entriesConfirmed as number) ?? 0;
  const wins = (summary?.wins as number) ?? 0;
  const losses = (summary?.losses as number) ?? 0;
  const netPnl = (summary?.netPnl as number) ?? 0;
  const balanceStart = (summary?.balanceStart as number) ?? null;
  const balanceEnd = (summary?.balanceEnd as number) ?? null;
  const cashOutSuccessRate = (summary?.cashOutSuccessRate as number) ?? null;

  const pnlEmoji = netPnl >= 0 ? '🟢' : '🔴';
  const balanceChange = balanceStart !== null && balanceEnd !== null
    ? balanceEnd - balanceStart
    : null;

  const message = [
    `📅 *Today — ${dailyKey}*`,
    '',
    `*Entries:* ${entriesConfirmed}`,
    `*Wins/Losses:* ${wins}W / ${losses}L`,
    `*Net P&L:* ${pnlEmoji} ${formatCurrency(netPnl)}`,
    balanceChange !== null ? `*Balance Change:* ${formatCurrency(balanceChange)}` : '',
    `*Cash-out Rate:* ${cashOutSuccessRate !== null ? `${(cashOutSuccessRate * 100).toFixed(1)}%` : 'N/A'}`,
  ].filter(Boolean).join('\n');

  return { success: true, message, parseMode: 'MarkdownV2' };
}

async function handleWindow(
  deps: RouterDependencies,
  amount: number,
  unit: string
): Promise<CommandResult> {
  const unitLabels: Record<string, string> = {
    h: 'hours',
    d: 'days',
    w: 'weeks',
    m: 'months',
  };

  const label = `${amount} ${unitLabels[unit] ?? unit}`;

  // Query analytics / ledger for the requested window when available (P1.1)
  const summary = deps.getLedgerSummary?.() as Record<string, unknown> | undefined;
  const analytics = deps.getWindowedAnalytics?.(amount, unit) as Record<string, unknown> | undefined;

  const netPnl = (analytics?.netPnl as number) ?? (summary?.netPnl as number) ?? 0;
  const hitRate = analytics?.hitRate as number | undefined;
  const entries = analytics?.entries as number | undefined;
  const wins = analytics?.wins as number | undefined;
  const losses = analytics?.losses as number | undefined;
  const maxDd = analytics?.maxDrawdown as number | undefined;
  const cashOutRate = analytics?.cashOutSuccessRate as number | undefined;
  const avgLatency = analytics?.avgLatencyMs as number | undefined;

  if (!analytics && !summary) {
    return {
      success: true,
      message: [
        `📈 *Windowed Analysis — ${label}*`,
        '',
        '_No analytics data available for this window yet._',
        '_Ensure the system has been observing and persisting rounds._',
      ].join('\n'),
      parseMode: 'MarkdownV2',
    };
  }

  const lines = [
    `📈 *Windowed Analysis — ${label}*`,
    '',
    entries !== undefined ? `*Entries:* ${entries}` : null,
    wins !== undefined && losses !== undefined ? `*Wins/Losses:* ${wins}W / ${losses}L` : null,
    hitRate !== undefined ? `*Hit Rate:* ${(hitRate * 100).toFixed(2)}%` : null,
    `*Net P&L:* ${formatCurrency(netPnl)}`,
    maxDd !== undefined ? `*Max Drawdown:* ${(maxDd * 100).toFixed(2)}%` : null,
    cashOutRate !== undefined ? `*Cash-out Success:* ${(cashOutRate * 100).toFixed(1)}%` : null,
    avgLatency !== undefined ? `*Avg Tick Latency:* ${avgLatency.toFixed(0)}ms` : null,
    '',
    '_Analytics are descriptive only; past performance does not guarantee future results._',
  ].filter(Boolean) as string[];

  return { success: true, message: lines.join('\n'), parseMode: 'MarkdownV2' };
}

async function handleDrawdown(deps: RouterDependencies): Promise<CommandResult> {
  const summary = deps.getLedgerSummary?.() as Record<string, unknown> | undefined;

  const maxDrawdown = (summary?.maxDrawdown as number) ?? 0;
  const currentDrawdown = (summary?.currentDrawdown as number) ?? 0;
  const peakPnl = (summary?.peakPnl as number) ?? 0;
  const netPnl = (summary?.netPnl as number) ?? 0;

  const ddEmoji = currentDrawdown > maxDrawdown * 0.8 ? '🔴' : currentDrawdown > maxDrawdown * 0.5 ? '🟡' : '🟢';

  const message = [
    '📉 *Drawdown Analysis*',
    '',
    `*Max Drawdown:* ${formatPercentage(maxDrawdown)}`,
    `*Current Drawdown:* ${ddEmoji} ${formatPercentage(currentDrawdown)}`,
    `*Peak P&L:* ${formatCurrency(peakPnl)}`,
    `*Current P&L:* ${formatCurrency(netPnl)}`,
    '',
    currentDrawdown > maxDrawdown * 0.8
      ? '⚠️ _Current drawdown is near historical maximum. Consider reducing exposure._'
      : '_Drawdown is within normal range._',
  ].join('\n');

  return { success: true, message, parseMode: 'MarkdownV2' };
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
