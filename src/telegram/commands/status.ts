/**
 * Telegram Operator Interface — Status Commands
 *
 * /status, /balance, /daily, /session, /pnl, /entries, /health, /lastround
 */

import { CommandHandler, CommandResult, OperatorContext } from '../types';
import { RouterDependencies } from '../router';

export function createStatusHandlers(
  deps: RouterDependencies
): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();

  handlers.set('/status', async (_ctx: OperatorContext): Promise<CommandResult> => {
    const state = deps.getOrchestratorState?.() as Record<string, unknown> | undefined;

    const mode = (state?.mode as string) ?? 'unknown';
    const running = state?.running ?? false;
    const sessionId = (state?.sessionId as string) ?? 'none';
    const roundsObserved = (state?.roundsObserved as number) ?? 0;
    const errors = (state?.errors as number) ?? 0;
    const startedAt = (state?.startedAt as string) ?? null;

    const uptime = startedAt
      ? formatDuration(Date.now() - new Date(startedAt).getTime())
      : 'N/A';

    const emoji = running ? '🟢' : '🔴';
    const modeEmoji = getModeEmoji(mode);

    const message = [
      `${emoji} System Status`,
      '',
      `Mode: ${modeEmoji} ${mode}`,
      `Running: ${running ? 'Yes' : 'No'}`,
      `Session: ${sessionId}`,
      `Rounds Observed: ${roundsObserved}`,
      `Errors: ${errors}`,
      `Uptime: ${uptime}`,
      '',
      'Use /balance, /daily, /health for more details.',
    ].join('\n');

    return { success: true, message };
  });

  handlers.set('/balance', async (_ctx: OperatorContext): Promise<CommandResult> => {
    const state = deps.getOrchestratorState?.() as Record<string, unknown> | undefined;
    const balance = (state?.balance as number) ?? null;

    const message = balance !== null
      ? `💰 *Current Balance*\n\n${formatCurrency(balance)}`
      : '💰 *Current Balance*\n\n_No balance data available._';

    return { success: true, message, parseMode: 'MarkdownV2' };
  });

  handlers.set('/daily', async (_ctx: OperatorContext): Promise<CommandResult> => {
    const summary = deps.getLedgerSummary?.() as Record<string, unknown> | undefined;

    const dailyKey = (summary?.dailyKey as string) ?? new Date().toISOString().slice(0, 10);
    const entriesConfirmed = (summary?.entriesConfirmed as number) ?? 0;
    const entriesAttempted = (summary?.entriesAttempted as number) ?? 0;
    const wins = (summary?.wins as number) ?? 0;
    const losses = (summary?.losses as number) ?? 0;
    const netPnl = (summary?.netPnl as number) ?? 0;
    const maxDrawdown = (summary?.maxDrawdown as number) ?? 0;

    const pnlEmoji = netPnl >= 0 ? '🟢' : '🔴';

    const message = [
      `📅 *Daily Summary — ${dailyKey}*`,
      '',
      `*Entries:* ${entriesConfirmed}/${entriesAttempted} confirmed`,
      `*Wins/Losses:* ${wins}W / ${losses}L`,
      `*Net P&L:* ${pnlEmoji} ${formatCurrency(netPnl)}`,
      `*Max Drawdown:* ${formatPercentage(maxDrawdown)}`,
    ].join('\n');

    return { success: true, message, parseMode: 'MarkdownV2' };
  });

  handlers.set('/session', async (_ctx: OperatorContext): Promise<CommandResult> => {
    const state = deps.getOrchestratorState?.() as Record<string, unknown> | undefined;

    const sessionId = (state?.sessionId as string) ?? 'none';
    const mode = (state?.mode as string) ?? 'unknown';
    const roundsObserved = (state?.roundsObserved as number) ?? 0;
    const ticksRecorded = (state?.ticksRecorded as number) ?? 0;
    const startedAt = (state?.startedAt as string) ?? null;

    const message = [
      `🔑 *Session Info*`,
      '',
      `*ID:* \`${sessionId}\``,
      `*Mode:* ${mode}`,
      `*Rounds:* ${roundsObserved}`,
      `*Ticks:* ${ticksRecorded}`,
      `*Started:* ${startedAt ? new Date(startedAt).toLocaleString() : 'N/A'}`,
    ].join('\n');

    return { success: true, message, parseMode: 'MarkdownV2' };
  });

  handlers.set('/pnl', async (_ctx: OperatorContext): Promise<CommandResult> => {
    const summary = deps.getLedgerSummary?.() as Record<string, unknown> | undefined;

    const netPnl = (summary?.netPnl as number) ?? 0;
    const grossProfit = (summary?.grossProfit as number) ?? 0;
    const grossLoss = (summary?.grossLoss as number) ?? 0;
    const hitRate = (summary?.hitRate as number) ?? null;

    const message = [
      `📊 *P&L Summary*`,
      '',
      `*Net P&L:* ${formatCurrency(netPnl)}`,
      `*Gross Profit:* ${formatCurrency(grossProfit)}`,
      `*Gross Loss:* ${formatCurrency(grossLoss)}`,
      `*Hit Rate:* ${hitRate !== null ? `${(hitRate * 100).toFixed(1)}%` : 'N/A'}`,
    ].join('\n');

    return { success: true, message, parseMode: 'MarkdownV2' };
  });

  handlers.set('/entries', async (_ctx: OperatorContext): Promise<CommandResult> => {
    const summary = deps.getLedgerSummary?.() as Record<string, unknown> | undefined;

    const entriesConfirmed = (summary?.entriesConfirmed as number) ?? 0;
    const entriesAttempted = (summary?.entriesAttempted as number) ?? 0;
    const entriesFailed = (summary?.entriesFailed as number) ?? 0;
    const entriesReserved = (summary?.entriesReserved as number) ?? 0;

    const message = [
      `🎫 *Entry Counts*`,
      '',
      `*Confirmed:* ${entriesConfirmed}`,
      `*Attempted:* ${entriesAttempted}`,
      `*Failed:* ${entriesFailed}`,
      `*Reserved:* ${entriesReserved}`,
    ].join('\n');

    return { success: true, message, parseMode: 'MarkdownV2' };
  });

  handlers.set('/health', async (_ctx: OperatorContext): Promise<CommandResult> => {
    const health = deps.getHealthStatus?.() as Record<string, unknown> | undefined;

    const status = (health?.status as string) ?? 'unknown';
    const checks = (health?.checks as Array<{ name: string; ok: boolean; message?: string }>) ?? [];

    const statusEmoji = status === 'healthy' ? '🟢' : status === 'degraded' ? '🟡' : '🔴';

    const checkLines = checks.map((c) => {
      const emoji = c.ok ? '✅' : '❌';
      return `${emoji} ${c.name}${c.message ? `: ${c.message}` : ''}`;
    });

    const message = [
      `${statusEmoji} *Health Status — ${status.toUpperCase()}*`,
      '',
      ...checkLines,
    ].join('\n');

    return { success: true, message, parseMode: 'MarkdownV2' };
  });

  handlers.set('/lastround', async (_ctx: OperatorContext): Promise<CommandResult> => {
    const state = deps.getOrchestratorState?.() as Record<string, unknown> | undefined;

    const currentRoundId = (state?.currentRoundId as string) ?? null;
    const lastCrashPoint = (state?.lastCrashPoint as number) ?? null;

    const message = currentRoundId
      ? [
          `🎯 *Last Round*`,
          '',
          `*Round ID:* \`${currentRoundId}\``,
          `*Crash Point:* ${lastCrashPoint !== null ? `${lastCrashPoint}x` : 'N/A'}`,
        ].join('\n')
      : '🎯 *Last Round*\n\n_No round data available._';

    return { success: true, message, parseMode: 'MarkdownV2' };
  });

  return handlers;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getModeEmoji(mode: string): string {
  switch (mode) {
    case 'live': return '🔴';
    case 'dry-run': return '🟡';
    case 'observe-only': return '🔵';
    case 'maintenance': return '🔧';
    default: return '⚪';
  }
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
