import { EventEmitter } from 'events';
import { RoundState, ObservationSource, ObservationConfidence } from '../../types/game';
import {
  NormalizedGameEvent,
  GameAdapterListener,
  AggregatedObservation,
  SourceConflict,
  SourceSnapshot,
} from '../types';
import { DOMAdapter } from './dom-adapter';
import { WSInterceptor } from './ws-interceptor';
import { APIAdapter } from './api-adapter';
import { CONFIDENCE_THRESHOLDS, STALE_CONFIG } from '../constants';
import { getLogger } from '../../observability/logger';

export interface AggregatorOptions {
  domAdapter?: DOMAdapter;
  wsAdapter?: WSInterceptor;
  apiAdapter?: APIAdapter;
  staleThresholdMs?: number;
}

interface SourceState {
  lastEventAt: number;
  lastSnapshot: SourceSnapshot | null;
  healthy: boolean;
  errorCount: number;
}

/**
 * Aggregator combines data from multiple observation sources (DOM, WebSocket, API)
 * and produces a single authoritative round state with confidence scoring.
 */
export class Aggregator extends EventEmitter {
  private readonly options: AggregatorOptions;
  private readonly logger = getLogger();
  private started = false;
  private gameListeners: GameAdapterListener[] = [];
  private sourceStates: Map<ObservationSource, SourceState> = new Map();
  private currentObservation: AggregatedObservation;
  private unsubscribeFns: Array<() => void> = [];
  private conflictHistory: SourceConflict[] = [];
  private eventCount = 0;

  constructor(options: AggregatorOptions = {}) {
    super();
    this.options = {
      staleThresholdMs: options.staleThresholdMs ?? STALE_CONFIG.multiplierMaxAgeMs,
      domAdapter: options.domAdapter,
      wsAdapter: options.wsAdapter,
      apiAdapter: options.apiAdapter,
    };

    this.currentObservation = this.createInitialObservation();

    const sources: ObservationSource[] = ['dom', 'websocket', 'api'];
    for (const source of sources) {
      this.sourceStates.set(source, {
        lastEventAt: 0,
        lastSnapshot: null,
        healthy: false,
        errorCount: 0,
      });
    }
  }

  private createInitialObservation(): AggregatedObservation {
    return {
      roundId: null,
      multiplier: null,
      phase: 'idle',
      crashPoint: null,
      confidence: 'low',
      sources: [],
      timestamp: new Date().toISOString(),
      latencyMs: 0,
      conflicts: [],
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.info({ component: 'Aggregator' }, 'Starting aggregator');

    if (this.options.domAdapter) {
      const unsub = this.options.domAdapter.onEvent((event) => this.handleSourceEvent('dom', event));
      this.unsubscribeFns.push(unsub);
    }

    if (this.options.wsAdapter) {
      const unsub = this.options.wsAdapter.onEvent((event) => this.handleSourceEvent('websocket', event));
      this.unsubscribeFns.push(unsub);
    }

    if (this.options.apiAdapter) {
      const unsub = this.options.apiAdapter.onEvent((event) => this.handleSourceEvent('api', event));
      this.unsubscribeFns.push(unsub);
    }
  }

  async stop(): Promise<void> {
    this.logger.info({ component: 'Aggregator' }, 'Stopping aggregator');
    this.started = false;

    for (const unsub of this.unsubscribeFns) {
      unsub();
    }
    this.unsubscribeFns = [];

    this.removeAllListeners();
    this.gameListeners = [];
  }

  private async handleSourceEvent(src: ObservationSource, event: NormalizedGameEvent): Promise<void> {
    if (!this.started) return;

    this.eventCount++;

    const state = this.sourceStates.get(src);
    if (!state) return;

    state.lastEventAt = Date.now();
    state.healthy = true;

    const snapshot: SourceSnapshot = {
      source: src,
      roundId: event.roundId,
      multiplier: event.multiplier,
      phase: event.phase,
      crashPoint: event.crashPoint,
      timestamp: event.timestamp,
      latencyMs: event.latencyMs,
      healthy: true,
    };

    state.lastSnapshot = snapshot;

    const observation = this.aggregateObservations();
    this.currentObservation = observation;

    const aggregatedEvent: NormalizedGameEvent = {
      type: event.type,
      roundId: observation.roundId,
      multiplier: observation.multiplier,
      crashPoint: observation.crashPoint,
      phase: observation.phase,
      source: observation.sources.length > 0 ? observation.sources[0] : 'unknown',
      confidence: observation.confidence,
      timestamp: observation.timestamp,
      latencyMs: observation.latencyMs,
      rawPayload: {
        aggregated: true,
        sources: observation.sources,
        conflicts: observation.conflicts,
        originalEvent: event,
      },
    };

    (super.emit as any)('event', aggregatedEvent);

    for (const listener of this.gameListeners) {
      try {
        await listener(aggregatedEvent);
      } catch (err) {
        this.logger.warn({ component: 'Aggregator', error: String(err) }, 'Listener error');
      }
    }
  }

  private aggregateObservations(): AggregatedObservation {
    const now = Date.now();
    const snapshots: SourceSnapshot[] = [];

    for (const [_source, state] of this.sourceStates) {
      if (state.lastSnapshot && now - state.lastEventAt < (this.options.staleThresholdMs ?? 2000) * 2) {
        snapshots.push(state.lastSnapshot);
      }
    }

    if (snapshots.length === 0) {
      return {
        ...this.currentObservation,
        confidence: 'low',
        sources: [],
        timestamp: new Date().toISOString(),
      };
    }

    const priority: ObservationSource[] = ['websocket', 'dom', 'api'];
    const sortedSnapshots = [...snapshots].sort((a, b) => {
      const aPriority = priority.indexOf(a.source);
      const bPriority = priority.indexOf(b.source);
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.latencyMs - b.latencyMs;
    });

    const primary = sortedSnapshots[0];
    const conflicts = this.detectConflicts(snapshots);

    if (conflicts.length > 0) {
      this.conflictHistory.push(...conflicts);
      if (this.conflictHistory.length > 50) {
        this.conflictHistory = this.conflictHistory.slice(-50);
      }
    }

    const confidence = this.calculateConfidence(sortedSnapshots, conflicts);
    const avgLatency = Math.round(
      snapshots.reduce((sum, s) => sum + s.latencyMs, 0) / snapshots.length
    );

    return {
      roundId: primary.roundId,
      multiplier: primary.multiplier,
      phase: primary.phase || 'idle',
      crashPoint: primary.crashPoint,
      confidence,
      sources: snapshots.map((s) => s.source),
      timestamp: new Date().toISOString(),
      latencyMs: avgLatency,
      conflicts,
    };
  }

  private detectConflicts(snapshots: SourceSnapshot[]): SourceConflict[] {
    const conflicts: SourceConflict[] = [];

    for (let i = 0; i < snapshots.length; i++) {
      for (let j = i + 1; j < snapshots.length; j++) {
        const a = snapshots[i];
        const b = snapshots[j];

        if (a.roundId && b.roundId && a.roundId !== b.roundId) {
          conflicts.push({ sources: [a.source, b.source], field: 'roundId', values: [a.roundId, b.roundId] });
        }

        if (a.multiplier !== null && b.multiplier !== null && Math.abs(a.multiplier - b.multiplier) > 0.01) {
          conflicts.push({ sources: [a.source, b.source], field: 'multiplier', values: [a.multiplier, b.multiplier] });
        }

        if (a.phase && b.phase && a.phase !== b.phase && a.phase !== 'unknown' && b.phase !== 'unknown') {
          conflicts.push({ sources: [a.source, b.source], field: 'phase', values: [a.phase, b.phase] });
        }

        if (a.crashPoint !== null && b.crashPoint !== null && Math.abs(a.crashPoint - b.crashPoint) > 0.01) {
          conflicts.push({ sources: [a.source, b.source], field: 'crashPoint', values: [a.crashPoint, b.crashPoint] });
        }
      }
    }

    return conflicts;
  }

  private calculateConfidence(snapshots: SourceSnapshot[], conflicts: SourceConflict[]): ObservationConfidence {
    const healthySources = snapshots.filter((s) => s.healthy).length;
    const avgLatency = snapshots.length > 0 ? snapshots.reduce((sum, s) => sum + s.latencyMs, 0) / snapshots.length : Infinity;

    if (healthySources >= CONFIDENCE_THRESHOLDS.high.minAgreeingSources && avgLatency < CONFIDENCE_THRESHOLDS.high.maxLatencyMs && conflicts.length <= CONFIDENCE_THRESHOLDS.high.maxConflictScore) {
      return 'high';
    }

    if (healthySources >= CONFIDENCE_THRESHOLDS.medium.minAgreeingSources && avgLatency < CONFIDENCE_THRESHOLDS.medium.maxLatencyMs && conflicts.length <= CONFIDENCE_THRESHOLDS.medium.maxConflictScore) {
      return 'medium';
    }

    return 'low';
  }

  onEvent(listener: GameAdapterListener): () => void {
    this.gameListeners.push(listener);
    return () => {
      const idx = this.gameListeners.indexOf(listener);
      if (idx >= 0) this.gameListeners.splice(idx, 1);
    };
  }

  getCurrentObservation(): AggregatedObservation {
    return { ...this.currentObservation };
  }

  getSourceStates(): Map<ObservationSource, SourceState> {
    return new Map(this.sourceStates);
  }

  getConflictHistory(): SourceConflict[] {
    return [...this.conflictHistory];
  }

  getEventCount(): number {
    return this.eventCount;
  }

  isRunning(): boolean {
    return this.started;
  }

  toRoundState(): RoundState {
    const obs = this.currentObservation;
    return {
      roundId: obs.roundId,
      phase: obs.phase,
      currentMultiplier: obs.multiplier,
      startedAt: null,
      crashedAt: obs.phase === 'crashed' ? obs.timestamp : null,
      crashPoint: obs.crashPoint,
      lastTickAt: obs.timestamp,
      source: obs.sources.length > 0 ? obs.sources[0] : 'unknown',
      confidence: obs.confidence,
    };
  }
}
