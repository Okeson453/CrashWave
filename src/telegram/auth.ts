/**
 * Telegram Operator Interface — Authentication Middleware
 *
 * Allowlist-based authentication, private-chat enforcement,
 * and spoofed-ID rejection. All operator actions are gated here.
 */

import { MiddlewareFn } from 'telegraf';
import { getLogger } from '../observability/logger';
import { OperatorContext } from './types';

const logger = getLogger();

export interface AuthOptions {
  allowedUserIds: number[];
  enforcePrivateChat: boolean;
}

/**
 * Creates authentication middleware that:
 * 1. Rejects messages from group chats (if enforcePrivateChat)
 * 2. Rejects users not in the allowlist
 * 3. Rejects spoofed/forged IDs by validating the from.id
 * 4. Attaches operator context for downstream handlers
 */
export function createAuthMiddleware(options: AuthOptions): MiddlewareFn<OperatorContext> {
  const allowedSet = new Set(options.allowedUserIds);
  // P2.2: empty allowlist is fail-closed — no commands accepted
  if (allowedSet.size === 0) {
    logger.warn(
      { component: 'TelegramAuth' },
      'allowedUserIds is empty — all Telegram commands will be rejected (fail-closed)'
    );
  }

  return async (ctx, next) => {
    // Initialize operator context
    ctx.isAuthenticated = false;
    ctx.operatorId = 'anonymous';

    // ─── Private Chat Enforcement ────────────────────────────────────────────
    if (options.enforcePrivateChat) {
      const chatType = ctx.chat?.type;
      if (chatType !== 'private') {
        logger.warn(
          {
            component: 'TelegramAuth',
            chatId: ctx.chat?.id,
            chatType,
            userId: ctx.from?.id,
          },
          'Rejected command from non-private chat'
        );
        await ctx.reply('❌ *Access Denied*\n\nCommands are only accepted in private chats.', {
          parse_mode: 'Markdown',
        });
        return;
      }
    }

    // ─── User Validation ─────────────────────────────────────────────────────
    const user = ctx.from;
    if (!user) {
      logger.warn(
        { component: 'TelegramAuth' },
        'Rejected message with no user information'
      );
      await ctx.reply('❌ Unable to identify sender.', { parse_mode: 'Markdown' });
      return;
    }

    // ─── Spoofed ID Detection ────────────────────────────────────────────────
    // Validate that the user ID is a positive integer (Telegram IDs are always positive)
    if (!Number.isInteger(user.id) || user.id <= 0) {
      logger.error(
        { component: 'TelegramAuth', userId: user.id, username: user.username },
        'Rejected potentially spoofed user ID'
      );
      await ctx.reply('❌ *Authentication Failed*\n\nInvalid user identifier.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // ─── Allowlist Check ─────────────────────────────────────────────────────
    if (!allowedSet.has(user.id)) {
      logger.warn(
        {
          component: 'TelegramAuth',
          userId: user.id,
          username: user.username,
          allowlistSize: allowedSet.size,
        },
        'Rejected unauthorized user'
      );
      await ctx.reply(
        '❌ *Access Denied*\n\nYour account is not authorized to operate this system.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ─── Attach Operator Context ─────────────────────────────────────────────
    ctx.isAuthenticated = true;
    ctx.operatorId = String(user.id);

    logger.debug(
      {
        component: 'TelegramAuth',
        userId: user.id,
        username: user.username,
      },
      'Operator authenticated'
    );

    return next();
  };
}

/**
 * Standalone allowlist check for use outside middleware flow.
 */
export function isAuthorized(userId: number, allowedUserIds: number[]): boolean {
  return Number.isInteger(userId) && userId > 0 && allowedUserIds.includes(userId);
}

/**
 * Extracts a clean operator identity string for audit logging.
 */
export function getOperatorIdentity(ctx: OperatorContext): {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
} {
  const from = ctx.from;
  return {
    id: String(from?.id ?? 'unknown'),
    username: from?.username,
    firstName: from?.first_name,
    lastName: from?.last_name,
  };
}
