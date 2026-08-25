/**
 * Engine-process operator menu (TelegramGateway).
 * Uses shared keyboard builders from platform/telegram-menu.
 */

import type { Telegraf } from 'telegraf';
import {
  operatorEntitlements,
  operatorControlKeyboard,
  helpText,
  menuHeaderText,
  type MenuEntitlements,
} from '../platform/telegram-menu';
import type { OperatorContext } from './types';
import type { RouterDependencies } from './router';
import { getLogger } from '../observability/logger';

const logger = getLogger();

function navMenu() {
  return {
    inline_keyboard: [[{ text: '📋 Menu', callback_data: 'ui:menu' }]],
  };
}

export function buildOperatorEntitlements(deps: RouterDependencies, isAdmin: boolean): MenuEntitlements {
  const state = deps.getOrchestratorState?.() as Record<string, unknown> | undefined;
  const health = deps.getHealthStatus?.() as Record<string, unknown> | undefined;
  const running = Boolean(state?.running ?? state?.observing);
  const authenticated = Boolean(state?.authenticated ?? health?.authenticated);
  return operatorEntitlements({
    engineRunning: running,
    bcGameConnected: authenticated,
    isAdmin,
  });
}

export async function replyOperatorMenu(
  ctx: OperatorContext,
  deps: RouterDependencies
): Promise<void> {
  const ent = buildOperatorEntitlements(deps, !!ctx.isAdmin);
  await ctx.reply(menuHeaderText(null, ent), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: operatorControlKeyboard(ent) },
  });
}

/**
 * Register /menu /help /start and ui:* callbacks on the engine Telegraf bot.
 */
export function attachOperatorMenu(
  bot: Telegraf<OperatorContext>,
  getDeps: () => RouterDependencies
): void {
  bot.command('menu', async (ctx) => {
    await replyOperatorMenu(ctx, getDeps());
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🚀 *CrashWave Operator*\n\nEngine control surface. Use the menu or slash commands.',
      { parse_mode: 'Markdown' }
    );
    await replyOperatorMenu(ctx, getDeps());
  });

  bot.command('help', async (ctx) => {
    const ent = buildOperatorEntitlements(getDeps(), !!ctx.isAdmin);
    await ctx.reply(helpText(ent), {
      parse_mode: 'Markdown',
      reply_markup: navMenu(),
    });
  });

  bot.action(/^ui:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const deps = getDeps();
    await ctx.answerCbQuery().catch(() => undefined);

    try {
      switch (action) {
        case 'menu':
          await replyOperatorMenu(ctx, deps);
          break;
        case 'help': {
          const ent = buildOperatorEntitlements(deps, !!ctx.isAdmin);
          await ctx.reply(helpText(ent), { parse_mode: 'Markdown', reply_markup: navMenu() });
          break;
        }
        case 'status':
        case 'session':
        case 'health':
        case 'balance':
        case 'pnl': {
          const state = (deps.getOrchestratorState?.() ?? {}) as Record<string, unknown>;
          const health = (deps.getHealthStatus?.() ?? {}) as Record<string, unknown>;
          const lines = [
            '📊 *Operator status*',
            `Mode: ${state.mode ?? 'unknown'}`,
            `Running: ${state.running ? 'Yes' : 'No'}`,
            `Phase: ${state.phase ?? health.phase ?? '—'}`,
            `Authenticated: ${state.authenticated ?? health.authenticated ? 'Yes' : 'No'}`,
            `Session: ${state.sessionId ?? 'none'}`,
            `Rounds: ${state.roundsObserved ?? 0}`,
            `Errors: ${state.errors ?? 0}`,
          ];
          await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: navMenu() });
          break;
        }
        case 'login':
          await ctx.reply('🔐 Send /login then email and password (password is never stored).', {
            reply_markup: navMenu(),
          });
          break;
        case 'pause': {
          const ok = (await deps.pauseSystem?.('Operator menu pause')) ?? false;
          await ctx.reply(ok ? '⏸ Paused.' : '⚠️ Pause failed or not wired.', { reply_markup: navMenu() });
          break;
        }
        case 'resume':
        case 'startengine': {
          const ok = (await deps.resumeSystem?.()) ?? false;
          await ctx.reply(ok ? '▶️ Resumed / start requested.' : '⚠️ Resume failed or not wired.', {
            reply_markup: navMenu(),
          });
          break;
        }
        case 'stop': {
          const ok = (await deps.stopSystem?.()) ?? false;
          await ctx.reply(ok ? '⛔ Stop requested.' : '⚠️ Stop failed or not wired.', { reply_markup: navMenu() });
          break;
        }
        case 'sheath': {
          const ok = (await deps.sheathSystem?.()) ?? false;
          await ctx.reply(
            ok
              ? '🛡 Sheath active (betting suspended). /unsheath to recover.'
              : '⚠️ Sheath not wired. Use /sheath.',
            { reply_markup: navMenu() }
          );
          break;
        }
        case 'admin_menu':
          await ctx.reply(
            '🛡 Platform admin tools run on the *control-plane* bot (`/admin_menu`). This is the engine operator surface.',
            { parse_mode: 'Markdown', reply_markup: navMenu() }
          );
          break;
        default:
          await ctx.reply('Unknown action. Open /menu.', { reply_markup: navMenu() });
      }
    } catch (err) {
      logger.warn({ component: 'OperatorMenu', action, error: String(err) }, 'Operator menu action failed');
      await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
