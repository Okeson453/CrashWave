/**
 * Telegram Operator Interface — Config Commands
 *
 * /config show
 * /config set <key> <value>
 * /config confirm <token>
 */

import { CommandHandler, CommandResult, OperatorContext } from '../types';
import { RouterDependencies } from '../router';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

// In-memory pending confirmations (in production, use Redis with TTL)
const pendingConfirmations = new Map<string, { key: string; value: string; expiresAt: number }>();

const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONFIRMATION_TOKEN_LENGTH = 6;

export function createConfigHandlers(
  deps: RouterDependencies
): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();

  handlers.set('/config', async (ctx: OperatorContext, args: string[]): Promise<CommandResult> => {
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand || subcommand === 'show') {
      return handleConfigShow(deps);
    }

    if (subcommand === 'set') {
      return handleConfigSet(ctx, args.slice(1), deps);
    }

    if (subcommand === 'confirm') {
      return handleConfigConfirm(ctx, args.slice(1), deps);
    }

    return {
      success: false,
      message: [
        '⚙️ *Config Commands*',
        '',
        '`/config show` — Display current configuration',
        '`/config set <key> <value>` — Request a config change',
        '`/config confirm <token>` — Confirm a pending change',
      ].join('\n'),
      parseMode: 'MarkdownV2',
    };
  });

  return handlers;
}

async function handleConfigShow(deps: RouterDependencies): Promise<CommandResult> {
  // Get a few key config values for display
  const mode = deps.getConfigValue?.('mode') ?? 'unknown';
  const stake = deps.getConfigValue?.('stakePerEntry') ?? 'unknown';
  const target = deps.getConfigValue?.('cashOutTarget') ?? 'unknown';
  const maxEntries = deps.getConfigValue?.('maxDailyEntries') ?? 'unknown';

  const message = [
    '⚙️ *Current Configuration*',
    '',
    `*Mode:* \`${String(mode)}\``,
    `*Stake per Entry:* \`${String(stake)}\``,
    `*Cash Out Target:* \`${String(target)}x\``,
    `*Max Daily Entries:* \`${String(maxEntries)}\``,
    '',
    '_Use `/config set <key> <value>` to modify._',
  ].join('\n');

  return { success: true, message, parseMode: 'MarkdownV2' };
}

async function handleConfigSet(
  ctx: OperatorContext,
  args: string[],
  deps: RouterDependencies
): Promise<CommandResult> {
  if (args.length < 2) {
    return {
      success: false,
      message: '❌ *Usage:* `/config set <key> <value>`',
      parseMode: 'MarkdownV2',
    };
  }

  const key = args[0];
  const value = args.slice(1).join(' ');
  const operatorId = String(ctx.from?.id ?? 'unknown');

  // Validate key exists
  const currentValue = deps.getConfigValue?.(key);
  if (currentValue === undefined) {
    return {
      success: false,
      message: `❌ *Unknown Config Key*\n\n\`${escapeMarkdown(key)}\` is not a recognized configuration key.`,
      parseMode: 'MarkdownV2',
    };
  }

  // Generate confirmation token
  const token = generateToken();
  pendingConfirmations.set(token, {
    key,
    value,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  });

  // Clean up expired tokens
  cleanupExpiredTokens();

  logger.info(
    { component: 'ConfigCommand', operatorId, key, value, token },
    'Config change requested, awaiting confirmation'
  );

  const message = [
    '🔐 *Config Change Requested*',
    '',
    `*Key:* \`${escapeMarkdown(key)}\``,
    `*Current:* \`${String(currentValue)}\``,
    `*Proposed:* \`${escapeMarkdown(value)}\``,
    '',
    `To confirm, reply with:\n\`/config confirm ${token}\``,
    '',
    `_This request expires in ${CONFIRMATION_TTL_MS / 60000} minutes._`,
  ].join('\n');

  return { success: true, message, parseMode: 'MarkdownV2' };
}

async function handleConfigConfirm(
  ctx: OperatorContext,
  args: string[],
  deps: RouterDependencies
): Promise<CommandResult> {
  if (args.length === 0) {
    return {
      success: false,
      message: '❌ *Usage:* `/config confirm <token>`',
      parseMode: 'MarkdownV2',
    };
  }

  const token = args[0].toUpperCase();
  const pending = pendingConfirmations.get(token);

  if (!pending) {
    return {
      success: false,
      message: '❌ *Invalid or Expired Token*\n\nThe confirmation token was not found or has expired. Please request the change again.',
      parseMode: 'MarkdownV2',
    };
  }

  if (Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(token);
    return {
      success: false,
      message: '⏱ *Token Expired*\n\nThe confirmation window has closed. Please request the change again.',
      parseMode: 'MarkdownV2',
    };
  }

  const { key, value } = pending;
  const operatorId = String(ctx.from?.id ?? 'unknown');

  logger.info(
    { component: 'ConfigCommand', operatorId, key, value, token },
    'Config change confirmed, applying'
  );

  const success = await deps.setConfigValue?.(key, value) ?? false;
  pendingConfirmations.delete(token);

  if (success) {
    // Audit log entry
    logger.info(
      {
        component: 'ConfigCommand',
        operatorId,
        operatorUsername: ctx.from?.username,
        action: 'config_change',
        key,
        value,
        result: 'success',
      },
      'Operator config change applied'
    );

    return {
      success: true,
      message: `✅ *Config Updated*\n\n*Key:* \`${escapeMarkdown(key)}\`\n*New Value:* \`${escapeMarkdown(value)}\`\n\n_Change has been applied and logged._`,
      parseMode: 'MarkdownV2',
    };
  }

  logger.warn(
    { component: 'ConfigCommand', operatorId, key, value },
    'Config change confirmation failed to apply'
  );

  return {
    success: false,
    message: '⚠️ *Update Failed*\n\nThe configuration change could not be applied. Check logs for details.',
    parseMode: 'MarkdownV2',
  };
}

function generateToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let i = 0; i < CONFIRMATION_TOKEN_LENGTH; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [token, pending] of pendingConfirmations) {
    if (now > pending.expiresAt) {
      pendingConfirmations.delete(token);
    }
  }
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_');
}
