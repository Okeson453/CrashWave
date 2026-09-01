/**
 * RoundObserver — tracks BC.Game Crash rounds from adapter events.
 * Uses shared RoundState from types/game so Orchestrator typing is consistent.
 */
import { getLogger } from '../observability/logger';
import type { GameAdapter } from './adapter';
import type { NormalizedGameEvent } from './types';
import type {
  RoundState,
  ObservationSource,
  ObservationConfidence,
} from '../types/game';

export type { RoundState } from '../types/game';
export type RoundPhase = RoundState['phase'];

export interface RoundObserverOptions {
  adapter: GameAdapter;
  minConfidenceForEntry?: 'low' | 'medium' | 'high';
  maxLatencyMs?: number;
}

function asSource(s: ObservationSource | string | null | undefined): ObservationSource {
  if (s === 'websocket' || s === 'dom' || s === 'api' || s === 'unknown') return s;
  return 'unknown';
}

export class RoundObserver {
  private readonly options: RoundObserverOptions;
  private readonly logger = getLogger();
  private started = false;
  private unsubscribeAdapter: (() => void) | null = null;
  private currentState: RoundState = {
    phase: 'idle',
    roundId: null,
    currentMultiplier: 1,
    crashPoint: null,
    startedAt: null,
    lastTickAt: null,
    crashedAt: null,
    confidence: 'low',
    source: 'unknown',
  };
  private tickHistory: Array<{ multiplier: number; timestamp: string; latencyMs: number }> = [];
  private roundCount = 0;
  private lastStateChangeAt = Date.now();
  private stateListeners: Array<(state: RoundState) => void> = [];
  private roundCompleteListeners: Array<(roundId: string, crashPoint: number) => void> = [];
  private roundStartListeners: Array<(roundId: string) => void> = [];

  constructor(options: RoundObserverOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeAdapter = this.options.adapter.onEvent((event) => {
      void this.handleEvent(event);
    });
    this.logger.info({ component: 'RoundObserver' }, 'RoundObserver started');
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.unsubscribeAdapter) {
      this.unsubscribeAdapter();
      this.unsubscribeAdapter = null;
    }
    this.roundCompleteListeners = [];
    this.roundStartListeners = [];
    this.stateListeners = [];
  }

  private async handleEvent(event: NormalizedGameEvent): Promise<void> {
    switch (event.type) {
      case 'round-started':
        await this.handleRoundStarted(event);
        break;
      case 'multiplier-tick':
        await this.handleMultiplierTick(event);
        break;
      case 'round-crashed':
      case 'round-ended':
        await this.handleRoundCrashed(event);
        break;
      default:
        break;
    }
  }

  private async handleRoundStarted(event: NormalizedGameEvent): Promise<void> {
    this.tickHistory = [];
    this.roundCount++;
    const newState: RoundState = {
      phase: 'running',
      roundId: event.roundId ?? null,
      currentMultiplier: 1,
      crashPoint: null,
      startedAt: event.timestamp,
      lastTickAt: event.timestamp,
      crashedAt: null,
      confidence: this.calculateConfidence(event),
      source: asSource(event.source),
    };
    this.updateState(newState);
    this.logger.info(
      {
        component: 'RoundObserver',
        roundId: event.roundId,
        confidence: newState.confidence,
        source: newState.source,
      },
      `Round started: ${event.roundId}`
    );
    for (const listener of this.roundStartListeners) {
      try {
        listener(event.roundId ?? '');
      } catch {
        /* listener errors must not break observer */
      }
    }
  }

  private async handleMultiplierTick(event: NormalizedGameEvent): Promise<void> {
    if (this.currentState.phase !== 'running') return;
    if (event.roundId && this.currentState.roundId && event.roundId !== this.currentState.roundId) {
      return;
    }
    this.tickHistory.push({
      multiplier: event.multiplier || 1.0,
      timestamp: event.timestamp,
      latencyMs: event.latencyMs,
    });
    const newState: RoundState = {
      ...this.currentState,
      currentMultiplier: event.multiplier || this.currentState.currentMultiplier,
      lastTickAt: event.timestamp,
      source: asSource(event.source),
      confidence: this.calculateConfidence(event),
    };
    this.updateState(newState);
  }

  private async handleRoundCrashed(event: NormalizedGameEvent): Promise<void> {
    if (this.currentState.phase === 'crashed') return;
    const crashPoint = event.crashPoint || this.currentState.currentMultiplier || 1;
    const newState: RoundState = {
      ...this.currentState,
      phase: 'crashed',
      crashPoint,
      currentMultiplier: crashPoint,
      lastTickAt: event.timestamp,
      crashedAt: event.timestamp,
      source: asSource(event.source),
      confidence: this.calculateConfidence(event),
    };
    this.updateState(newState);
    const roundId = event.roundId || this.currentState.roundId || 'unknown';
    for (const listener of this.roundCompleteListeners) {
      try {
        listener(roundId, crashPoint);
      } catch {
        /* */
      }
    }
  }

  private calculateConfidence(event: NormalizedGameEvent): ObservationConfidence {
    if (event.confidence === 'high' || event.confidence === 'medium' || event.confidence === 'low') {
      return event.confidence;
    }
    if (event.source === 'websocket') return 'high';
    if (event.source === 'api') return 'medium';
    return 'low';
  }

  private updateState(state: RoundState): void {
    this.currentState = state;
    this.lastStateChangeAt = Date.now();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        /* */
      }
    }
  }

  getCurrentState(): RoundState {
    return this.currentState;
  }

  getRoundCount(): number {
    return this.roundCount;
  }

  onStateChange(listener: (state: RoundState) => void): () => void {
    this.stateListeners.push(listener);
    return () => {
      const idx = this.stateListeners.indexOf(listener);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  onRoundComplete(listener: (roundId: string, crashPoint: number) => void): () => void {
    this.roundCompleteListeners.push(listener);
    return () => {
      const idx = this.roundCompleteListeners.indexOf(listener);
      if (idx >= 0) this.roundCompleteListeners.splice(idx, 1);
    };
  }

  onRoundStart(listener: (roundId: string) => void): () => void {
    this.roundStartListeners.push(listener);
    return () => {
      const idx = this.roundStartListeners.indexOf(listener);
      if (idx >= 0) this.roundStartListeners.splice(idx, 1);
    };
  }

  isRunning(): boolean {
    return this.started;
  }

  getLastStateChangeAgeMs(): number {
    return Date.now() - this.lastStateChangeAt;
  }
}
