/**
 * Telegram Operator Interface — Config Commands
 *
 * /config show
 * /config set <key> <value>
 * /config confirm <token>
 */

import { randomBytes } from 'crypto';
import { CommandHandler, CommandResult, OperatorContext } from '../types';
import { RouterDependencies } from '../router';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

// In-memory pending confirmations (production should use Redis with TTL)
// Bound to operator identity + intended key/value + expiry + one-time nonce
interface PendingConfigConfirmation {
  key: string;
  value: string;
  operatorId: string;
  expiresAt: number;
  nonce: string;
}
const pendingConfirmations = new Map<string, PendingConfigConfirmation>();

const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONFIRMATION_TOKEN_LENGTH = 8;

/** Keys whose values must never be logged in plaintext */
const SECRET_CONFIG_KEYS = new Set([
  'password', 'secret', 'token', 'api_key', 'apikey', 'private_key',
  'bcgame_password', 'bcgame_2fa_secret', 'tenant_master_key',
  'paystack_secret', 'stripe_secret', 'encryption_key',
]);

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_CONFIG_KEYS.has(k) || k.includes('password') || k.includes('secret') || k.includes('token') || k.includes('key');
}

function redactValue(key: string, value: string): string {
  return isSecretKey(key) ? '[REDACTED]' : value;
}

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

  // Generate cryptographically random confirmation token bound to operator
  const token = generateToken();
  const nonce = randomBytes(16).toString('hex');
  pendingConfirmations.set(token, {
    key,
    value,
    operatorId,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    nonce,
  });

  // Clean up expired tokens
  cleanupExpiredTokens();

  logger.info(
    { component: 'ConfigCommand', operatorId, key, value: redactValue(key, value), tokenPresent: true },
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
  const operatorId = String(ctx.from?.id ?? 'unknown');

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

  // Bind confirmation to the requesting operator
  if (pending.operatorId !== operatorId) {
    logger.warn(
      { component: 'ConfigCommand', operatorId, expectedOperator: pending.operatorId },
      'Config confirm rejected — operator mismatch'
    );
    return {
      success: false,
      message: '🚫 *Unauthorized*\n\nThis confirmation token belongs to a different operator.',
      parseMode: 'MarkdownV2',
    };
  }

  const { key, value } = pending;

  logger.info(
    { component: 'ConfigCommand', operatorId, key, value: redactValue(key, value), tokenPresent: true },
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
        value: redactValue(key, value),
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
  // Cryptographically secure token (not Math.random)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(CONFIRMATION_TOKEN_LENGTH);
  let token = '';
  for (let i = 0; i < CONFIRMATION_TOKEN_LENGTH; i++) {
    token += chars.charAt(bytes[i]! % chars.length);
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
