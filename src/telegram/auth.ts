/**
 * Telegram identity + tenant context middleware.
 *
 * TELEGRAM_ALLOWED_USER_IDS / allowedUserIds = platform administrators only.
 * Any valid Telegram private-chat user is an identity; tenant is resolved downstream.
 */

import { MiddlewareFn } from 'telegraf';
import { getLogger } from '../observability/logger';
import { OperatorContext } from './types';

const logger = getLogger();

export interface AuthOptions {
  /** Platform admin Telegram user IDs (privileged ops only — not a tenant gate) */
  adminUserIds: number[];
  enforcePrivateChat: boolean;
  /**
   * @deprecated Use adminUserIds. Kept for call-site compatibility.
   */
  allowedUserIds?: number[];
}

/**
 * Level 1: Telegram identity
 * - private chat only (optional)
 * - valid positive Telegram user id
 * - attach telegramUserId / chatId / isAdmin
 * Does NOT reject unknown users (tenant provisioning happens on /start).
 */
export function createAuthMiddleware(options: AuthOptions): MiddlewareFn<OperatorContext> {
  const adminIds = options.adminUserIds?.length
    ? options.adminUserIds
    : options.allowedUserIds ?? [];
  const adminSet = new Set(adminIds);

  if (adminSet.size === 0) {
    logger.info(
      { component: 'TelegramAuth' },
      'No admin user IDs configured — all users are tenants; no platform-admin privileges'
    );
  }

  return async (ctx, next) => {
    ctx.isAuthenticated = false;
    ctx.operatorId = 'anonymous';
    ctx.isAdmin = false;
    ctx.tenantId = undefined;
    ctx.telegramUserId = undefined;
    ctx.chatId = undefined;

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

    const user = ctx.from;
    if (!user) {
      await ctx.reply('❌ Unable to identify sender.', { parse_mode: 'Markdown' });
      return;
    }

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

    const chatId = ctx.chat?.id ?? user.id;
    ctx.isAuthenticated = true;
    ctx.operatorId = String(user.id);
    ctx.telegramUserId = user.id;
    ctx.chatId = chatId;
    ctx.isAdmin = adminSet.has(user.id);

    logger.debug(
      {
        component: 'TelegramAuth',
        telegramUserId: user.id,
        username: user.username,
        isAdmin: ctx.isAdmin,
      },
      'Telegram identity accepted'
    );

    return next();
  };
}

/** True if user is a platform administrator */
export function isAdmin(userId: number, adminUserIds: number[]): boolean {
  return Number.isInteger(userId) && userId > 0 && adminUserIds.includes(userId);
}

/** @deprecated Prefer isAdmin — allowlist is admin-only now */
export function isAuthorized(userId: number, allowedUserIds: number[]): boolean {
  return isAdmin(userId, allowedUserIds);
}

export function getOperatorIdentity(ctx: OperatorContext): {
  operatorId: string;
  username?: string;
  isAuthenticated: boolean;
  isAdmin?: boolean;
  tenantId?: string;
  telegramUserId?: number;
  chatId?: number;
} {
  return {
    operatorId: ctx.operatorId,
    username: ctx.from?.username,
    isAuthenticated: ctx.isAuthenticated,
    isAdmin: ctx.isAdmin,
    tenantId: ctx.tenantId,
    telegramUserId: ctx.telegramUserId,
    chatId: ctx.chatId,
  };
}

/**
 * Gate for admin-only operator commands (sheath, emergencystop, etc. when configured).
 */
export function requireAdmin(ctx: OperatorContext): boolean {
  return ctx.isAdmin === true;
}
