/**
 * Telegram Operator Interface — Command Router
 *
 * Routes parsed commands to specific handlers, validates command syntax,
 * and enforces rate limiting per operator.
 */

import { MiddlewareFn } from 'telegraf';
import { getLogger } from '../observability/logger';
import {
  OperatorContext,
  ParsedCommand,
  CommandResult,
  CommandHandler,
  BotCommand,
} from './types';
import { createStatusHandlers } from './commands/status';
import { createControlHandlers } from './commands/control';
import { createConfigHandlers } from './commands/config';
import { createAnalyticsHandlers } from './commands/analytics';

const logger = getLogger();

export interface RouterOptions {
  verbosity: 'quiet' | 'normal' | 'verbose' | 'debug';
}

export interface RouterDependencies {
  // Injected at runtime via setter or constructor
  getOrchestratorState?: () => unknown;
  getLedgerSummary?: () => unknown;
  getHealthStatus?: () => unknown;
  setSystemMode?: (mode: string) => Promise<boolean>;
  pauseSystem?: (reason: string) => Promise<boolean>;
  resumeSystem?: () => Promise<boolean>;
  stopSystem?: () => Promise<boolean>;
  getConfigValue?: (key: string) => unknown;
  setConfigValue?: (key: string, value: string) => Promise<boolean>;
  /** Optional windowed analytics provider (amount, unit) e.g. (7, 'd') */
  getWindowedAnalytics?: (amount: number, unit: string) => unknown;
}

export class CommandRouter {
  private handlers: Map<string, CommandHandler> = new Map();
  private dependencies: RouterDependencies = {};
  private commandCounts: Map<number, { count: number; windowStart: number }> = new Map();
  private readonly rateLimitPerMinute: number = 30;

  constructor(_options: RouterOptions) {
    this.registerDefaultHandlers();
  }

  /**
   * Inject runtime dependencies for handlers that need them.
   */
  setDependencies(deps: RouterDependencies): void {
    this.dependencies = { ...this.dependencies, ...deps };
    this.rebuildHandlers();
  }

  /**
   * Get the Telegraf middleware for this router.
   */
  middleware(): MiddlewareFn<OperatorContext> {
    return async (ctx, next) => {
      // Only process text messages that look like commands
      const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
      if (!text || !text.startsWith('/')) {
        return next();
      }

      // Rate limit check
      const userId = ctx.from?.id;
      if (userId && !this.checkRateLimit(userId)) {
        logger.warn(
          { component: 'CommandRouter', userId },
          'Rate limit exceeded'
        );
        await ctx.reply(
          '⏱ *Rate Limited*\n\nToo many commands. Please slow down.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Parse command
      const parsed = this.parseCommand(text, ctx);
      if (!parsed) {
        await ctx.reply(
          '❓ *Unknown Command*\n\nUse /status to see available commands.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      ctx.command = parsed;

      logger.debug(
        {
          component: 'CommandRouter',
          userId: parsed.userId,
          command: parsed.command,
          args: parsed.args,
        },
        'Routing command'
      );

      // Find handler
      const handler = this.handlers.get(parsed.command);
      if (!handler) {
        await ctx.reply(
          `❓ Command *\`${parsed.command}\`* is not yet implemented.`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      // Execute handler
      try {
        const result = await handler(ctx, parsed.args);
        await this.sendResult(ctx, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          {
            component: 'CommandRouter',
            command: parsed.command,
            userId: parsed.userId,
            error: message,
          },
          'Command handler error'
        );
        await ctx.reply(
          `⚠️ *Error executing command*\n\n${this.escapeMarkdown(message)}`,
          { parse_mode: 'MarkdownV2' }
        );
      }
    };
  }

  /**
   * Register a custom handler.
   */
  register(command: string, handler: CommandHandler): void {
    this.handlers.set(command, handler);
  }

  private parseCommand(text: string, ctx: OperatorContext): ParsedCommand | null {
    // Extract command and args: /command@botname arg1 arg2
    const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@[\w_]+)?\s*(.*)$/);
    if (!match) return null;

    const commandName = match[1].toLowerCase();
    const argsText = match[2].trim();
    const args = argsText ? argsText.split(/\s+/) : [];

    const command = `/${commandName}` as BotCommand;

    // Validate it's a known command
    const knownCommands: string[] = [
      '/status', '/balance', '/daily', '/session', '/pnl', '/entries', '/health', '/lastround',
      '/pause', '/resume', '/stop', '/emergencystop', '/mode',
      '/config', '/analytics',
    ];
    if (!knownCommands.includes(command)) {
      return null;
    }

    const message = ctx.message && 'message_id' in ctx.message ? ctx.message : undefined;

    return {
      raw: text,
      command,
      args,
      userId: ctx.from?.id ?? 0,
      username: ctx.from?.username,
      chatId: ctx.chat?.id ?? 0,
      messageId: message?.message_id ?? 0,
      timestamp: Date.now(),
    };
  }

  private checkRateLimit(userId: number): boolean {
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    const entry = this.commandCounts.get(userId);

    if (!entry || now - entry.windowStart > windowMs) {
      this.commandCounts.set(userId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.rateLimitPerMinute) {
      return false;
    }

    entry.count++;
    return true;
  }

  private async sendResult(ctx: OperatorContext, result: CommandResult): Promise<void> {
    const options: Record<string, unknown> = {};
    if (result.parseMode) options.parse_mode = result.parseMode;
    if (result.replyToMessageId) options.reply_to_message_id = result.replyToMessageId;
    if (result.extra) Object.assign(options, result.extra);

    await ctx.reply(result.message, options);
  }

  private escapeMarkdown(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
  }

  private registerDefaultHandlers(): void {
    this.rebuildHandlers();
  }

  private rebuildHandlers(): void {
    this.handlers.clear();

    // Status commands
    const statusHandlers = createStatusHandlers(this.dependencies);
    statusHandlers.forEach((handler, command) => {
      this.handlers.set(command, handler);
    });

    // Control commands
    const controlHandlers = createControlHandlers(this.dependencies);
    controlHandlers.forEach((handler, command) => {
      this.handlers.set(command, handler);
    });

    // Config commands
    const configHandlers = createConfigHandlers(this.dependencies);
    configHandlers.forEach((handler, command) => {
      this.handlers.set(command, handler);
    });

    // Analytics commands
    const analyticsHandlers = createAnalyticsHandlers(this.dependencies);
    analyticsHandlers.forEach((handler, command) => {
      this.handlers.set(command, handler);
    });
  }
}

/**
 * Factory function to create and configure the router.
 */
export function createRouter(options: RouterOptions): CommandRouter {
  return new CommandRouter(options);
}


/** Handler factory for /reauth_complete — wire with ReauthProtocol from composition */
export function createReauthCompleteHandler(
  complete: () => Promise<{ ok: boolean; message: string }>
): (ctx: { reply: (text: string, extra?: object) => Promise<unknown> }) => Promise<void> {
  return async (ctx) => {
    const result = await complete();
    await ctx.reply(
      result.ok ? `✅ ${result.message}` : `⚠️ ${result.message}`,
      { parse_mode: 'Markdown' }
    );
  };
}
