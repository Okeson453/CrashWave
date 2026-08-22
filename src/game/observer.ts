import { EventEmitter } from 'events';
import { RoundState, ObservationConfidence } from '../types/game';
import { IGameObserver, NormalizedGameEvent } from './types';
import { IGameAdapter } from './types';
import { getLogger } from '../observability/logger';
import { STALE_CONFIG, CONFIDENCE_THRESHOLDS } from './constants';

export interface RoundObserverOptions {
  adapter: IGameAdapter;
  staleThresholdMs?: number;
  minConfidenceForEntry?: ObservationConfidence;
  maxLatencyMs?: number;
}

export interface RoundCompleteInfo {
  roundId: string;
  crashPoint: number;
  startedAt: string;
  crashedAt: string;
  tickCount: number;
  durationMs: number;
  confidence: ObservationConfidence;
}

/**
 * RoundObserver consumes normalized game events from the GameAdapter and maintains
 * the authoritative current round state with confidence scoring and stale detection.
 *
 * Key responsibilities:
 * - Track current round ID, phase, and multiplier
 * - Assign confidence scores based on source agreement and latency
 * - Detect stale data (no ticks received for too long)
 * - Emit round lifecycle events
 * - Maintain tick history for the current round
 */
export class RoundObserver extends EventEmitter implements IGameObserver {
  private readonly options: Required<RoundObserverOptions>;
  private readonly logger = getLogger();
  private started = false;
  private currentState: RoundState;
  private stateListeners: Array<(state: RoundState) => void> = [];
  private roundCompleteListeners: Array<(roundId: string, crashPoint: number) => void> = [];
  private tickHistory: Array<{ multiplier: number; timestamp: string; latencyMs: number }> = [];
  private roundCount = 0;
  private lastStateChangeAt: number = 0;
  private unsubscribeAdapter: (() => void) | null = null;

  constructor(options: RoundObserverOptions) {
    super();
    this.options = {
      staleThresholdMs: STALE_CONFIG.multiplierMaxAgeMs,
      minConfidenceForEntry: 'high',
      maxLatencyMs: 1000,
      ...options,
    };

    this.currentState = this.createInitialState();
    this.lastStateChangeAt = Date.now();
  }

  private createInitialState(): RoundState {
    return {
      roundId: null,
      phase: 'idle',
      currentMultiplier: null,
      startedAt: null,
      crashedAt: null,
      crashPoint: null,
      lastTickAt: null,
      source: 'unknown',
      confidence: 'low',
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      this.logger.debug({ component: 'RoundObserver' }, 'Observer already started');
      return;
    }

    this.logger.info({ component: 'RoundObserver' }, 'Starting round observer');
    this.started = true;

    // Subscribe to adapter events
    this.unsubscribeAdapter = this.options.adapter.onEvent((event) => {
      this.handleAdapterEvent(event).catch((err) => {
        this.logger.warn(
          { component: 'RoundObserver', error: String(err) },
          'Error handling adapter event'
        );
      });
    });
  }

  async stop(): Promise<void> {
    this.logger.info({ component: 'RoundObserver' }, 'Stopping round observer');
    this.started = false;

    if (this.unsubscribeAdapter) {
      this.unsubscribeAdapter();
      this.unsubscribeAdapter = null;
    }

    this.removeAllListeners();
    this.stateListeners = [];
    this.roundCompleteListeners = [];
  }

  private async handleAdapterEvent(event: NormalizedGameEvent): Promise<void> {

    switch (event.type) {
      case 'round-started':
        await this.handleRoundStarted(event);
        break;

      case 'multiplier-tick':
        await this.handleMultiplierTick(event);
        break;

      case 'round-crashed':
        await this.handleRoundCrashed(event);
        break;

      case 'round-ended':
        await this.handleRoundEnded(event);
        break;

      case 'game-state-change':
        await this.handleStateChange(event);
        break;

      case 'error':
        this.logger.warn(
          { component: 'RoundObserver', source: event.source, error: event.rawPayload },
          'Adapter error event received'
        );
        break;
    }
  }

  private async handleRoundStarted(event: NormalizedGameEvent): Promise<void> {
    // Reset tick history for new round
    this.tickHistory = [];

    const newState: RoundState = {
      roundId: event.roundId,
      phase: 'running',
      currentMultiplier: event.multiplier || 1.0,
      startedAt: event.timestamp,
      crashedAt: null,
      crashPoint: null,
      lastTickAt: event.timestamp,
      source: event.source,
      confidence: this.calculateConfidence(event),
    };

    this.updateState(newState);
    this.roundCount++;

    this.logger.info(
      {
        component: 'RoundObserver',
        roundId: event.roundId,
        confidence: newState.confidence,
        source: event.source,
      },
      `Round started: ${event.roundId}`
    );

    this.emit('round-started', {
      roundId: event.roundId,
      timestamp: event.timestamp,
    });
  }

  private async handleMultiplierTick(event: NormalizedGameEvent): Promise<void> {
    if (this.currentState.phase !== 'running') {
      // Tick received but we're not in running phase - might be a late event
      this.logger.debug(
        {
          component: 'RoundObserver',
          currentPhase: this.currentState.phase,
          roundId: event.roundId,
        },
        'Multiplier tick received while not in running phase'
      );
      return;
    }

    // Validate round ID matches
    if (event.roundId && this.currentState.roundId && event.roundId !== this.currentState.roundId) {
      this.logger.warn(
        {
          component: 'RoundObserver',
          expectedRoundId: this.currentState.roundId,
          receivedRoundId: event.roundId,
        },
        'Round ID mismatch on tick'
      );
      return;
    }

    // Record tick
    this.tickHistory.push({
      multiplier: event.multiplier || 1.0,
      timestamp: event.timestamp,
      latencyMs: event.latencyMs,
    });

    const newState: RoundState = {
      ...this.currentState,
      currentMultiplier: event.multiplier || this.currentState.currentMultiplier,
      lastTickAt: event.timestamp,
      source: event.source,
      confidence: this.calculateConfidence(event),
    };

    this.updateState(newState);
  }

  private async handleRoundCrashed(event: NormalizedGameEvent): Promise<void> {
    if (this.currentState.phase === 'crashed') {
      // Already crashed, ignore duplicate
      return;
    }

    const crashPoint = event.crashPoint || this.currentState.currentMultiplier;

    const newState: RoundState = {
      ...this.currentState,
      phase: 'crashed',
      crashedAt: event.timestamp,
      crashPoint,
      currentMultiplier: crashPoint,
      lastTickAt: event.timestamp,
      source: event.source,
      confidence: event.crashPoint ? 'high' : 'medium',
    };

    this.updateState(newState);

    const roundId = this.currentState.roundId || event.roundId || 'unknown';
    const startedAt = this.currentState.startedAt || event.timestamp;
    const crashedAt = event.timestamp;
    const durationMs = new Date(crashedAt).getTime() - new Date(startedAt).getTime();

    this.logger.info(
      {
        component: 'RoundObserver',
        roundId,
        crashPoint,
        tickCount: this.tickHistory.length,
        durationMs,
        confidence: newState.confidence,
      },
      `Round crashed: ${crashPoint}x`
    );

    const roundInfo: RoundCompleteInfo = {
      roundId,
      crashPoint: crashPoint || 0,
      startedAt,
      crashedAt,
      tickCount: this.tickHistory.length,
      durationMs,
      confidence: newState.confidence,
    };

    this.emit('round-complete', roundInfo);

    for (const listener of this.roundCompleteListeners) {
      try {
        listener(roundId, crashPoint || 0);
      } catch (err) {
        this.logger.warn({ component: 'RoundObserver', error: String(err) }, 'Round complete listener error');
      }
    }
  }

  private async handleRoundEnded(event: NormalizedGameEvent): Promise<void> {
    // Round ended means we're back to idle/starting
    if (this.currentState.phase === 'crashed') {
      // Stay in crashed briefly, then transition
      setTimeout(() => {
        this.updateState({
          ...this.currentState,
          phase: 'idle',
          currentMultiplier: null,
          source: event.source,
          confidence: 'low',
        });
      }, 1000);
    }
  }

  private async handleStateChange(event: NormalizedGameEvent): Promise<void> {
    if (event.phase && event.phase !== this.currentState.phase) {
      const newState: RoundState = {
        ...this.currentState,
        phase: event.phase,
        source: event.source,
        confidence: this.calculateConfidence(event),
      };
      this.updateState(newState);
    }
  }

  private updateState(newState: RoundState): void {
    const changed =
      newState.phase !== this.currentState.phase ||
      newState.roundId !== this.currentState.roundId ||
      newState.currentMultiplier !== this.currentState.currentMultiplier ||
      newState.crashPoint !== this.currentState.crashPoint ||
      newState.confidence !== this.currentState.confidence;

    if (changed) {
      this.currentState = newState;
      this.lastStateChangeAt = Date.now();

      // Notify state change listeners
      for (const listener of this.stateListeners) {
        try {
          listener({ ...newState });
        } catch (err) {
          this.logger.warn({ component: 'RoundObserver', error: String(err) }, 'State change listener error');
        }
      }

      this.emit('state-change', { ...newState });
    }
  }

  private calculateConfidence(event: NormalizedGameEvent): ObservationConfidence {
    // P0.4 / P1.5: confidence factors in source type, latency, and multi-source agreement.
    // High confidence requires a known non-DOM-only source (or multi-source) AND low latency.
    const latency = event.latencyMs ?? Number.POSITIVE_INFINITY;
    const source = event.source || 'unknown';
    const isKnownSource = source !== 'unknown';
    // Prefer WS / API over pure DOM for high confidence
    const isStrongSource = source === 'websocket' || source === 'api';
    const eventSources = (event as { sources?: string[] }).sources;
    const isMulti = Array.isArray(eventSources) && eventSources.length >= 2;

    if (isKnownSource && (isStrongSource || isMulti) && latency < CONFIDENCE_THRESHOLDS.high.maxLatencyMs) {
      return 'high';
    }

    // Medium: known source with moderate latency, or pure DOM with excellent latency
    if (isKnownSource && latency < CONFIDENCE_THRESHOLDS.medium.maxLatencyMs) {
      return 'medium';
    }

    if (isKnownSource && latency < CONFIDENCE_THRESHOLDS.high.maxLatencyMs * 2) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Check if the current multiplier data is stale (no ticks received recently).
   */
  isStale(): boolean {
    if (this.currentState.phase !== 'running') {
      return false; // Only running rounds can have stale multipliers
    }

    if (!this.currentState.lastTickAt) {
      return true; // No ticks received yet
    }

    const elapsed = Date.now() - new Date(this.currentState.lastTickAt).getTime();
    return elapsed > this.options.staleThresholdMs;
  }

  /**
   * Get the current confidence level.
   */
  getConfidence(): ObservationConfidence {
    if (this.isStale()) {
      return 'low';
    }
    return this.currentState.confidence;
  }

  /**
   * Check if the current state is suitable for betting (high confidence, not stale).
   */
  isValidForObservation(): boolean {
    if (!this.started) return false;
    if (this.isStale()) return false;

    const confidenceOrder: Record<ObservationConfidence, number> = {
      high: 3,
      medium: 2,
      low: 1,
    };

    const required = confidenceOrder[this.options.minConfidenceForEntry];
    const current = confidenceOrder[this.currentState.confidence];

    return current >= required;
  }

  getCurrentState(): RoundState {
    return { ...this.currentState };
  }

  getTickHistory(): Array<{ multiplier: number; timestamp: string; latencyMs: number }> {
    return [...this.tickHistory];
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

  isRunning(): boolean {
    return this.started;
  }

  getLastStateChangeAgeMs(): number {
    return Date.now() - this.lastStateChangeAt;
  }
}
