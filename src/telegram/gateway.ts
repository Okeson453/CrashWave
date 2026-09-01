/**
 * Simplified Telegram gateway for personal-use: remove Redis polling lock and tenant middleware
 * and keep a lightweight Telegraf wrapper. Rate-limiting is left to the router middleware.
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

  async start(): Promise<void> {
    if (this.isRunning) return;
    logger.info({ component: 'TelegramGateway' }, 'Starting Telegram bot gateway (personal)');

    this.bot = new Telegraf<OperatorContext>(this.config.botToken);

    // Attach auth middleware (allowlist enforced)
    this.bot.use(createAuthMiddleware({
      allowedUserIds: this.config.allowedUserIds || [],
      enforcePrivateChat: true,
    }));

    // Attach router
    const router = createRouter({ verbosity: this.config.verbosity });
    this.bot.use(router.middleware());

    // Error handling
    this.bot.catch((err: unknown, ctx: OperatorContext) => {
      this.health.errors++;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ component: 'TelegramGateway', error: message, userId: ctx.from?.id }, 'Telegram error');
    });

    // Health ping
    this.bot.use((_ctx, next) => {
      this.health.lastPingAt = new Date().toISOString();
      return next();
    });

    // Launch (polling by default)
    await this.bot.launch();
    this.isRunning = true;
    this.startedAt = Date.now();
    this.health.connected = true;

    logger.info({ component: 'TelegramGateway' }, 'Telegram bot started (polling)');
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.bot) return;
    logger.info({ component: 'TelegramGateway' }, 'Stopping Telegram bot gateway');
    try {
      this.bot.stop();
    } catch (e) {
      logger.warn({ component: 'TelegramGateway', error: String(e) }, 'Error on bot.stop()');
    }
    this.isRunning = false;
    this.health.connected = false;
  }

  async sendMessage(chatId: number, text: string, extra?: Record<string, unknown>): Promise<void> {
    if (!this.bot || !this.isRunning) {
      this.health.messagesDropped++;
      throw new Error('Bot not running');
    }
    try {
      await this.bot.telegram.sendMessage(chatId, text, extra);
      this.health.messagesSent++;
    } catch (err) {
      this.health.errors++;
      logger.error({ component: 'TelegramGateway', error: String(err) }, 'sendMessage failed');
      throw err;
    }
  }

  getHealth(): BotHealthStatus {
    return { ...this.health, uptimeSeconds: this.getUptimeSeconds() };
  }

  running(): boolean {
    return this.isRunning;
  }

  getBot(): Telegraf<OperatorContext> | null {
    return this.bot;
  }

  private getUptimeSeconds(): number {
    if (!this.startedAt) return 0;
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }
}
