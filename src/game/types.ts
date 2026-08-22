import { RoundState, ObservationSource, ObservationConfidence, RoundPhase } from '../types/game';

export interface GameAdapterEvent {
  type: 'round-started' | 'multiplier-tick' | 'round-crashed' | 'round-ended' | 'game-state-change' | 'balance-update' | 'error';
  payload: unknown;
  source: ObservationSource;
  confidence: ObservationConfidence;
  timestamp: string;
  latencyMs: number;
}

export interface RoundStartedEvent {
  roundId: string;
  timestamp: string;
}

export interface RoundCrashedEvent {
  roundId: string;
  crashPoint: number;
  timestamp: string;
}

export interface MultiplierTickEvent {
  roundId: string;
  multiplier: number;
  timestamp: string;
}

export interface GameStateChangeEvent {
  previousPhase: RoundPhase;
  currentPhase: RoundPhase;
  roundId: string | null;
  timestamp: string;
}

export interface BalanceUpdateEvent {
  balance: number;
  currency: string;
  timestamp: string;
}

export interface GameAdapterErrorEvent {
  source: ObservationSource;
  error: string;
  recoverable: boolean;
  timestamp: string;
}

export interface NormalizedGameEvent {
  type: 'round-started' | 'multiplier-tick' | 'round-crashed' | 'round-ended' | 'game-state-change' | 'balance-update' | 'error';
  roundId: string | null;
  multiplier: number | null;
  crashPoint: number | null;
  phase: RoundPhase | null;
  source: ObservationSource;
  confidence: ObservationConfidence;
  timestamp: string;
  latencyMs: number;
  rawPayload?: unknown;
}

export interface SourceSnapshot {
  source: ObservationSource;
  roundId: string | null;
  multiplier: number | null;
  phase: RoundPhase | null;
  crashPoint: number | null;
  timestamp: string;
  latencyMs: number;
  healthy: boolean;
}

export interface AggregatedObservation {
  roundId: string | null;
  multiplier: number | null;
  phase: RoundPhase;
  crashPoint: number | null;
  confidence: ObservationConfidence;
  sources: ObservationSource[];
  timestamp: string;
  latencyMs: number;
  conflicts: SourceConflict[];
}

export interface SourceConflict {
  sources: [ObservationSource, ObservationSource];
  field: 'roundId' | 'multiplier' | 'phase' | 'crashPoint';
  values: [unknown, unknown];
}

export interface AdapterHealth {
  source: ObservationSource;
  healthy: boolean;
  lastEventAt: string | null;
  errorCount: number;
  consecutiveErrors: number;
  latencyAvgMs: number;
}

export type GameAdapterListener = (event: NormalizedGameEvent) => void | Promise<void>;

export interface IGameAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrentState(): RoundState;
  onEvent(listener: GameAdapterListener): () => void;
  getHealth(): AdapterHealth;
}

export interface IGameObserver {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrentState(): RoundState;
  getConfidence(): ObservationConfidence;
  isStale(): boolean;
  onStateChange(listener: (state: RoundState) => void): () => void;
  onRoundComplete(listener: (roundId: string, crashPoint: number) => void): () => void;
}
