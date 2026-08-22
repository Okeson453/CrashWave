/**
 * Telegram Operator Interface — Bot Gateway
 *
 * Telegraf bot initialization, webhook/polling setup, error handling,
 * and graceful shutdown. This is the entry point for all Telegram
 * operator interactions.
 */

import { Telegraf } from 'telegraf';
import { getLogger } from '../observability/logger';
import { TelegramBotConfig, OperatorContext, BotHealthStatus } from './types';
import { createAuthMiddleware } from './auth';
import { createRouter } from './router';

const logger = getLogger();

export interface TelegramGatewayOptions {
  config: TelegramBotConfig;
}

export class TelegramGateway {
  private bot: Telegraf<OperatorContext> | null = null;
  private readonly config: TelegramBotConfig;
  private health: BotHealthStatus;
  private startedAt: number = 0;
  private isRunning: boolean = false;
  private shutdownCallbacks: (() => Promise<void>)[] = [];

  constructor(options: TelegramGatewayOptions) {
    this.config = options.config;
    this.health = {
      connected: false,
      lastPingAt: null,
      messagesSent: 0,
      messagesDropped: 0,
      errors: 0,
      uptimeSeconds: 0,
    };
  }

  /**
   * Initialize and start the bot (webhook or polling).
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn({ component: 'TelegramGateway' }, 'Bot already running');
      return;
    }

    logger.info({ component: 'TelegramGateway' }, 'Starting Telegram bot gateway');

    try {
      this.bot = new Telegraf<OperatorContext>(this.config.botToken);

      // Attach auth middleware first
      this.bot.use(createAuthMiddleware({
        allowedUserIds: this.config.allowedUserIds,
        enforcePrivateChat: true,
      }));

      // Attach command router
      const router = createRouter({
        verbosity: this.config.verbosity,
      });
      this.bot.use(router.middleware());

      // Global error handler
      this.bot.catch((err: unknown, ctx: OperatorContext) => {
        this.health.errors++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          {
            component: 'TelegramGateway',
            error: errorMsg,
            userId: ctx.from?.id,
            updateType: ctx.updateType,
          },
          'Bot error handler triggered'
        );

        // Notify operator of critical errors
        if (ctx.chat?.id) {
          ctx.reply('⚠️ *Internal Error*\n\nAn unexpected error occurred. The team has been notified.', {
            parse_mode: 'Markdown',
          }).catch(() => {
            // Silently fail if we can't send error message
          });
        }
      });

      // Health ping
      this.bot.use((_ctx, next) => {
        this.health.lastPingAt = new Date().toISOString();
        return next();
      });

      // Start bot
      if (this.config.webhookUrl) {
        // Webhook mode
        const webhookPath = new URL(this.config.webhookUrl).pathname;
        await this.bot.launch({
          webhook: {
            domain: new URL(this.config.webhookUrl).hostname,
            port: parseInt(new URL(this.config.webhookUrl).port || '443', 10),
            hookPath: webhookPath,
          },
        });
        logger.info(
          { component: 'TelegramGateway', mode: 'webhook', url: this.config.webhookUrl },
          'Bot started in webhook mode'
        );
      } else {
        // Polling mode (default)
        await this.bot.launch();
        logger.info(
          { component: 'TelegramGateway', mode: 'polling' },
          'Bot started in polling mode'
        );
      }

      this.isRunning = true;
      this.startedAt = Date.now();
      this.health.connected = true;

      // Graceful shutdown
      const shutdownHandler = async () => {
        await this.stop();
      };
      process.once('SIGINT', shutdownHandler);
      process.once('SIGTERM', shutdownHandler);
      this.shutdownCallbacks.push(async () => {
        process.off('SIGINT', shutdownHandler);
        process.off('SIGTERM', shutdownHandler);
      });

      logger.info({ component: 'TelegramGateway' }, 'Telegram bot gateway started successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ component: 'TelegramGateway', error: message }, 'Failed to start bot');
      this.health.errors++;
      throw new Error(`TelegramGateway start failed: ${message}`);
    }
  }

  /**
   * Gracefully stop the bot.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.bot) {
      return;
    }

    logger.info({ component: 'TelegramGateway' }, 'Stopping Telegram bot gateway');

    try {
      // Run shutdown callbacks
      for (const cb of this.shutdownCallbacks) {
        await cb().catch(() => {});
      }

      this.bot.stop();
      this.isRunning = false;
      this.health.connected = false;

      logger.info(
        {
          component: 'TelegramGateway',
          messagesSent: this.health.messagesSent,
          errors: this.health.errors,
          uptimeSeconds: this.getUptimeSeconds(),
        },
        'Telegram bot gateway stopped'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ component: 'TelegramGateway', error: message }, 'Error stopping bot');
    }
  }

  /**
   * Send a raw message to a specific chat.
   */
  async sendMessage(chatId: number, text: string, extra?: Record<string, unknown>): Promise<void> {
    if (!this.bot || !this.isRunning) {
      this.health.messagesDropped++;
      throw new Error('Bot not running');
    }

    try {
      await this.bot.telegram.sendMessage(chatId, text, extra);
      this.health.messagesSent++;
    } catch (error) {
      this.health.errors++;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { component: 'TelegramGateway', chatId, error: message },
        'Failed to send message'
      );
      throw error;
    }
  }

  /**
   * Get current health status.
   */
  getHealth(): BotHealthStatus {
    return {
      ...this.health,
      uptimeSeconds: this.getUptimeSeconds(),
    };
  }

  /**
   * Check if bot is running.
   */
  running(): boolean {
    return this.isRunning;
  }

  /**
   * Get the underlying Telegraf instance (for advanced use).
   */
  getBot(): Telegraf<OperatorContext> | null {
    return this.bot;
  }

  private getUptimeSeconds(): number {
    if (!this.startedAt) return 0;
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }
}
