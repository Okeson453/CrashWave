/**
 * Telegram Operator Interface — Bot Gateway
 *
 * Telegraf bot initialization, webhook/polling setup, error handling,
 * and graceful shutdown. This is the entry point for all Telegram
 * operator interactions.
 */

import { Telegraf } from 'telegraf';
import { getLogger } from '../observability/logger';
import { getRedisClient } from '../persistence/redis-client';
import { TelegramBotConfig, OperatorContext, BotHealthStatus } from './types';
import { createAuthMiddleware } from './auth';
import { createRouter, CommandRouter, RouterDependencies } from './router';

const logger = getLogger();

export interface TelegramGatewayOptions {
  config: TelegramBotConfig;
}

export class TelegramGateway {
  private pollingLockRenewal: NodeJS.Timeout | null = null;
  private pollingLockKey = 'telegram:polling-lock';
  private holdsPollingLock = false;
  private bot: Telegraf<OperatorContext> | null = null;
  private readonly config: TelegramBotConfig;
  private health: BotHealthStatus;
  private startedAt: number = 0;
  private isRunning: boolean = false;
  private shutdownCallbacks: (() => Promise<void>)[] = [];
  private router: CommandRouter | null = null;
  private pendingDeps: RouterDependencies = {};

  constructor(options: TelegramGatewayOptions) {
    this.config = options.config;
    // Tenant resolution removed for personal use; single-operator bot.
    this.health = {
      connected: false,
      lastPingAt: null,
      messagesSent: 0,
      messagesDropped: 0,
      errors: 0,
      uptimeSeconds: 0,
    };
  }

  /** Inject runtime command dependencies (pause, sheath, etc.) */
  setRouterDependencies(deps: RouterDependencies): void {
    this.pendingDeps = { ...this.pendingDeps, ...deps };
    this.router?.setDependencies(this.pendingDeps);
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

      this.bot.use(
        createAuthMiddleware({
          adminUserIds: this.config.allowedUserIds ?? [],
          allowedUserIds: this.config.allowedUserIds,
          enforcePrivateChat: true,
        })
      );

      // Per-user command rate limit
      const maxPerMin = this.config.rateLimitMessagesPerMinute ?? 30;
      const userMsgCounts = new Map<number, { n: number; reset: number }>();
      this.bot.use(async (ctx, next) => {
        const uid = ctx.from?.id;
        if (uid == null) return next();
        const now = Date.now();
        let w = userMsgCounts.get(uid);
        if (!w || now > w.reset) {
          w = { n: 0, reset: now + 60_000 };
          userMsgCounts.set(uid, w);
        }
        w.n += 1;
        if (w.n > maxPerMin) {
          try {
            await ctx.reply('Rate limit exceeded. Try again in a minute.');
          } catch { /* */ }
          return;
        }
        return next();
      });

      const router = createRouter({
        verbosity: this.config.verbosity,
      });
      this.router = router;
      if (Object.keys(this.pendingDeps).length > 0) {
        router.setDependencies(this.pendingDeps);
      }
      this.bot.use(router.middleware());

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

        if (ctx.chat?.id) {
          ctx.reply('Internal Error. An unexpected error occurred. Try /status or /menu.').catch(() => {
            /* ignore */
          });
        }
      });

      this.bot.use((_ctx, next) => {
        this.health.lastPingAt = new Date().toISOString();
        return next();
      });

      // Restore official Telegram command menu (slash menu)
      try {
        await this.bot.telegram.setMyCommands([
          { command: 'start', description: 'Open operator menu' },
          { command: 'menu', description: 'Show main menu' },
          { command: 'help', description: 'List all commands' },
          { command: 'login', description: 'Connect BC.Game account' },
          { command: 'status', description: 'Operator dashboard' },
          { command: 'balance', description: 'Current balance' },
          { command: 'daily', description: 'Daily stats' },
          { command: 'session', description: 'Session summary' },
          { command: 'pnl', description: 'Profit and loss' },
          { command: 'entries', description: 'Recent entries' },
          { command: 'health', description: 'System health' },
          { command: 'lastround', description: 'Last round result' },
          { command: 'pause', description: 'Pause automation' },
          { command: 'resume', description: 'Resume automation' },
          { command: 'stop', description: 'Graceful stop' },
          { command: 'emergencystop', description: 'Emergency stop' },
          { command: 'mode', description: 'Show or set mode' },
          { command: 'sheath', description: 'Sheath (safe mode)' },
          { command: 'unsheath', description: 'Unsheath engine' },
          { command: 'config', description: 'View configuration' },
          { command: 'analytics', description: 'ACIE / signals' },
          { command: 'login_cancel', description: 'Cancel login flow' },
        ]);
        logger.info({ component: 'TelegramGateway' }, 'Telegram bot commands registered (setMyCommands)');
      } catch (err) {
        logger.warn(
          { component: 'TelegramGateway', error: err instanceof Error ? err.message : String(err) },
          'setMyCommands failed — slash menu may be empty; handlers still work'
        );
      }

      if (this.config.webhookUrl) {
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
        await this.launchPolling();
      }

      this.isRunning = true;
      this.startedAt = Date.now();
      this.health.connected = true;

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


  private async acquirePollingLock(lockKey: string, ttlMs: number): Promise<boolean> {
    try {
      const redis = getRedisClient();
      const token = `${process.pid}:${Date.now()}`;
      const result = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      this.holdsPollingLock = result === 'OK';
      return this.holdsPollingLock;
    } catch (err) {
      logger.warn(
        { component: 'TelegramGateway', error: err instanceof Error ? err.message : String(err) },
        'Polling lock unavailable — proceeding without distributed lock (single-instance only)'
      );
      this.holdsPollingLock = true;
      return true;
    }
  }

  private async renewPollingLock(lockKey: string, ttlMs: number): Promise<void> {
    if (!this.holdsPollingLock) return;
    try {
      const redis = getRedisClient();
      await redis.pexpire(lockKey, ttlMs);
    } catch {
      /* ignore */
    }
  }

  private async releasePollingLock(lockKey: string): Promise<void> {
    if (this.pollingLockRenewal) {
      clearInterval(this.pollingLockRenewal);
      this.pollingLockRenewal = null;
    }
    if (!this.holdsPollingLock) return;
    try {
      await getRedisClient().del(lockKey);
    } catch {
      /* ignore */
    }
    this.holdsPollingLock = false;
  }

  private async launchPolling(): Promise<void> {
    const lockKey = this.pollingLockKey;
    const lockTtlMs = 30_000;
    const gotLock = await this.acquirePollingLock(lockKey, lockTtlMs);
    if (!gotLock) {
      logger.warn(
        { component: 'TelegramGateway' },
        'Another instance already holds the Telegram polling lock — skipping launch here'
      );
      return;
    }
    this.pollingLockRenewal = setInterval(() => {
      void this.renewPollingLock(lockKey, lockTtlMs);
    }, lockTtlMs / 2);

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.bot!.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
        await this.bot!.launch();
        logger.info(
          { component: 'TelegramGateway', mode: 'polling', attempt },
          'Bot started in polling mode'
        );
        return;
      } catch (err) {
        const is409 = err instanceof Error && /409/.test(err.message);
        if (!is409 || attempt === maxAttempts) throw err;
        const backoffMs = Math.min(2000 * 2 ** (attempt - 1), 30_000);
        logger.warn(
          { component: 'TelegramGateway', attempt, backoffMs },
          '409 conflict on getUpdates — likely a stale poller from a previous deploy, retrying'
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.bot) {
      await this.releasePollingLock(this.pollingLockKey);
      return;
    }

    logger.info({ component: 'TelegramGateway' }, 'Stopping Telegram bot gateway');

    try {
      for (const cb of this.shutdownCallbacks) {
        await cb().catch(() => {});
      }

      this.bot.stop();
      this.isRunning = false;
      this.health.connected = false;
      await this.releasePollingLock(this.pollingLockKey);

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

  getHealth(): BotHealthStatus {
    return {
      ...this.health,
      uptimeSeconds: this.getUptimeSeconds(),
    };
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
