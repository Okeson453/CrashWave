/**
 * Telegram Operator Interface — Control Commands
 *
 * /pause, /resume, /stop, /emergencystop, /mode [observe|dryrun|live|maintenance]
 *
 * Live mode requires multi-step confirmation (P1.3):
 *   1. /mode live  → issues a confirmation token (short TTL)
 *   2. /mode confirm <token>  → activates live within the validity window
 */

import { CommandHandler, CommandResult, OperatorContext, OperatorSystemMode } from '../types';
import { RouterDependencies } from '../router';
import { getLogger } from '../../observability/logger';
import { randomBytes } from 'crypto';

const logger = getLogger();

const VALID_MODES: OperatorSystemMode[] = ['observe-only', 'dry-run', 'live', 'maintenance'];

const pendingLiveConfirmations = new Map<
  string,
  { token: string; expiresAt: number; requestedBy: number }
>();

const LIVE_CONFIRM_TTL_MS = 60_000;
const LIVE_CONFIRM_TOKEN_LENGTH = 8;

function generateToken(length: number): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length)
    .toUpperCase();
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_');
}

export function createControlHandlers(
  deps: RouterDependencies
): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();

  handlers.set('/pause', async (ctx: OperatorContext, args: string[]): Promise<CommandResult> => {
    const reason = args.join(' ').trim() || 'Operator requested pause';
    logger.info({ component: 'ControlCommand', userId: ctx.from?.id, reason }, 'Operator requested pause');
    const success = (await deps.pauseSystem?.(reason)) ?? false;
    if (success) {
      return {
        success: true,
        message: `⏸ *System Paused*\n\nReason: _${escapeMarkdown(reason)}_\n\nAll betting activity has been halted. Use /resume to continue.`,
        parseMode: 'MarkdownV2',
      };
    }
    return {
      success: false,
      message: '⚠️ *Pause Failed*\n\nUnable to pause the system. Check logs for details.',
      parseMode: 'MarkdownV2',
    };
  });

  handlers.set('/resume', async (ctx: OperatorContext): Promise<CommandResult> => {
    logger.info({ component: 'ControlCommand', userId: ctx.from?.id }, 'Operator requested resume');
    const success = (await deps.resumeSystem?.()) ?? false;
    if (success) {
      return {
        success: true,
        message: '▶️ *System Resumed*\n\nBetting activity will resume on the next round.',
        parseMode: 'MarkdownV2',
      };
    }
    return {
      success: false,
      message: '⚠️ *Resume Failed*\n\nUnable to resume the system. Check logs for details.',
      parseMode: 'MarkdownV2',
    };
  });

  handlers.set('/stop', async (ctx: OperatorContext, args: string[]): Promise<CommandResult> => {
    const reason = args.join(' ').trim() || 'Operator requested stop';
    logger.info({ component: 'ControlCommand', userId: ctx.from?.id, reason }, 'Operator requested stop');
    const success = (await deps.stopSystem?.()) ?? false;
    if (success) {
      return {
        success: true,
        message: `🛑 *System Stopped*\n\nReason: _${escapeMarkdown(reason)}_\n\nThe system has been gracefully stopped. Use /status to verify.`,
        parseMode: 'MarkdownV2',
      };
    }
    return {
      success: false,
      message: '⚠️ *Stop Failed*\n\nUnable to stop the system. Check logs for details.',
      parseMode: 'MarkdownV2',
    };
  });

  // V1.1 Sheath Mode commands
  handlers.set('/sheath', async (ctx: OperatorContext): Promise<CommandResult> => {
    logger.info({ component: 'ControlCommand', userId: ctx.from?.id }, 'Operator requested sheath');
    const success = (await deps.sheathSystem?.()) ?? false;
    if (success) {
      const snap = deps.getSheathState?.();
      return {
        success: true,
        message: `🛡️ *Sheath Mode Active*\n\nState: \`${escapeMarkdown(snap?.state ?? 'SHEATH_ACTIVE')}\`\nBetting suspended\\. Intelligence, monitoring, and learning continue\\.\n\nUse /unsheath to begin recovery validation\\.`,
        parseMode: 'MarkdownV2',
      };
    }
    return {
      success: false,
      message: '⚠️ *Sheath Failed*\n\nUnable to enter sheath mode\\.',
      parseMode: 'MarkdownV2',
    };
  });

  handlers.set('/unsheath', async (ctx: OperatorContext): Promise<CommandResult> => {
    logger.info({ component: 'ControlCommand', userId: ctx.from?.id }, 'Operator requested unsheath');
    const success = (await deps.unsheathSystem?.()) ?? false;
    if (success) {
      const snap = deps.getSheathState?.();
      return {
        success: true,
        message: `🔄 *Sheath Recovery Started*\n\nState: \`${escapeMarkdown(snap?.state ?? 'SHEATH_RECOVERING')}\`\nBetting remains suspended until recovery validation passes\\.`,
        parseMode: 'MarkdownV2',
      };
    }
    return {
      success: false,
      message: '⚠️ *Unsheath Failed*\n\nUnable to start recovery\\. Check current sheath state with /status\\.',
      parseMode: 'MarkdownV2',
    };
  });


  handlers.set('/emergencystop', async (ctx: OperatorContext, args: string[]): Promise<CommandResult> => {
    const reason = args.join(' ').trim() || 'EMERGENCY STOP triggered by operator';
    logger.warn({ component: 'ControlCommand', userId: ctx.from?.id, reason }, '!!! EMERGENCY STOP TRIGGERED !!!');
    pendingLiveConfirmations.clear();
    await deps.pauseSystem?.(reason).catch(() => {});
    const success = (await deps.stopSystem?.().catch(() => false)) ?? false;
    if (success) {
      return {
        success: true,
        message: `🚨 *EMERGENCY STOP ACTIVATED* 🚨\n\nReason: _${escapeMarkdown(reason)}_\n\nAll systems have been halted immediately. Manual intervention required to restart.`,
        parseMode: 'MarkdownV2',
      };
    }
    return {
      success: false,
      message: '🚨 *EMERGENCY STOP PARTIALLY FAILED* 🚨\n\nSome components may still be running. Check logs immediately and take manual action.',
      parseMode: 'MarkdownV2',
    };
  });

  handlers.set('/mode', async (ctx: OperatorContext, args: string[]): Promise<CommandResult> => {
    if (args.length === 0) {
      const currentMode =
        ((deps.getOrchestratorState?.() as Record<string, unknown> | undefined)?.mode as string) ??
        'unknown';
      return {
        success: true,
        message: [
          `🔧 *Current Mode: ${currentMode}*`,
          '',
          'Available modes:',
          '• `observe-only` — Watch only, no bets',
          '• `dry-run` — Simulate bets, no real money',
          '• `live` — Full live betting \\(requires confirmation\\)',
          '• `maintenance` — System maintenance mode',
          '',
          'Usage: `/mode <mode>`',
          'Live: `/mode live` then `/mode confirm <token>` within 60s',
        ].join('\n'),
        parseMode: 'MarkdownV2',
      };
    }

    const sub = args[0].toLowerCase();
    if (sub === 'confirm') {
      return handleLiveConfirm(ctx, args.slice(1), deps);
    }

    const modeMap: Record<string, OperatorSystemMode> = {
      observe: 'observe-only',
      dryrun: 'dry-run',
      dry: 'dry-run',
      live: 'live',
      maintenance: 'maintenance',
      maint: 'maintenance',
    };

    const mode =
      modeMap[sub] ??
      (VALID_MODES.includes(sub as OperatorSystemMode) ? (sub as OperatorSystemMode) : null);

    if (!mode) {
      return {
        success: false,
        message: `❌ *Invalid Mode*\n\n\`${escapeMarkdown(sub)}\` is not a valid mode.\n\nAvailable: observe-only, dry-run, live, maintenance`,
        parseMode: 'MarkdownV2',
      };
    }

    if (mode === 'live') {
      const operatorId = String(ctx.from?.id ?? ctx.operatorId ?? 'unknown');
      const token = generateToken(LIVE_CONFIRM_TOKEN_LENGTH);
      const expiresAt = Date.now() + LIVE_CONFIRM_TTL_MS;
      pendingLiveConfirmations.set(operatorId, {
        token,
        expiresAt,
        requestedBy: ctx.from?.id ?? 0,
      });
      logger.warn(
        {
          component: 'ControlCommand',
          userId: ctx.from?.id,
          action: 'live_mode_pending_confirmation',
          expiresAt: new Date(expiresAt).toISOString(),
        },
        'Live mode change requested — awaiting confirmation token'
      );
      return {
        success: true,
        message: [
          '🔴 *Live Mode Requires Confirmation*',
          '',
          'You requested *live* \\(real\\-money\\) mode\\.',
          '',
          `Confirmation token: \`${token}\``,
          `Valid for: *60 seconds*`,
          '',
          'To activate, send:',
          `\`/mode confirm ${token}\``,
          '',
          '_If you did not intend this, ignore this message\\. Token expires automatically\\._',
        ].join('\n'),
        parseMode: 'MarkdownV2',
      };
    }

    logger.info({ component: 'ControlCommand', userId: ctx.from?.id, mode }, 'Operator requested mode change');
    const success = (await deps.setSystemMode?.(mode)) ?? false;
    if (success) {
      const modeEmoji = mode === 'dry-run' ? '🟡' : mode === 'observe-only' ? '🔵' : '🔧';
      return {
        success: true,
        message: `${modeEmoji} *Mode Changed*\n\nSystem is now in *${mode}* mode.`,
        parseMode: 'MarkdownV2',
      };
    }
    return {
      success: false,
      message: '⚠️ *Mode Change Failed*\n\nUnable to change system mode. Check logs for details.',
      parseMode: 'MarkdownV2',
    };
  });

  return handlers;
}

async function handleLiveConfirm(
  ctx: OperatorContext,
  args: string[],
  deps: RouterDependencies
): Promise<CommandResult> {
  const operatorId = String(ctx.from?.id ?? ctx.operatorId ?? 'unknown');
  const provided = (args[0] ?? '').trim().toUpperCase();
  if (!provided) {
    return {
      success: false,
      message: '❌ *Missing Token*\n\nUsage: `/mode confirm <token>`',
      parseMode: 'MarkdownV2',
    };
  }
  const pending = pendingLiveConfirmations.get(operatorId);
  if (!pending) {
    logger.warn(
      { component: 'ControlCommand', userId: ctx.from?.id, action: 'live_confirm_no_pending' },
      'Live confirm attempted with no pending request'
    );
    return {
      success: false,
      message:
        '❌ *No Pending Live Request*\n\nRequest live mode first with `/mode live`, then confirm within 60 seconds\\.',
      parseMode: 'MarkdownV2',
    };
  }
  if (Date.now() > pending.expiresAt) {
    pendingLiveConfirmations.delete(operatorId);
    logger.warn(
      { component: 'ControlCommand', userId: ctx.from?.id, action: 'live_confirm_expired' },
      'Live confirm token expired'
    );
    return {
      success: false,
      message: '❌ *Token Expired*\n\nRequest a new token with `/mode live`\\.',
      parseMode: 'MarkdownV2',
    };
  }
  if (provided !== pending.token) {
    logger.warn(
      { component: 'ControlCommand', userId: ctx.from?.id, action: 'live_confirm_wrong_token' },
      'Live confirm wrong token'
    );
    return {
      success: false,
      message: '❌ *Invalid Token*\n\nToken does not match\\. Request a new one with `/mode live`\\.',
      parseMode: 'MarkdownV2',
    };
  }
  pendingLiveConfirmations.delete(operatorId);
  logger.warn(
    {
      component: 'ControlCommand',
      userId: ctx.from?.id,
      action: 'live_mode_confirmed',
      audit: true,
    },
    'CRITICAL AUDIT: Live mode activated after multi-step confirmation'
  );
  const success = (await deps.setSystemMode?.('live')) ?? false;
  if (success) {
    return {
      success: true,
      message: [
        '🔴 *LIVE MODE ACTIVATED*',
        '',
        'Real\\-money execution is now enabled\\.',
        '',
        '_All actions are audited\\. Use /emergencystop to halt immediately\\._',
      ].join('\n'),
      parseMode: 'MarkdownV2',
    };
  }
  return {
    success: false,
    message: '⚠️ *Live Mode Activation Failed*\n\nConfirmation was valid but mode change failed. Check logs.',
    parseMode: 'MarkdownV2',
  };
}

export function _clearPendingLiveConfirmations(): void {
  pendingLiveConfirmations.clear();
}

export function _pendingLiveConfirmationCount(): number {
  return pendingLiveConfirmations.size;
}
