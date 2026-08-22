export type TelegramCommand =
  | 'status'
  | 'balance'
  | 'daily'
  | 'session'
  | 'pnl'
  | 'entries'
  | 'health'
  | 'lastround'
  | 'lastbet'
  | 'history'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'emergencystop'
  | 'mode'
  | 'config'
  | 'analytics';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface OperatorAction {
  userId: string;
  command: TelegramCommand;
  args: string[];
  timestamp: string;
  confirmed: boolean;
}

export interface TelegramNotification {
  severity: NotificationSeverity;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
