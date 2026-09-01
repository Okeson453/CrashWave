/**
 * Telegram Operator Interface — Type Definitions
 *
 * Command definitions, message templates, throttle policies, and
 * all domain types for the human-in-the-loop control plane.
 */

import { Context } from 'telegraf';
import { Update } from 'telegraf/types';

// ─── System Mode ─────────────────────────────────────────────────────────────

export type OperatorSystemMode = 'observe-only' | 'dry-run' | 'live' | 'maintenance';

// ─── Command Definitions ─────────────────────────────────────────────────────

export type StatusCommand =
  | '/status'
  | '/balance'
  | '/daily'
  | '/session'
  | '/pnl'
  | '/entries'
  | '/health'
  | '/lastround';

export type ControlCommand =
  | '/pause'
  | '/resume'
  | '/stop'
  | '/emergencystop'
  | '/mode'
  | '/sheath'
  | '/unsheath';

export type ConfigCommand = '/config';
export type AnalyticsCommand = '/analytics';
export type LoginCommand = '/login' | '/login_cancel';
export type StartCommand = '/start' | '/menu' | '/help';

export type BotCommand =
  | StatusCommand
  | ControlCommand
  | ConfigCommand
  | AnalyticsCommand
  | LoginCommand
  | StartCommand;

// ─── Parsed Command ──────────────────────────────────────────────────────────

export interface ParsedCommand {
  raw: string;
  command: BotCommand;
  args: string[];
  userId: number;
  username?: string;
  chatId: number;
  messageId: number;
  timestamp: number;
}

// ─── Command Handler Result ──────────────────────────────────────────────────

export interface CommandResult {
  success: boolean;
  message: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyToMessageId?: number;
  extra?: Record<string, unknown>;
}

export type CommandHandler = (ctx: OperatorContext, args: string[]) => Promise<CommandResult>;

// ─── Operator Context ────────────────────────────────────────────────────────

export interface OperatorContext extends Context<Update> {
  operatorId: string;
  isAuthenticated: boolean;
  /** Platform admin (TELEGRAM_ALLOWED_USER_IDS) */
  isAdmin?: boolean;
  /** Resolved tenant UUID (Telegram identity → tenant) */
  tenantId?: string;
  telegramUserId?: number;
  chatId?: number;
  command?: ParsedCommand;
}

// ─── Notification Severity ───────────────────────────────────────────────────

export type NotificationSeverity = 'critical' | 'warning' | 'info' | 'debug';

// ─── Notification Payload ────────────────────────────────────────────────────

export interface NotificationPayload {
  id: string;
  severity: NotificationSeverity;
  category: NotificationCategory;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export type NotificationCategory =
  | 'win'
  | 'loss'
  | 'error'
  | 'health'
  | 'milestone'
  | 'system'
  | 'config';

// ─── Throttle Policies ───────────────────────────────────────────────────────

export interface ThrottlePolicy {
  severity: NotificationSeverity;
  maxPerMinute: number;
  maxPerHour: number;
  debounceMs: number;
  batchWindowMs: number;
  dropDuplicates: boolean;
}

export interface ThrottleState {
  count: number;
  windowStart: number;
  lastSent: number;
  pending: NotificationPayload[];
  timer: ReturnType<typeof setTimeout> | null;
}

export const DEFAULT_THROTTLE_POLICIES: ThrottlePolicy[] = [
  {
    severity: 'critical',
    maxPerMinute: 60,
    maxPerHour: 1000,
    debounceMs: 0,
    batchWindowMs: 0,
    dropDuplicates: false,
  },
  {
    severity: 'warning',
    maxPerMinute: 10,
    maxPerHour: 200,
    debounceMs: 5000,
    batchWindowMs: 15000,
    dropDuplicates: true,
  },
  {
    severity: 'info',
    maxPerMinute: 5,
    maxPerHour: 100,
    debounceMs: 10000,
    batchWindowMs: 30000,
    dropDuplicates: true,
  },
  {
    severity: 'debug',
    maxPerMinute: 0,
    maxPerHour: 0,
    debounceMs: 30000,
    batchWindowMs: 60000,
    dropDuplicates: true,
  },
];

// ─── Message Templates ───────────────────────────────────────────────────────

export interface MessageTemplate {
  key: string;
  template: string;
  severity: NotificationSeverity;
  parseMode: 'Markdown' | 'MarkdownV2' | 'HTML';
}

// ─── Audit Trail ─────────────────────────────────────────────────────────────

export interface OperatorAction {
  id: string;
  operatorId: string;
  operatorUsername?: string;
  action: string;
  args: string[];
  result: 'success' | 'failure' | 'denied';
  details?: string;
  timestamp: string;
  ip?: string;
}

// ─── Bot Configuration ───────────────────────────────────────────────────────

export interface TelegramBotConfig {
  botToken: string;
  allowedUserIds: number[];
  verbosity: 'quiet' | 'normal' | 'verbose' | 'debug';
  webhookUrl?: string;
  polling?: boolean;
  rateLimitMessagesPerMinute: number;
  throttlePolicies: ThrottlePolicy[];
  sendRoundStart: boolean;
  sendRoundResult: boolean;
  sendHealthWarnings: boolean;
}

// ─── Health Status ───────────────────────────────────────────────────────────

export interface BotHealthStatus {
  connected: boolean;
  lastPingAt: string | null;
  messagesSent: number;
  messagesDropped: number;
  errors: number;
  uptimeSeconds: number;
}
