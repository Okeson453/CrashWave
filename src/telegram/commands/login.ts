/**
 * /login — secure multi-step BC.Game authentication via Telegram.
 * Password never logged, never stored; deleted from chat when possible.
 */

import { getLogger } from '../../observability/logger';
import {
  beginLoginConversation,
  endLoginConversation,
  getLoginConversation,
  setLoginEmail,
  markAuthenticating,
  maskEmail,
} from '../../security/ephemeral-login';
import type { CommandHandler, CommandResult, OperatorContext } from '../types';
import type { RouterDependencies } from '../router';

const logger = getLogger();

export function createLoginHandlers(deps: RouterDependencies): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();

  handlers.set('/login', async (ctx: OperatorContext): Promise<CommandResult> => {
    const chatId = ctx.chat?.id;
    if (chatId == null) {
      return { success: false, message: 'Unable to resolve chat.' };
    }

    // Cancel any prior flow
    endLoginConversation(chatId);
    beginLoginConversation(chatId);

    return {
      success: true,
      message: [
        '🔐 *BC\\.Game Login*',
        '',
        'Credentials are used *once* to sign in inside the secure browser session\\.',
        'The password is *never* stored in the database, Redis, logs, or config\\.',
        '',
        'Enter your BC\\.Game *email* or *phone*:',
      ].join('\n'),
      parseMode: 'MarkdownV2',
    };
  });

  handlers.set('/login_cancel', async (ctx: OperatorContext): Promise<CommandResult> => {
    const chatId = ctx.chat?.id;
    if (chatId != null) endLoginConversation(chatId);
    return {
      success: true,
      message: 'Login cancelled\\. No credentials retained\\.',
      parseMode: 'MarkdownV2',
    };
  });

  // Re-export for middleware: handle conversation replies
  void deps;
  void logger;
  return handlers;
}

/**
 * Process non-command text while a /login conversation is active.
 * Returns true if the message was consumed by the login flow.
 */
export async function handleLoginConversationText(
  ctx: OperatorContext,
  text: string,
  deps: RouterDependencies
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return false;

  const conv = getLoginConversation(chatId);
  if (!conv || conv.step === 'idle' || conv.step === 'authenticating') {
    return false;
  }

  // Delete user message ASAP (best-effort) — especially password
  const msgId = ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : undefined;
  if (msgId != null) {
    try {
      await ctx.deleteMessage(msgId);
    } catch {
      /* bot may lack delete permission */
    }
  }

  if (conv.step === 'awaiting_email') {
    const email = text.trim();
    if (!email || email.length < 3) {
      await ctx.reply('Please enter a valid email or phone.');
      return true;
    }
    setLoginEmail(chatId, email);
    await ctx.reply(
      'Enter your BC.Game password:\n\n(Your message will be deleted when possible. Use /login_cancel to abort.)'
    );
    return true;
  }

  if (conv.step === 'awaiting_password') {
    const password = text;
    const email = conv.email ?? '';
    markAuthenticating(chatId);

    await ctx.reply('🔄 Authenticating with BC.Game…');

    let result: {
      ok: boolean;
      authenticated: boolean;
      regionBlocked?: boolean;
      detail?: string;
      maskedEmail?: string;
      gameLoaded?: boolean;
      observing?: boolean;
    };

    try {
      const runtime = deps.resolveRuntime ? await deps.resolveRuntime(ctx) : null;
      if (runtime) {
        result = await runtime.authenticate({ email, password });
      } else if (deps.loginWithCredentials) {
        result = await deps.loginWithCredentials(email, password, ctx);
      } else {
        endLoginConversation(chatId);
        await ctx.reply(
          '❌ Login service unavailable (TenantRuntime / supervisor not wired in composition).'
        );
        return true;
      }
    } finally {
      endLoginConversation(chatId);
    }

    if (result.regionBlocked) {
      await ctx.reply('🚫 BC.Game is not available in this region (REGION_BLOCKED).');
      return true;
    }

    if (result.ok && result.authenticated) {
      const account = result.maskedEmail ?? maskEmail(email);
      await ctx.reply(
        [
          '✅ *BC.Game authenticated*',
          `Account: \`${account}\``,
          `Session: AUTHENTICATED`,
          `Game: ${result.gameLoaded ? 'Ready' : 'Loading'}`,
          `Observer: ${result.observing ? 'Starting' : 'Pending'}`,
          '',
          'Use /status to verify the engine.',
        ].join('\n'),
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    await ctx.reply(
      `❌ Authentication failed${result.detail ? ` (${result.detail})` : ''}.\nTry /login again, or complete CAPTCHA/2FA in the browser if shown.`
    );
    return true;
  }

  return false;
}
