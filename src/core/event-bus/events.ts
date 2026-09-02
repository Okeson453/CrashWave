import { BaseEvent, SystemEventType, EventMetadata } from '../../types/events';

export interface RoundStartedPayload {
  roundId: string;
  sessionId: string;
  startedAt: string;
}

export interface MultiplierUpdatedPayload {
  roundId: string;
  multiplier: number;
  latencyMs: number;
}

export interface RoundCrashedPayload {
  roundId: string;
  crashPoint: number;
  crashedAt: string;
}

export interface BetPlacedPayload {
  betId: string;
  roundId: string;
  sessionId: string;
  stake: number;
  target: number;
}

export interface BetFailedPayload {
  roundId: string;
  sessionId: string;
  reason: string;
}

export interface CashOutConfirmedPayload {
  betId: string;
  roundId: string;
  multiplier: number;
  pnl: number;
}

export interface CashOutFailedPayload {
  betId: string;
  roundId: string;
  reason: string;
}

export interface ClientOrderIdBoundPayload {
  betId: string;
  clientOrderId: string;
  roundId: string;
}

export interface BalanceUpdatedPayload {
  balance: number;
  source: string;
  sessionId: string;
}

export interface DailyLimitApproachingPayload {
  entriesToday: number;
  maxEntries: number;
}

export interface DailyLimitReachedPayload {
  entriesToday: number;
  maxEntries: number;
}

export interface HealthDegradedPayload {
  component: string;
  status: string;
  message: string;
}

export interface SystemPausedPayload {
  reason: string;
  pausedBy: string;
}

export interface SystemResumedPayload {
  resumedBy: string;
}

export interface CriticalErrorPayload {
  message: string;
  code: string;
  component: string;
}

export interface OperatorCommandReceivedPayload {
  userId: string;
  command: string;
  args: string[];
}

export interface BrowserStartedPayload {
  sessionId: string;
  headless: boolean;
}

export interface SessionAuthenticatedPayload {
  sessionId: string;
  userId: string;
}

export interface GameLoadedPayload {
  sessionId: string;
  url: string;
}

export interface EntryApprovedPayload {
  betId: string;
  roundId: string;
  sessionId: string;
}

export interface EntryRejectedPayload {
  roundId: string;
  sessionId: string;
  reason: string;
}

export interface CashOutRequestedPayload {
  betId: string;
  roundId: string;
  targetMultiplier: number;
}

export type EventPayloadMap = {
  BrowserStarted: BrowserStartedPayload;
  SessionAuthenticated: SessionAuthenticatedPayload;
  GameLoaded: GameLoadedPayload;
  RoundStarted: RoundStartedPayload;
  MultiplierUpdated: MultiplierUpdatedPayload;
  RoundCrashed: RoundCrashedPayload;
  EntryApproved: EntryApprovedPayload;
  EntryRejected: EntryRejectedPayload;
  BetPlaced: BetPlacedPayload;
  BetFailed: BetFailedPayload;
  CashOutRequested: CashOutRequestedPayload;
  CashOutConfirmed: CashOutConfirmedPayload;
  CashOutFailed: CashOutFailedPayload;
  ClientOrderIdBound: ClientOrderIdBoundPayload;
  BalanceUpdated: BalanceUpdatedPayload;
  DailyLimitApproaching: DailyLimitApproachingPayload;
  DailyLimitReached: DailyLimitReachedPayload;
  HealthDegraded: HealthDegradedPayload;
  SystemPaused: SystemPausedPayload;
  SystemResumed: SystemResumedPayload;
  CriticalError: CriticalErrorPayload;
  OperatorCommandReceived: OperatorCommandReceivedPayload;
};

export interface TypedSystemEvent<T extends SystemEventType = SystemEventType> extends BaseEvent {
  type: T;
  payload: T extends keyof EventPayloadMap ? EventPayloadMap[T] : unknown;
}

export function createEvent<T extends keyof EventPayloadMap>(
  type: T,
  payload: EventPayloadMap[T],
  metadata: EventMetadata
): TypedSystemEvent<T & SystemEventType> {
  return {
    id: generateEventId(),
    type: type as T & SystemEventType,
    payload,
    timestamp: new Date().toISOString(),
    correlationId: metadata.correlationId,
    source: metadata.source,
  } as TypedSystemEvent<T & SystemEventType>;
}

function generateEventId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
