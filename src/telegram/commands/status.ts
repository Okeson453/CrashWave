/**
 * Telegram Operator Interface — Status / Read-only Commands
 *
 *   /status      — overall state (mode, session, virtual balance, last round)
 *   /balance     — virtual ledger balance (and breakdown)
 *   /pnl         — daily P&L
 *   /daily       — daily entries / wins / losses / drawdown
 *   /entries     — recent virtual trades
 *   /session     — current session
 *   /health      — health check (DB, workers, Telegram)
 *   /lastround   — most recent round
 *
 * In personal-use the bot is single-process; these handlers read from
 * the RouterDependencies injected at startup (composition wires the
 * dry-run controller, virtual ledger, orchestrator, and health monitor).
 */
import { CommandHandler, CommandResult } from '../types';
import { RouterDependencies } from '../router';

function num(x: unknown, digits = 2): string {
  const n = typeof x === 'number' ? x : Number(x ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}

function modeEmoji(mode: string | undefined): string {
  switch (mode) {
    case 'live': return '🔴 LIVE';
    case 'dry-run': return '🟡 DRY-RUN';
    case 'observe-only': return '⚪ OBSERVE-ONLY';
    case 'maintenance': return '🛠 MAINTENANCE';
    default: return '❔ UNKNOWN';
  }
}

export function createStatusHandlers(deps: RouterDependencies): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();

  const reply = (message: string): CommandResult => ({
    success: true,
    message,
    parseMode: 'Markdown',
  });

  /** Read a snapshot from deps with safe fallback. */
  function readState(): Record<string, unknown> {
    try {
      const s = deps.getOrchestratorState?.();
      return (s && typeof s === 'object' ? s as Record<string, unknown> : {});
    } catch {
      return {};
    }
  }
  function readHealth(): Record<string, unknown> {
    try {
      const s = deps.getHealthStatus?.();
      return (s && typeof s === 'object' ? s as Record<string, unknown> : {});
    } catch {
      return {};
    }
  }
  function readLedger(): Record<string, unknown> {
    try {
      const s = deps.getLedgerSummary?.();
      return (s && typeof s === 'object' ? s as Record<string, unknown> : {});
    } catch {
      return {};
    }
  }

  handlers.set('/status', async (): Promise<CommandResult> => {
    const state = readState();
    const health = readHealth();
    const ledger = readLedger();

    const mode = String(state.mode ?? health.mode ?? 'unknown');
    const session = String(state.sessionId ?? state.session ?? '—');
    const uptimeSec = Number(state.uptimeSeconds ?? state.uptime ?? 0);
    const lastRound = state.lastRound as Record<string, unknown> | undefined;
    const hr = Number(health.status === 'healthy' ? 1 : health.status === 'degraded' ? 2 : health.status === 'unhealthy' ? 3 : 0);

    const balance = Number(ledger.virtualBalance ?? ledger.balance ?? 0);
    const initial = Number(ledger.initialBalance ?? 0);
    const pnl = Number(ledger.netPnl ?? 0);
    const wins = Number(ledger.wins ?? 0);
    const losses = Number(ledger.losses ?? 0);
    const winRate = Number(ledger.winRate ?? 0);
    const openTrades = Number(ledger.openTrades ?? 0);
    const maxDrawdown = Number(ledger.maxDrawdown ?? 0);

    return reply([
      '*Bot Status*',
      '',
      `Mode: ${modeEmoji(mode)}`,
      `Session: \`${session}\``,
      `Uptime: ${uptimeSec.toFixed(0)} s`,
      `Health: ${hr === 1 ? '✅ healthy' : hr === 2 ? '⚠️ degraded' : hr === 3 ? '❌ unhealthy' : '—'}`,
      '',
      '*Virtual ledger*',
      `Balance: ${num(balance)} (initial ${num(initial)})`,
      `Net P&L: ${num(pnl)}`,
      `Wins / Losses: ${wins} / ${losses} (win rate ${num(winRate * 100, 1)}%)`,
      `Open trades: ${openTrades}`,
      `Max drawdown: ${num(maxDrawdown)}`,
      '',
      '*Last round*',
      lastRound
        ? `id=\`${String(lastRound.id ?? '—')}\` crash=${num(lastRound.crashPoint ?? lastRound.crash, 2)}x at ${String(lastRound.crashedAt ?? '—')}`
        : '— (no rounds observed yet)',
    ].join('\n'));
  });

  handlers.set('/balance', async (): Promise<CommandResult> => {
    const ledger = readLedger();
    const balance = Number(ledger.virtualBalance ?? ledger.balance ?? 0);
    const initial = Number(ledger.initialBalance ?? 0);
    const pnl = Number(ledger.netPnl ?? 0);
    return reply([
      '*Virtual ledger balance*',
      '',
      `Current: ${num(balance)}`,
      `Initial: ${num(initial)}`,
      `Net P&L: ${pnl >= 0 ? '+' : ''}${num(pnl)}`,
    ].join('\n'));
  });

  handlers.set('/pnl', async (): Promise<CommandResult> => {
    const ledger = readLedger();
    const pnl = Number(ledger.netPnl ?? 0);
    const wins = Number(ledger.wins ?? 0);
    const losses = Number(ledger.losses ?? 0);
    const winRate = Number(ledger.winRate ?? 0);
    const maxDrawdown = Number(ledger.maxDrawdown ?? 0);
    return reply([
      '*Daily P&L*',
      '',
      `Net P&L: ${pnl >= 0 ? '+' : ''}${num(pnl)}`,
      `Wins / Losses: ${wins} / ${losses} (win rate ${num(winRate * 100, 1)}%)`,
      `Max drawdown: ${num(maxDrawdown)}`,
    ].join('\n'));
  });

  handlers.set('/daily', async (): Promise<CommandResult> => {
    const ledger = readLedger();
    const ledgerTrades = Number(ledger.trades ?? 0);
    const wins = Number(ledger.wins ?? 0);
    const losses = Number(ledger.losses ?? 0);
    const dailyTrades = Number(ledger.dailyTrades ?? ledgerTrades);
    const winRate = Number(ledger.winRate ?? 0);
    const pnl = Number(ledger.netPnl ?? 0);
    const maxDrawdown = Number(ledger.maxDrawdown ?? 0);
    return reply([
      '*Today*',
      '',
      `Entries: ${dailyTrades}`,
      `Wins / Losses: ${wins} / ${losses} (win rate ${num(winRate * 100, 1)}%)`,
      `Net P&L: ${pnl >= 0 ? '+' : ''}${num(pnl)}`,
      `Max drawdown: ${num(maxDrawdown)}`,
    ].join('\n'));
  });

  handlers.set('/entries', async (): Promise<CommandResult> => {
    const state = readState();
    const recent = (state.recentTrades as Array<Record<string, unknown>> | undefined) ?? [];
    if (recent.length === 0) {
      return reply('*Recent virtual trades*\n\n_(none yet)_');
    }
    const lines = ['*Recent virtual trades*', ''];
    for (const t of recent.slice(0, 10)) {
      const stake = Number(t.stake ?? 0);
      const target = Number(t.target ?? 0);
      const status = String(t.status ?? 'OPEN');
      const pnl = t.pnl == null ? '' : ` pnl=${num(t.pnl)}`;
      lines.push(`• \`${String(t.virtualTradeId ?? t.id ?? '?')}\` ${status} stake=${num(stake)} target=${num(target, 2)}x round=\`${String(t.roundId ?? '—')}\`${pnl}`);
    }
    return reply(lines.join('\n'));
  });

  handlers.set('/session', async (): Promise<CommandResult> => {
    const state = readState();
    const sessionId = String(state.sessionId ?? state.session ?? '—');
    const mode = String(state.mode ?? '—');
    const uptime = Number(state.uptimeSeconds ?? state.uptime ?? 0);
    return reply([
      '*Session*',
      '',
      `id: \`${sessionId}\``,
      `mode: ${mode}`,
      `uptime: ${uptime.toFixed(0)} s`,
    ].join('\n'));
  });

  handlers.set('/health', async (): Promise<CommandResult> => {
    const health = readHealth();
    const lines = ['*Health*', ''];
    if (Object.keys(health).length === 0) {
      lines.push('_(no health monitor wired in personal-use composition)_');
    } else {
      for (const [k, v] of Object.entries(health)) {
        lines.push(`• ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      }
    }
    return reply(lines.join('\n'));
  });

  handlers.set('/lastround', async (): Promise<CommandResult> => {
    const state = readState();
    const last = state.lastRound as Record<string, unknown> | undefined;
    if (!last) {
      return reply('*Last round*\n\n_(none observed yet)_');
    }
    return reply([
      '*Last round*',
      '',
      `id: \`${String(last.id ?? '—')}\``,
      `crash: ${num(last.crashPoint ?? last.crash, 2)}x`,
      `started: ${String(last.startedAt ?? '—')}`,
      `crashed at: ${String(last.crashedAt ?? '—')}`,
    ].join('\n'));
  });

  return handlers;
}