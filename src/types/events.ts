export interface BaseEvent {
  id: string;
  type: string;
  payload: unknown;
  timestamp: string;
  correlationId: string;
  source: string;
}

export interface EventMetadata {
  correlationId: string;
  source: string;
  sessionId?: string;
  roundId?: string;
  betId?: string;
}

export type SystemEventType =
  | 'BrowserStarted'
  | 'SessionAuthenticated'
  | 'GameLoaded'
  | 'RoundStarted'
  | 'MultiplierUpdated'
  | 'RoundCrashed'
  | 'EntryApproved'
  | 'EntryRejected'
  | 'BetPlaced'
  | 'BetFailed'
  | 'CashOutRequested'
  | 'CashOutConfirmed'
  | 'CashOutFailed'
  | 'ClientOrderIdBound'
  | 'BalanceUpdated'
  | 'DailyLimitApproaching'
  | 'DailyLimitReached'
  | 'HealthDegraded'
  | 'SystemPaused'
  | 'SystemResumed'
  | 'CriticalError'
  | 'OperatorCommandReceived';

export interface TypedEvent<T = unknown> extends BaseEvent {
  payload: T;
}
