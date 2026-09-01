/**
 * Telegram Operator Interface — Start / Menu / Help
 *
 * /start  — welcome + command menu
 * /menu   — list of available commands
 * /help   — usage tips
 *
 * Personal-use: single operator, no menu tree, no admin / user split.
 */
import { CommandHandler, CommandResult } from '../types';
import { RouterDependencies } from '../router';

const HELP_TEXT = [
  '*Personal BC.Game Crash Automation*',
  '',
  'Single-operator bot. Default mode: `dry-run` (virtual ledger only).',
  'Real-money `live` mode requires `/login` + a two-step `/mode live` confirmation.',
  '',
  '*Status*',
  '`/status` — overall state (mode, session, balance, last round)',
  '`/balance` — current virtual ledger balance',
  '`/pnl` — daily P&L',
  '`/daily` — entries, wins/losses, drawdown',
  '`/entries` — recent virtual trades',
  '`/session` — current session info',
  '`/health` — DB, browser, workers status',
  '`/lastround` — most recent round',
  '`/analytics` — ACIE signal stats',
  '',
  '*Control*',
  '`/pause`, `/resume`, `/stop`, `/emergencystop`',
  '`/sheath`, `/unsheath` (auto-pause on drift)',
  '`/mode <observe-only|dry-run|live|maintenance>`',
  '`/config show` / `/config set <key> <value>` / `/config confirm <token>`',
  '',
  '*Live*',
  '`/login` — BC.Game email/password (one-shot; password is not stored)',
  '`/login_cancel` — abort the active login conversation',
  '',
  '_See `docs/architecture.md` and `docs/telegram-commands.md` for the full reference._',
].join('\n');

export function createStartHandlers(_deps: RouterDependencies): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();

  const reply = (text: string): CommandResult => ({
    success: true,
    message: text,
    parseMode: 'Markdown',
  });

  handlers.set('/start', async (): Promise<CommandResult> =>
    reply([
      '*Welcome to your BC.Game Crash bot*',
      '',
      'Mode: `dry-run` by default. The bot observes BC.Game, runs predictions, and simulates every signal against a virtual ledger. No real money moves until you explicitly switch to `live` mode.',
      '',
      'Quick start:',
      '  /status    — verify everything is green',
      '  /health    — DB / workers / Telegram bot status',
      '  /analytics — prediction signal stats',
      '  /menu      — full command list',
      '  /help      — usage tips',
    ].join('\n'))
  );

  handlers.set('/menu', async (): Promise<CommandResult> => reply(HELP_TEXT));
  handlers.set('/help', async (): Promise<CommandResult> => reply(HELP_TEXT));

  return handlers;
}
