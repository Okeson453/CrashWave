export type RoundPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'crashed'
  | 'unknown';

export type ObservationSource = 'websocket' | 'dom' | 'api' | 'unknown';
export type ObservationConfidence = 'high' | 'medium' | 'low';

export interface RoundState {
  roundId: string | null;
  phase: RoundPhase;
  currentMultiplier: number | null;
  startedAt: string | null;
  crashedAt: string | null;
  crashPoint: number | null;
  lastTickAt: string | null;
  source: ObservationSource;
  confidence: ObservationConfidence;
}

export interface MultiplierTick {
  roundId: string;
  multiplier: number;
  observedAt: string;
  source: ObservationSource;
  latencyMs: number;
}

export interface CrashPoint {
  roundId: string;
  crashMultiplier: number;
  observedAt: string;
  source: ObservationSource;
  confidence: ObservationConfidence;
}

export interface GameEvent {
  type: GameEventType;
  payload: unknown;
  timestamp: string;
  correlationId: string;
}

export type GameEventType =
  | 'RoundStarted'
  | 'MultiplierTick'
  | 'RoundCrashed'
  | 'BetPlaced'
  | 'BetRejected'
  | 'CashOutRequested'
  | 'CashOutConfirmed'
  | 'CashOutFailed'
  | 'BalanceUpdated'
  | 'GameStateChanged';
