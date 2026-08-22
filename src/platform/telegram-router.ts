/**
 * TenantRouterBot — production multi-tenant Telegram control surface.
 * - Routes by chat_id → tenant
 * - Plan selection, status, pause/resume/mode
 * - Credential collection with message auto-delete
 * - Admin commands gated by ADMIN_TELEGRAM_ID
 */

import { Telegraf, Context } from 'telegraf';
import { getLogger } from '../observability/logger.js';
import { TenantManager } from './tenant-manager.js';
import { TenantSecretVault } from './secret-vault.js';
import { ContainerOrchestrator } from './container-orchestrator.js';
import { SubscriptionService } from './billing/subscription-service.js';
import { VirtualAccountService } from './payments/virtual-account-service.js';
import { TermsAndConditionsService } from './terms/terms-service.js';
import { StakeConfigurationService } from './stake/stake-config-service.js';
import { DailyBillingService } from './billing/daily-billing-service.js';
import { Tenant } from './types.js';
import { PerformanceMonitor } from './admin/performance-monitor.js';

interface TenantBotContext extends Context {
  state: {
    user?: Tenant | null;
    isAdmin?: boolean;
  };
}

type CredStep = 'username' | 'password' | 'totp' | null;

interface CredSession {
  step: CredStep;
  username?: string;
  password?: string;
}

export class TenantRouterBot {
  private readonly bot: Telegraf<TenantBotContext>;
  private readonly logger = getLogger();
  private readonly tenants = new TenantManager();
  private readonly vault = new TenantSecretVault();
  private readonly orchestrator: ContainerOrchestrator;
  private readonly adminTelegramId: bigint;
  private readonly credSessions = new Map<number, CredSession>();
  private readonly vaService: VirtualAccountService;
  private readonly termsService = new TermsAndConditionsService();
  private readonly stakeService = new StakeConfigurationService();
  private readonly dailyBilling = new DailyBillingService();
  private readonly performance = new PerformanceMonitor();

  constructor(botToken: string, orchestrator: ContainerOrchestrator) {
    this.bot = new Telegraf<TenantBotContext>(botToken);
    this.orchestrator = orchestrator;
    this.adminTelegramId = BigInt(process.env.ADMIN_TELEGRAM_ID ?? '0');
    this.vaService = new VirtualAccountService();
    const notify = async (telegramId: bigint, message: string) => {
      await this.bot.telegram.sendMessage(Number(telegramId), message, {
        parse_mode: 'Markdown',
      });
    };
    this.vaService.setNotify(notify);
    this.dailyBilling.setNotify(notify);
    this.setupMiddleware();
    this.setupUserCommands();
    this.setupTermsAndStakeCommands();
    this.setupExtraUserCommands();
    this.setupAdminCommands();
    this.setupCredentialFlow();
  }

  private setupMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId == null) return;

      if (this.adminTelegramId !== 0n && BigInt(chatId) === this.adminTelegramId) {
        ctx.state.isAdmin = true;
        // Admin can still be a tenant
        ctx.state.user = await this.tenants.getUserByTelegramId(BigInt(chatId));
        return next();
      }

      const user = await this.tenants.getUserByTelegramId(BigInt(chatId));
      const text =
        ctx.message && 'text' in ctx.message ? String(ctx.message.text ?? '') : '';

      if (!user) {
        if (text.startsWith('/start') || text.startsWith('/subscribe')) {
          return next();
        }
        await ctx.reply("You don't have an account. Use /start to register.");
        return;
      }

      if (user.status === 'suspended' || user.status === 'banned') {
        await ctx.reply('⛔ Your account is suspended. Contact support.');
        return;
      }

      ctx.state.user = user;

      const cbData =
        ctx.callbackQuery && 'data' in ctx.callbackQuery
          ? String(ctx.callbackQuery.data)
          : '';
      const msgText =
        ctx.message && 'text' in ctx.message ? String(ctx.message.text ?? '') : '';
      const termsExempt =
        cbData.startsWith('accept_terms') ||
        cbData === 'decline_terms' ||
        msgText.startsWith('/start');
      if (!termsExempt) {
        const accepted = await this.termsService.hasUserAcceptedTerms(user.id);
        if (!accepted) {
          const active = await this.termsService.getActiveTerms();
          if (active) {
            await ctx.reply(
              `📜 *Terms & Conditions*\n\nVersion: ${active.version}\n\n${active.content.slice(0, 3500)}\n\nYou *must* accept to continue.`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '✅ I Accept Terms & Conditions', callback_data: `accept_terms:${active.version}` }],
                    [{ text: '❌ Decline', callback_data: 'decline_terms' }],
                  ],
                },
              }
            );
            return;
          }
        }
      }

      await next();
    });
  }

  private setupUserCommands(): void {
    this.bot.command('start', async (ctx) => {
      const chatId = BigInt(ctx.chat!.id);
      let user = await this.tenants.getUserByTelegramId(chatId);
      if (!user) {
        const plans = await this.tenants.listActivePlans();
        const keyboard = plans.map((p) => [
          {
            text: `${p.name} — $${p.priceMonthly}/mo`,
            callback_data: `plan:${p.id}`,
          },
        ]);
        await ctx.reply(
          'Welcome to BC.Game Crash Automation.\nChoose a plan to get started:',
          { reply_markup: { inline_keyboard: keyboard } }
        );
        return;
      }
      await ctx.reply(
        `Welcome back (@${user.telegramUsername ?? 'user'}).\nStatus: *${user.status}*\nCommands: /status /setup_creds /pause /resume /mode /subscribe`,
        { parse_mode: 'Markdown' }
      );
    });


    this.bot.action(/plan:(.+)/, async (ctx) => {
      const planId = ctx.match[1];
      const chatId = BigInt(ctx.chat!.id);
      let user = await this.tenants.getUserByTelegramId(chatId);
      if (!user) {
        user = await this.tenants.createUser({
          telegramId: chatId,
          telegramUsername: ctx.from?.username,
        });
      }
      await this.tenants.assignPlan(user.id, planId);
      await this.tenants.updateUserStatus(user.id, 'onboarding');
      await this.tenants.audit({
        actorType: 'user',
        actorId: user.id,
        action: 'plan.selected',
        targetUserId: user.id,
        payload: { planId },
      });

      const plan = await this.tenants.getPlan(planId);
      if (!plan) {
        await ctx.reply('Plan not found.');
        await ctx.answerCbQuery();
        return;
      }

      if (plan.priceMonthly === 0) {
        const subs = new SubscriptionService();
        await subs.activate({ userId: user.id, planId });
        await ctx.reply(
          `*${plan.name}* activated (free).
Next: /setup_creds for BC.Game credentials (optional for observe-only).`,
          { parse_mode: 'Markdown' }
        );
        await ctx.answerCbQuery();
        return;
      }

      const amountLabel = `₦${Number(plan.priceMonthly).toLocaleString()}`;
      await ctx.reply(
        `You selected *${plan.name}* — ${amountLabel}/mo

How would you like to pay?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🏦 Bank Transfer (Virtual Account)',
                  callback_data: `pay:virtual:${planId}`,
                },
              ],
              [
                {
                  text: '📱 Manual Transfer + Admin Verify',
                  callback_data: `pay:manual:${planId}`,
                },
              ],
            ],
          },
        }
      );
      await ctx.answerCbQuery();
    });

    this.bot.action(/pay:virtual:(.+)/, async (ctx) => {
      const planId = ctx.match[1];
      const chatId = BigInt(ctx.chat!.id);
      const user = await this.tenants.getUserByTelegramId(chatId);
      if (!user) {
        await ctx.answerCbQuery('Register with /start first');
        return;
      }
      const plan = await this.tenants.getPlan(planId);
      if (!plan) {
        await ctx.answerCbQuery('Plan not found');
        return;
      }
      await this.tenants.assignPlan(user.id, planId);
      await ctx.answerCbQuery('Generating virtual account...');
      try {
        const va = await this.vaService.createVirtualAccountForUser(user.id, plan);
        const amountLabel = `₦${Number(plan.priceMonthly).toLocaleString()}`;
        await ctx.editMessageText(
          `🏦 *Your Virtual Account*

` +
            `Bank: *${va.bankName}*
` +
            `Account Number: \`${va.accountNumber}\`
` +
            `Account Name: ${va.accountName}

` +
            `Amount: *${amountLabel}*

` +
            `Transfer exactly ${amountLabel} to this account.
` +
            `Your plan activates automatically when payment is detected (usually 1–5 minutes).
` +
            `Save this account — it is permanent for renewals.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ I've Made the Transfer", callback_data: 'check_payment' }],
                [{ text: '🔄 Show Account Again', callback_data: `pay:virtual:${planId}` }],
              ],
            },
          }
        );
      } catch (err) {
        this.logger.error(
          { component: 'TenantRouterBot', error: String(err), userId: user.id },
          'Virtual account creation failed'
        );
        await ctx.reply(
          '❌ Could not generate virtual account. Ensure PAYSTACK_SECRET_KEY is set, or use Manual Transfer.'
        );
      }
    });

    this.bot.action(/pay:manual:(.+)/, async (ctx) => {
      const planId = ctx.match[1];
      const plan = await this.tenants.getPlan(planId);
      if (!plan) return;
      const chatId = BigInt(ctx.chat!.id);
      const user = await this.tenants.getUserByTelegramId(chatId);
      if (user) await this.tenants.assignPlan(user.id, planId);

      const bank = process.env.MANUAL_PAY_BANK_NAME ?? 'Titan Trust Bank';
      const acct = process.env.MANUAL_PAY_ACCOUNT_NUMBER ?? '0000000000';
      const name = process.env.MANUAL_PAY_ACCOUNT_NAME ?? 'Platform Settlements';
      const amountLabel = `₦${Number(plan.priceMonthly).toLocaleString()}`;

      if (user) {
        await this.vaService.createPendingTransaction(
          user.id,
          plan.priceMonthly,
          `manual-${user.id}-${Date.now()}`
        );
      }

      await ctx.editMessageText(
        `📱 *Manual Bank Transfer*

` +
          `Transfer *${amountLabel}* to:

` +
          `Bank: *${bank}*
` +
          `Account: \`${acct}\`
` +
          `Name: *${name}*

` +
          `After transfer, wait for admin verification or tap check below.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Check Status', callback_data: 'check_payment' }],
            ],
          },
        }
      );
      await ctx.answerCbQuery();
    });

    this.bot.action('check_payment', async (ctx) => {
      const chatId = BigInt(ctx.chat!.id);
      const user = await this.tenants.getUserByTelegramId(chatId);
      if (!user) {
        await ctx.answerCbQuery('Not registered');
        return;
      }
      const active = await this.vaService.hasActiveSubscription(user.id);
      if (active) {
        await ctx.editMessageText(
          `✅ *Payment Confirmed!*

Your subscription is active.
Send /setup_creds to enter BC.Game credentials.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.answerCbQuery('Payment not detected yet. Wait 1–5 minutes after transfer.');
      }
    });


    this.bot.command('status', async (ctx) => {
      const user = ctx.state.user;
      if (!user) {
        await ctx.reply('Not registered. Use /start.');
        return;
      }
      const instance = await this.tenants.getInstance(user.id);
      const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
      const lines = [
        '📊 Engine Status',
        `Plan: ${plan?.name ?? 'None'}`,
        `Account: ${user.status}`,
        `Engine: ${instance?.status ?? 'Not provisioned'}`,
        `Mode: ${instance?.mode ?? '—'}`,
        `Daily: ${instance?.dailyEntriesUsed ?? 0}/${plan?.maxDailyEntries ?? 0}`,
        `P&L today: ${instance?.pnlToday ?? 0}`,
        `Last heartbeat: ${instance?.lastHeartbeat ?? '—'}`,
      ];
      await ctx.reply(lines.join('\n'));
    });

    this.bot.command('pause', async (ctx) => {
      const user = ctx.state.user;
      if (!user) return;
      await this.orchestrator.pause(user.id);
      await ctx.reply('⏸️ Engine paused. /resume to continue.');
    });

    this.bot.command('resume', async (ctx) => {
      const user = ctx.state.user;
      if (!user) return;
      await this.orchestrator.resume(user.id);
      await ctx.reply('▶️ Engine resumed.');
    });

    this.bot.command('mode', async (ctx) => {
      const user = ctx.state.user;
      if (!user) return;
      const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const requested = text.split(/\s+/)[1];
      if (!requested) {
        const instance = await this.tenants.getInstance(user.id);
        await ctx.reply(
          `Current: ${instance?.mode ?? '—'}\nUsage: /mode <observe-only|dry-run|live>`
        );
        return;
      }
      if (!plan?.allowedModes.includes(requested)) {
        await ctx.reply(`❌ Mode '${requested}' not allowed on ${plan?.name ?? 'your'} plan.`);
        return;
      }
      await this.tenants.updateInstance(user.id, { mode: requested });
      await ctx.reply(`✅ Mode set to *${requested}*`, { parse_mode: 'Markdown' });
    });

    this.bot.command('subscribe', async (ctx) => {
      const plans = await this.tenants.listActivePlans();
      const lines = plans.map((p) => {
        const cycle = p.billingCycle === 'daily' ? '/day' : '/mo';
        return `• *${p.name}* — ₦${p.priceMonthly.toLocaleString()}${cycle}\n  ${p.maxDailyEntries} entries · stake ${p.fixedStake} · ${p.fixedTarget}x`;
      });
      await ctx.reply(`📋 *Plans*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
    });

    this.bot.command('setup_creds', async (ctx) => {
      const user = ctx.state.user;
      if (!user) {
        await ctx.reply('Register first with /start.');
        return;
      }
      this.credSessions.set(ctx.chat!.id, { step: 'username' });
      await ctx.reply(
        'Send your *BC.Game username* in the next message.\nMessages will be deleted for security.',
        { parse_mode: 'Markdown' }
      );
    });
  }

  private setupCredentialFlow(): void {
    this.bot.on('text', async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId == null) return next();
      const session = this.credSessions.get(chatId);
      if (!session || !session.step) return next();

      const text = ctx.message.text.trim();
      // Ignore commands mid-flow
      if (text.startsWith('/')) return next();

      try {
        await ctx.deleteMessage().catch(() => undefined);
      } catch {
        /* ignore */
      }

      const user = ctx.state.user ?? (await this.tenants.getUserByTelegramId(BigInt(chatId)));
      if (!user) {
        this.credSessions.delete(chatId);
        await ctx.reply('Session expired. /start again.');
        return;
      }

      if (session.step === 'username') {
        session.username = text;
        session.step = 'password';
        this.credSessions.set(chatId, session);
        await ctx.reply('Username saved. Now send your *password*.', {
          parse_mode: 'Markdown',
        });
        return;
      }

      if (session.step === 'password') {
        session.password = text;
        session.step = 'totp';
        this.credSessions.set(chatId, session);
        await ctx.reply(
          'Password saved. Send *2FA TOTP secret* (or send `-` to skip).',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (session.step === 'totp') {
        const totp = text === '-' ? undefined : text;
        try {
          await this.vault.store(user.id, {
            username: session.username!,
            password: session.password!,
            totp,
          });
          await this.tenants.audit({
            actorType: 'user',
            actorId: user.id,
            action: 'credentials.stored',
            targetUserId: user.id,
          });
          this.credSessions.delete(chatId);
          await ctx.reply(
            '✅ Credentials encrypted and stored.\nIf your subscription is active, engine will use them on next provision. Use /status.'
          );
          // Re-provision if active so container gets new env
          if (user.status === 'active') {
            const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
            await this.orchestrator.provision(user.id, plan
              ? {
                  FIXED_STAKE: String(plan.fixedStake),
                  FIXED_TARGET: String(plan.fixedTarget),
                  MAX_DAILY_ENTRIES: String(plan.maxDailyEntries),
                }
              : undefined);
            await ctx.reply('🔄 Engine re-provisioned with credentials.');
          }
        } catch (err) {
          this.logger.error(
            { component: 'TenantRouterBot', error: String(err) },
            'Credential store failed'
          );
          this.credSessions.delete(chatId);
          await ctx.reply('❌ Failed to store credentials. Ensure TENANT_MASTER_KEY is set.');
        }
      }
    });
  }


  private setupTermsAndStakeCommands(): void {
    this.bot.action(/accept_terms:(.+)/, async (ctx) => {
      const version = ctx.match[1];
      const chatId = BigInt(ctx.chat!.id);
      const user = await this.tenants.getUserByTelegramId(chatId);
      if (!user) return;
      await this.termsService.acceptTerms({
        userId: user.id,
        version,
        userAgent: 'Telegram Bot',
      });
      await ctx.editMessageText(
        `✅ *Terms Accepted*\n\nVersion: ${version}\nYou may continue with /start`,
        { parse_mode: 'Markdown' }
      );
      await ctx.answerCbQuery('Accepted');
    });

    this.bot.action('decline_terms', async (ctx) => {
      await ctx.editMessageText(
        '❌ Registration cancelled. Accept Terms via /start to use the platform.',
        { parse_mode: 'Markdown' }
      );
      await ctx.answerCbQuery();
    });

    this.bot.command('stake', async (ctx) => {
      const user = ctx.state.user;
      if (!user) return;
      const config = await this.stakeService.getStakeConfig(user.id);
      if (!config) {
        await ctx.reply('Unable to load stake config.');
        return;
      }
      if (!config.isConfigurable) {
        await ctx.reply(
          `📊 *Your Stake*\n\nLocked at ₦${config.currentStake.toLocaleString()}\nUpgrade to Pro/Whale to customize.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      const lines = [
        '📊 *Stake Configuration*',
        `Current: *₦${config.currentStake.toLocaleString()}*`,
        `Default: ₦${config.defaultStake.toLocaleString()}`,
        `Range: ₦${config.minStake.toLocaleString()} — ₦${config.maxStake.toLocaleString()}`,
        config.increasePaid
          ? 'Increase fee: paid ✅'
          : `Increase fee (to go above default): *₦${config.increaseFeeAmount.toLocaleString()}* (use /pay_stake_increase)`,
        '',
        'Set with: `/stake_set <amount>`',
      ];
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    this.bot.command('stake_set', async (ctx) => {
      const user = ctx.state.user;
      if (!user) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const amount = parseFloat(text.split(/\s+/)[1] ?? '');
      if (!Number.isFinite(amount) || amount <= 0) {
        await ctx.reply('Usage: /stake_set <amount>\nExample: /stake_set 5000');
        return;
      }
      const result = await this.stakeService.setStake(user.id, amount);
      await ctx.reply(result.message);
    });

    this.bot.command('pay_stake_increase', async (ctx) => {
      const user = ctx.state.user;
      if (!user) return;
      const config = await this.stakeService.getStakeConfig(user.id);
      if (!config || config.increasePaid) {
        await ctx.reply('No stake increase fee required.');
        return;
      }
      const va = await this.vaService.getVirtualAccount(user.id);
      if (!va) {
        await ctx.reply('No virtual account. Complete plan payment first.');
        return;
      }
      await ctx.reply(
        `💰 *Stake Increase Fee*\n\n` +
          `Transfer *₦${config.increaseFeeAmount.toLocaleString()}* to:\n` +
          `Bank: *${va.bankName}*\n` +
          `Account: \`${va.accountNumber}\`\n\n` +
          `One-time fee unlocks stake up to ₦${config.maxStake.toLocaleString()}.`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('today', async (ctx) => {
      const user = ctx.state.user;
      if (!user) return;
      const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
      if (!plan || plan.billingCycle !== 'daily') {
        await ctx.reply('You are not on Pay-as-You-Go. Use /status.');
        return;
      }
      const todaySub = await this.dailyBilling.getTodaySubscription(user.id);
      const instance = await this.tenants.getInstance(user.id);
      if (todaySub?.status === 'active') {
        await ctx.reply(
          `📅 *Today's Access*\n\nStatus: ✅ Active\nEntries: ${instance?.dailyEntriesUsed ?? 0} / ${plan.maxDailyEntries}\nExpires: midnight (+ grace)`,
          { parse_mode: 'Markdown' }
        );
      } else {
        const va = await this.vaService.getVirtualAccount(user.id);
        await ctx.reply(
          `📅 *Today's Access*\n\nStatus: ⏸️ Inactive\nTransfer *₦${this.dailyBilling.dailyPrice.toLocaleString()}* to:\nBank: *${va?.bankName ?? '—'}*\nAccount: \`${va?.accountNumber ?? '—'}\``,
          { parse_mode: 'Markdown' }
        );
      }
    });

    this.bot.command('auto_renew', async (ctx) => {
      const user = ctx.state.user;
      if (!user) return;
      const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
      if (!plan || plan.billingCycle !== 'daily') {
        await ctx.reply('Auto-renew is for Pay-as-You-Go only.');
        return;
      }
      const todaySub = await this.dailyBilling.getTodaySubscription(user.id);
      const next = !(todaySub?.autoRenew ?? true);
      await this.dailyBilling.toggleAutoRenew(user.id, next);
      await ctx.reply(`🔔 Auto-renewal reminders ${next ? 'enabled' : 'disabled'}.`);
    });

    this.bot.command('upgrade', async (ctx) => {
      const plans = await this.tenants.listActivePlans();
      const monthly = plans.filter((p) => p.billingCycle !== 'daily' && p.priceMonthly > 0);
      const keyboard = monthly.map((p) => [
        {
          text: `${p.name} — ₦${p.priceMonthly.toLocaleString()}/mo`,
          callback_data: `plan:${p.id}`,
        },
      ]);
      await ctx.reply('📈 *Upgrade to monthly*\n\nSelect a plan:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });
    });
  }


  private setupExtraUserCommands(): void {
    this.bot.command('history', async (ctx) => {
      const user = ctx.state.user;
      if (!user) {
        await ctx.reply('Register first with /start');
        return;
      }
      const text = 'text' in (ctx.message ?? {}) ? String((ctx.message as { text?: string }).text ?? '') : '';
      const n = Math.min(50, Math.max(1, parseInt(text.split(/\s+/)[1] ?? '10', 10) || 10));
      const bets = await this.performance.getRecentBets(user.id, n);
      if (bets.length === 0) {
        await ctx.reply('No bets yet.');
        return;
      }
      const lines = bets.map((b) => {
        const t = b.time ? new Date(b.time).toLocaleString() : '?';
        const pnl = b.pnl != null ? (b.pnl >= 0 ? `+${b.pnl}` : String(b.pnl)) : '—';
        return `${t} | ${b.stake} @ ${b.target}x → ${b.state} (${pnl})`;
      });
      await ctx.reply(`📜 *Last ${bets.length} bets*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    });

    this.bot.command('analytics', async (ctx) => {
      const user = ctx.state.user;
      if (!user) {
        await ctx.reply('Register first with /start');
        return;
      }
      const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
      const perf = await this.performance.getUserPerformance(user.id, plan?.maxDailyEntries ?? 100);
      if (!perf) {
        await ctx.reply('No performance data yet.');
        return;
      }
      const trend = perf.dailyTrend
        .slice(0, 7)
        .map((d) => `${d.date}: ${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(0)} (${d.bets} bets)`)
        .join('\n');
      await ctx.reply(
        `📊 *Your Analytics*\n\n` +
          `P&L Today: ${perf.pnlToday >= 0 ? '+' : ''}${perf.pnlToday}\n` +
          `P&L Total: ${perf.pnlTotal >= 0 ? '+' : ''}${perf.pnlTotal}\n` +
          `Win Rate: ${perf.winRate.toFixed(1)}% (${perf.wins}W / ${perf.losses}L)\n` +
          `Avg Multiplier: ${perf.avgMultiplier.toFixed(2)}x\n` +
          `Biggest Win: ${perf.biggestWin}\n` +
          `Biggest Loss: ${perf.biggestLoss}\n` +
          `Streak: ${perf.currentStreak}\n` +
          `Entries: ${perf.entriesUsed} / ${perf.entriesLimit}\n\n` +
          `*7-Day Trend*\n${trend || 'No data'}`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('support', async (ctx) => {
      const user = ctx.state.user;
      const text = 'text' in (ctx.message ?? {}) ? String((ctx.message as { text?: string }).text ?? '') : '';
      const msg = text.replace(/^\/support\s*/, '').trim();
      if (!msg) {
        await ctx.reply(
          'Open a support ticket:\n`/support <your message>`\n\nAn admin will follow up.',
          { parse_mode: 'Markdown' }
        );
        return;
      }
      await this.tenants.audit({
        actorType: 'user',
        actorId: user?.id ?? String(ctx.chat?.id ?? 'unknown'),
        action: 'support.ticket',
        targetUserId: user?.id,
        payload: { message: msg.slice(0, 2000) },
      });
      if (this.adminTelegramId !== 0n) {
        try {
          await this.bot.telegram.sendMessage(
            Number(this.adminTelegramId),
            `🎫 *Support ticket*\nFrom: ${user?.telegramUsername ?? ctx.chat?.id}\nUser: \`${user?.id ?? 'n/a'}\`\n\n${msg}`,
            { parse_mode: 'Markdown' }
          );
        } catch {
          /* ignore */
        }
      }
      await ctx.reply('✅ Support ticket submitted. We will respond soon.');
    });
  }

  private setupAdminCommands(): void {
    const requireAdmin = async (ctx: TenantBotContext): Promise<boolean> => {
      if (!ctx.state.isAdmin) {
        return false;
      }
      return true;
    };

    // ─── Existing core admin ───────────────────────────────────────────────
    this.bot.command('admin_users', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const { getPool } = await import('../persistence/client.js');
      const q = await getPool().query(
        `SELECT u.id, u.telegram_id, u.telegram_username, u.status, p.name AS plan_name,
                i.status AS engine_status, i.pnl_total, i.daily_entries_used
         FROM users u
         LEFT JOIN plans p ON u.plan_id = p.id
         LEFT JOIN tenant_instances i ON u.id = i.user_id
         ORDER BY u.created_at DESC LIMIT 50`
      );
      if (q.rows.length === 0) {
        await ctx.reply('No users yet.');
        return;
      }
      const lines = q.rows.map((r) => {
        const un = r.telegram_username ? `@${r.telegram_username}` : r.telegram_id;
        return `• ${un} | ${r.plan_name ?? '—'} | ${r.status} | Engine: ${r.engine_status ?? 'none'} | P&L: ${r.pnl_total ?? 0}`;
      });
      await ctx.reply(`👥 *Users (${q.rows.length})*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    });

    this.bot.command('admin_pause_all', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      await this.orchestrator.globalPause();
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.pause_all',
      });
      await ctx.reply('⏸ Global pause issued — all engines paused.');
    });

    this.bot.command('admin_resume_all', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      await this.orchestrator.globalResume();
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.resume_all',
      });
      await ctx.reply('▶️ Global resume issued.');
    });

    this.bot.command('admin_ban', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const targetId = text.split(/\s+/)[1];
      if (!targetId) {
        await ctx.reply('Usage: /admin_ban <telegram_id>');
        return;
      }
      const user = await this.tenants.getUserByTelegramId(BigInt(targetId));
      if (!user) {
        await ctx.reply('User not found.');
        return;
      }
      await this.tenants.updateUserStatus(user.id, 'banned');
      try {
        await this.orchestrator.destroy(user.id);
      } catch {
        /* ignore */
      }
      try {
        await this.vault.store(user.id, { username: '', password: '', totp: undefined });
      } catch {
        /* purge best-effort */
      }
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'user.banned',
        targetUserId: user.id,
      });
      await ctx.reply(`🚫 Banned ${targetId}. Engine destroyed. Credentials purged.`);
    });

    this.bot.command('admin_user_stake', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const userId = text.split(/\s+/)[1];
      if (!userId) {
        await ctx.reply('Usage: /admin_user_stake <user_id>');
        return;
      }
      const config = await this.stakeService.getStakeConfig(userId);
      const history = await this.stakeService.getStakeHistory(userId);
      if (!config) {
        await ctx.reply('Not found');
        return;
      }
      const hist = history
        .slice(0, 5)
        .map((h) => `${h.oldStake}→${h.newStake} (${h.changeType})`)
        .join('\n');
      await ctx.reply(
        `Stake: ${config.currentStake}\nRange: ${config.minStake}-${config.maxStake}\nFee paid: ${config.increasePaid}\n${hist}`
      );
    });

    this.bot.command('admin_high_stakes', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const rows = await this.stakeService.listHighStakes(10000);
      const lines = rows.map((r) => `tg:${r.telegramId} stake=${r.stake}`);
      await ctx.reply(lines.join('\n') || 'None');
    });

    this.bot.command('admin_broadcast', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const msg = text.replace(/^\/admin_broadcast\s*/, '');
      if (!msg) {
        await ctx.reply('Usage: /admin_broadcast <message>');
        return;
      }
      const { getPool } = await import('../persistence/client.js');
      const result = await getPool().query(
        `SELECT telegram_id FROM users WHERE status = 'active'`
      );
      let sent = 0;
      for (const row of result.rows) {
        try {
          await ctx.telegram.sendMessage(
            Number(row.telegram_id),
            `📢 *Platform Notice*\n\n${msg}`,
            { parse_mode: 'Markdown' }
          );
          sent++;
        } catch {
          /* ignore */
        }
      }
      await ctx.reply(`📨 Sent to ${sent}/${result.rows.length} users.`);
    });

    // ─── Account manager: create / assign / creds / stake / engine ──────────
    this.bot.command('admin_create_user', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const targetTelegramId = text.split(/\s+/)[1];
      if (!targetTelegramId || Number.isNaN(Number(targetTelegramId))) {
        await ctx.reply(
          'Usage: /admin_create_user <telegram_id>\nExample: /admin_create_user 2348123456789'
        );
        return;
      }
      const existing = await this.tenants.getUserByTelegramId(BigInt(targetTelegramId));
      if (existing) {
        await ctx.reply(
          `User ${targetTelegramId} already exists. Use /admin_user ${existing.id} to manage.`
        );
        return;
      }
      const user = await this.tenants.createUser({ telegramId: BigInt(targetTelegramId) });
      await this.tenants.updateUserStatus(user.id, 'onboarding');
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.create_user',
        targetUserId: user.id,
        payload: { telegramId: targetTelegramId },
      });
      const plans = await this.tenants.listActivePlans();
      const keyboard = plans.map((p) => [
        {
          text: `${p.name} — ₦${Number(p.priceMonthly).toLocaleString()}${p.billingCycle === 'daily' ? '/day' : '/mo'}`,
          callback_data: `admin_assign_plan:${user.id}:${p.id}`,
        },
      ]);
      await ctx.reply(
        `👤 *User Created*\n\nTelegram ID: \`${targetTelegramId}\`\nUser ID: \`${user.id}\`\nStatus: onboarding\n\nAssign a plan:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
      );
    });

    this.bot.action(/admin_assign_plan:(.+):(.+)/, async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const userId = ctx.match![1];
      const planId = ctx.match![2];
      const plan = await this.tenants.getPlan(planId);
      if (!plan) {
        await ctx.answerCbQuery('Plan not found');
        return;
      }
      await this.tenants.assignPlan(userId, planId);
      try {
        await this.tenants.createInstance(userId);
      } catch {
        /* may already exist */
      }
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.assign_plan',
        targetUserId: userId,
        payload: { planId },
      });
      await ctx.editMessageText(
        `✅ *Plan Assigned*\n\nUser: \`${userId.slice(0, 8)}...\`\nPlan: ${plan.name}\nPrice: ₦${Number(plan.priceMonthly).toLocaleString()}${plan.billingCycle === 'daily' ? '/day' : '/mo'}\n\nNext:\n1. /admin_set_creds ${userId} <user> <pass> [2fa]\n2. /admin_set_stake ${userId} <amount>\n3. /admin_start_engine ${userId} dry-run`,
        { parse_mode: 'Markdown' }
      );
      await ctx.answerCbQuery();
    });

    this.bot.command('admin_set_creds', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const args = text.split(/\s+/);
      if (args.length < 4) {
        await ctx.reply(
          'Usage: /admin_set_creds <user_id> <username> <password> [2fa_secret]\nExample: /admin_set_creds abc123 johndoe mypass123 JBSWY3DPEHPK3PXP'
        );
        return;
      }
      const userId = args[1];
      const username = args[2];
      const password = args[3];
      const totp = args[4] || undefined;
      const user = await this.tenants.getUserById(userId);
      if (!user) {
        await ctx.reply('User not found.');
        return;
      }
      await this.vault.store(userId, { username, password, totp });
      try {
        await ctx.deleteMessage(ctx.message!.message_id);
      } catch {
        this.logger.warn({ component: 'TenantRouterBot' }, 'Failed to delete admin credential message');
      }
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.set_creds',
        targetUserId: userId,
      });
      await ctx.reply(
        `🔐 *Credentials Set*\n\nUser: \`${userId.slice(0, 8)}...\`\nUsername: ${username}\nPassword: *** (encrypted)\n2FA: ${totp ? '*** (encrypted)' : 'Not set'}`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('admin_set_stake', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const args = text.split(/\s+/);
      if (args.length !== 3) {
        await ctx.reply('Usage: /admin_set_stake <user_id> <amount>\nExample: /admin_set_stake abc123 5000');
        return;
      }
      const userId = args[1];
      const amount = parseFloat(args[2]);
      if (!Number.isFinite(amount) || amount <= 0) {
        await ctx.reply('Invalid amount.');
        return;
      }
      const result = await this.stakeService.adminSetStake(
        userId,
        amount,
        String(this.adminTelegramId)
      );
      if (!result.success) {
        await ctx.reply(result.message);
        return;
      }
      await ctx.reply(
        `✅ *Stake Updated (by Admin)*\n\nUser: \`${userId.slice(0, 8)}...\`\nOld: ${result.oldStake}\nNew: ${result.newStake}`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('admin_set_mode', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const args = text.split(/\s+/);
      if (args.length < 3) {
        await ctx.reply('Usage: /admin_set_mode <user_id> <observe-only|dry-run|live>');
        return;
      }
      const userId = args[1];
      const mode = args[2];
      if (!['observe-only', 'dry-run', 'live'].includes(mode)) {
        await ctx.reply('Mode must be observe-only, dry-run, or live.');
        return;
      }
      await this.tenants.updateInstance(userId, { mode });
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.set_mode',
        targetUserId: userId,
        payload: { mode },
      });
      await ctx.reply(`✅ Mode for \`${userId.slice(0, 8)}...\` set to *${mode}*`, {
        parse_mode: 'Markdown',
      });
    });

    this.bot.command('admin_start_engine', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const args = text.split(/\s+/);
      if (args.length < 2) {
        await ctx.reply('Usage: /admin_start_engine <user_id> [mode]\nExample: /admin_start_engine abc123 dry-run');
        return;
      }
      const userId = args[1];
      const mode = (args[2] as 'observe-only' | 'dry-run' | 'live') || 'dry-run';
      const user = await this.tenants.getUserById(userId);
      if (!user) {
        await ctx.reply('User not found.');
        return;
      }
      const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
      if (!plan) {
        await ctx.reply('User has no plan.');
        return;
      }
      const stakeConfig = await this.stakeService.getStakeConfig(userId);
      const stake = stakeConfig?.currentStake ?? plan.fixedStake;
      await this.tenants.updateInstance(userId, { mode });
      const info = await this.orchestrator.provision(userId, {
        FIXED_STAKE: String(stake),
        FIXED_TARGET: String(plan.fixedTarget),
        MAX_DAILY_ENTRIES: String(plan.maxDailyEntries),
        MODE: mode,
      });
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.start_engine',
        targetUserId: userId,
        payload: { mode, containerId: info?.containerId },
      });
      try {
        await ctx.telegram.sendMessage(
          Number(user.telegramId),
          `🚀 *Your Engine is Starting!*\n\nMode: ${mode}\nStake: ${stake}\nPlan: ${plan.name}\n\nSet up by admin. Use /status to check.`,
          { parse_mode: 'Markdown' }
        );
      } catch {
        /* ignore */
      }
      await ctx.reply(
        `🚀 *Engine Started*\n\nUser: \`${userId.slice(0, 8)}...\`\nMode: ${mode}\nStake: ${stake}\nPlan: ${plan.name}\nContainer: ${info?.containerId ?? 'n/a'}`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('admin_pause_engine', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const userId = text.split(/\s+/)[1];
      if (!userId) {
        await ctx.reply('Usage: /admin_pause_engine <user_id>');
        return;
      }
      await this.orchestrator.pause(userId);
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.pause_engine',
        targetUserId: userId,
      });
      await ctx.reply(`⏸ Engine paused for \`${userId.slice(0, 8)}...\``, { parse_mode: 'Markdown' });
    });

    this.bot.command('admin_destroy_engine', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const userId = text.split(/\s+/)[1];
      if (!userId) {
        await ctx.reply('Usage: /admin_destroy_engine <user_id>');
        return;
      }
      await this.orchestrator.destroy(userId);
      await this.tenants.audit({
        actorType: 'admin',
        actorId: String(this.adminTelegramId),
        action: 'admin.destroy_engine',
        targetUserId: userId,
      });
      await ctx.reply(`🗑 Engine destroyed for \`${userId.slice(0, 8)}...\``, { parse_mode: 'Markdown' });
    });

    // ─── Deep dive / monitoring ────────────────────────────────────────────
    this.bot.command('admin_user', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const userId = text.split(/\s+/)[1];
      if (!userId) {
        await ctx.reply('Usage: /admin_user <user_id>');
        return;
      }
      const user = await this.tenants.getUserById(userId);
      if (!user) {
        await ctx.reply('User not found.');
        return;
      }
      const plan = user.planId ? await this.tenants.getPlan(user.planId) : null;
      const instance = await this.tenants.getInstance(userId);
      const perf = await this.performance.getUserPerformance(
        userId,
        plan?.maxDailyEntries ?? 100
      );
      const stakeConfig = await this.stakeService.getStakeConfig(userId);
      const lines = [
        `👤 *User Deep Dive*`,
        ``,
        `*Telegram:* @${user.telegramUsername ?? 'N/A'} (\`${user.telegramId}\`)`,
        `*User ID:* \`${user.id}\``,
        `*Status:* ${user.status}`,
        `*Plan:* ${plan?.name ?? 'None'} (${plan?.billingCycle ?? 'N/A'})`,
        `*Stake:* ${stakeConfig?.currentStake ?? plan?.fixedStake ?? 'N/A'}`,
        `*Timezone:* ${user.timezone}`,
        ``,
        `*Engine:*`,
        `  Status: ${instance?.status ?? 'Not provisioned'}`,
        `  Mode: ${instance?.mode ?? 'N/A'}`,
        `  Container: ${instance?.containerId ?? 'N/A'}`,
        `  Daily Entries: ${instance?.dailyEntriesUsed ?? 0} / ${plan?.maxDailyEntries ?? 0}`,
        `  P&L Today: ${instance?.pnlToday ?? 0}`,
        `  P&L Total: ${instance?.pnlTotal ?? 0}`,
        `  Heartbeat: ${instance?.lastHeartbeat?.toISOString() ?? 'never'}`,
      ];
      if (perf) {
        lines.push(
          ``,
          `*Performance:*`,
          `  Win Rate: ${perf.winRate.toFixed(1)}% (${perf.wins}W/${perf.losses}L)`,
          `  Avg Multiplier: ${perf.avgMultiplier.toFixed(2)}x`,
          `  Biggest Win: ${perf.biggestWin}`,
          `  Biggest Loss: ${perf.biggestLoss}`,
          `  Streak: ${perf.currentStreak}`
        );
        if (perf.dailyTrend.length) {
          lines.push(``, `*7-Day Trend:*`);
          for (const d of perf.dailyTrend.slice(0, 7)) {
            lines.push(`  ${d.date}: ${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(0)} (${d.bets} bets)`);
          }
        }
      }
      lines.push(
        ``,
        `*Actions:*`,
        `/admin_pause_engine ${userId}`,
        `/admin_start_engine ${userId} live`,
        `/admin_set_stake ${userId} <amount>`,
        `/admin_ban ${user.telegramId}`
      );
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    this.bot.command('admin_stats', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const s = await this.performance.getPlatformStats();
      const top = s.topPerformer
        ? `tg:${s.topPerformer.telegramId} (+${s.topPerformer.pnl})`
        : '—';
      const worst = s.worstPerformer
        ? `tg:${s.worstPerformer.telegramId} (${s.worstPerformer.pnl})`
        : '—';
      await ctx.reply(
        `📊 *Platform Statistics*\n\n` +
          `👥 Users: ${s.activeUsers} active / ${s.suspendedUsers} suspended / ${s.bannedUsers} banned (${s.totalUsers} total)\n` +
          `🚀 Engines: ${s.activeEngines} running / ${s.pausedEngines} paused / ${s.errorEngines} error\n` +
          `💳 Active subs: ${s.subsActive}\n` +
          `📈 P&L Today: ${s.totalPnlToday >= 0 ? '+' : ''}${s.totalPnlToday}\n` +
          `📉 P&L All Time: ${s.totalPnlAllTime >= 0 ? '+' : ''}${s.totalPnlAllTime}\n` +
          `🏆 Avg Win Rate (today): ${s.avgWinRate.toFixed(1)}%\n\n` +
          `🥇 Top: ${top}\n` +
          `🥉 Worst: ${worst}`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('admin_leaderboard', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const rows = await this.performance.getLeaderboard(10);
      const lines = rows.map(
        (r, i) =>
          `${i + 1}. ${r.username ? '@' + r.username : 'tg:' + r.telegramId} — ${r.pnl >= 0 ? '+' : ''}${r.pnl}`
      );
      await ctx.reply(`🏆 *Top 10*\n\n${lines.join('\n') || 'No data'}`, {
        parse_mode: 'Markdown',
      });
    });

    this.bot.command('admin_losers', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const rows = await this.performance.getLosers(10);
      const lines = rows.map(
        (r) =>
          `• ${r.username ? '@' + r.username : 'tg:' + r.telegramId} — ${r.pnl}`
      );
      await ctx.reply(`📉 *Users in the red*\n\n${lines.join('\n') || 'None'}`, {
        parse_mode: 'Markdown',
      });
    });

    this.bot.command('admin_inactive', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const rows = await this.performance.getInactiveUsers(24);
      const lines = rows.map(
        (r) => `• tg:${r.telegramId} last=${r.lastBet ?? 'never'} (\`${r.userId.slice(0, 8)}\`)`
      );
      await ctx.reply(`😴 *Inactive 24h*\n\n${lines.join('\n') || 'None'}`, {
        parse_mode: 'Markdown',
      });
    });

    this.bot.command('admin_bets', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const parts = text.split(/\s+/);
      const userId = parts[1];
      const n = Math.min(50, Math.max(1, parseInt(parts[2] ?? '20', 10) || 20));
      if (!userId) {
        await ctx.reply('Usage: /admin_bets <user_id> [n]');
        return;
      }
      const bets = await this.performance.getRecentBets(userId, n);
      if (!bets.length) {
        await ctx.reply('No bets.');
        return;
      }
      const lines = bets.map((b) => {
        const pnl = b.pnl != null ? (b.pnl >= 0 ? `+${b.pnl}` : String(b.pnl)) : '—';
        return `${b.time.slice(0, 19)} | ${b.stake}@${b.target}x → ${b.state} (${pnl})`;
      });
      await ctx.reply(`🎯 *Bets (${bets.length})*\n\n${lines.join('\n')}`, {
        parse_mode: 'Markdown',
      });
    });

    this.bot.command('admin_health', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const { getPool } = await import('../persistence/client.js');
      const q = await getPool().query(
        `SELECT status, COUNT(*)::int AS c FROM tenant_instances GROUP BY status ORDER BY c DESC`
      );
      const lines = q.rows.map((r) => `• ${r.status}: ${r.c}`);
      try {
        await this.orchestrator.healthSweep();
      } catch (e) {
        lines.push(`Health sweep error: ${e instanceof Error ? e.message : String(e)}`);
      }
      await ctx.reply(`🩺 *Engine Health*\n\n${lines.join('\n') || 'No instances'}`, {
        parse_mode: 'Markdown',
      });
    });

    // ─── Payments ──────────────────────────────────────────────────────────
    this.bot.command('admin_pending_payments', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const { getPool } = await import('../persistence/client.js');
      const q = await getPool().query(
        `SELECT id, user_id, amount, currency, status, created_at
         FROM payment_transactions
         WHERE status = 'pending'
         ORDER BY created_at DESC LIMIT 30`
      ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
      if (!q.rows.length) {
        await ctx.reply('No pending payments.');
        return;
      }
      const lines = q.rows.map(
        (r) =>
          `• \`${r.id}\` user=\`${String(r.user_id).slice(0, 8)}\` ${r.amount} ${r.currency} @ ${r.created_at}`
      );
      await ctx.reply(
        `💳 *Pending payments*\n\n${lines.join('\n')}\n\nVerify: /admin_verify <tx_id>`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('admin_verify', async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const text = 'text' in ctx.message! ? ctx.message.text : '';
      const txId = text.split(/\s+/)[1];
      if (!txId) {
        await ctx.reply('Usage: /admin_verify <tx_id>');
        return;
      }
      try {
        await this.vaService.verifyPendingTransaction(txId, String(this.adminTelegramId));
        await this.tenants.audit({
          actorType: 'admin',
          actorId: String(this.adminTelegramId),
          action: 'admin.verify_payment',
          payload: { txId },
        });
        await ctx.reply(`✅ Payment \`${txId}\` verified.`, { parse_mode: 'Markdown' });
      } catch (e) {
        await ctx.reply(`❌ Verify failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  async start(): Promise<void> {
    await this.bot.launch();
    this.logger.info({ component: 'TenantRouterBot' }, 'Multi-tenant bot started');
  }

  async stop(): Promise<void> {
    this.bot.stop('shutdown');
  }


  getBot(): Telegraf<TenantBotContext> {
    return this.bot;
  }

  async sendMessage(chatId: number | bigint, text: string): Promise<void> {
    await this.bot.telegram.sendMessage(Number(chatId), text, {
      parse_mode: 'Markdown',
    });
  }
}
