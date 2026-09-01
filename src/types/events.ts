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
  | 'ExecutionAuthorized'
  | 'PredictionGenerated'
  | 'SignalDetected'
  | 'SignalConfirmed'
  | 'SignalRejected'
  | 'OpportunityScored'
  | 'RegimeChanged'
  | 'BetSettled'
  | 'SentimentAlert'
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
  | 'OperatorCommandReceived'
  | 'PredictionStatePublished'
  | 'ExecutionAuthorizationExpired'
  | 'round:start'
  | 'tick'
  | 'round:end'
  | 'countdown'
  | 'bet:placed'
  | 'bet:cashed-out'
  | 'balance:updated';

export interface TypedEvent<T = unknown> extends BaseEvent {
  payload: T;
}
