import { EventEmitter } from 'events';
import { BrowserManager } from '../browser/manager';
import { GameAdapter } from '../game/adapter';
import { RoundObserver } from '../game/observer';
import { SessionRepository } from '../persistence/repositories/session-repo';
import { RoundRepository } from '../persistence/repositories/round-repo';
import { TickRepository } from '../persistence/repositories/tick-repo';
import { EventBus } from './event-bus/bus';
import { createEvent } from './event-bus/events';
import { AppConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { CriticalError } from '../utils/errors';
import { RoundState } from '../types/game';

export type SystemMode = 'observe-only' | 'dry-run' | 'live' | 'maintenance';

export interface OrchestratorOptions {
  config: AppConfig;
  browserManager: BrowserManager;
  gameAdapter: GameAdapter;
  roundObserver: RoundObserver;
  sessionRepo: SessionRepository;
  roundRepo: RoundRepository;
  tickRepo: TickRepository;
  eventBus: EventBus;
}

export interface OrchestratorState {
  mode: SystemMode;
  running: boolean;
  sessionId: string | null;
  currentRoundId: string | null;
  roundsObserved: number;
  ticksRecorded: number;
  errors: number;
  startedAt: string | null;
}

/**
 * Orchestrator is the main loop that wires together all components:
 * browser -> game adapter -> observer -> persistence.
 *
 * For Batch 2 (observe-only mode), it:
 * - Starts the browser and navigates to the Crash game
 * - Starts the game adapter and round observer
 * - Listens for round events and persists them
 * - Records multiplier ticks to TimescaleDB
 * - Emits system events via the event bus
 * - Runs until explicitly stopped
 */
export class Orchestrator extends EventEmitter {
  private readonly options: OrchestratorOptions;
  private readonly logger = getLogger();
  private state: OrchestratorState;
  private unsubscribeObserver: (() => void) | null = null;
  private unsubscribeRoundComplete: (() => void) | null = null;
  private mainLoopInterval: ReturnType<typeof setInterval> | null = null;
  private currentRoundId: string | null = null;
  private sessionId: string | null = null;

  constructor(options: OrchestratorOptions) {
    super();
    this.options = options;
    this.state = {
      mode: options.config.system.mode as SystemMode,
      running: false,
      sessionId: null,
      currentRoundId: null,
      roundsObserved: 0,
      ticksRecorded: 0,
      errors: 0,
      startedAt: null,
    };
  }

  async start(): Promise<void> {
    if (this.state.running) {
      this.logger.warn({ component: 'Orchestrator' }, 'Orchestrator already running');
      return;
    }

    this.logger.info(
      { component: 'Orchestrator', mode: this.state.mode },
      'Starting orchestrator'
    );

    try {
      // Create a session record
      const session = await this.options.sessionRepo.create({
        mode: this.state.mode,
        status: 'initializing',
        configVersion: 1,
        notes: 'Batch 2 observe-only session',
      });
      this.sessionId = session.id;
      this.state.sessionId = session.id;

      // Start the game adapter
      await this.options.gameAdapter.start();

      // Start the round observer
      await this.options.roundObserver.start();

      // Subscribe to observer events
      this.unsubscribeObserver = this.options.roundObserver.onStateChange((state) => {
        this.handleStateChange(state).catch((err) => {
          this.logger.error(
            { component: 'Orchestrator', error: String(err) },
            'State change handler error'
          );
        });
      });

      this.unsubscribeRoundComplete = this.options.roundObserver.onRoundComplete((roundId, crashPoint) => {
        this.handleRoundComplete(roundId, crashPoint).catch((err) => {
          this.logger.error(
            { component: 'Orchestrator', error: String(err) },
            'Round complete handler error'
          );
        });
      });

      // Subscribe to adapter events for tick recording
      this.options.gameAdapter.onEvent((event) => {
        this.handleAdapterEvent(event).catch((err) => {
          this.logger.error(
            { component: 'Orchestrator', error: String(err) },
            'Adapter event handler error'
          );
        });
      });

      // Update session status
      await this.options.sessionRepo.update(session.id, {
        status: 'observing',
      });

      this.state.running = true;
      this.state.startedAt = new Date().toISOString();

      // Emit system events
      await this.options.eventBus.emit(
        createEvent(
          'GameLoaded',
          { sessionId: session.id, url: 'https://bc.game/crash' },
          { correlationId: session.id, source: 'Orchestrator' }
        )
      );

      this.logger.info(
        { component: 'Orchestrator', sessionId: session.id },
        'Orchestrator started successfully'
      );

      this.emit('started', { sessionId: session.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'Orchestrator', error: message }, 'Failed to start orchestrator');
      this.state.errors++;
      throw new CriticalError(`Orchestrator start failed: ${message}`, 'ORCHESTRATOR_START_FAILED');
    }
  }

  async stop(): Promise<void> {
    if (!this.state.running) return;

    this.logger.info({ component: 'Orchestrator' }, 'Stopping orchestrator');
    this.state.running = false;

    // Unsubscribe from observer
    if (this.unsubscribeObserver) {
      this.unsubscribeObserver();
      this.unsubscribeObserver = null;
    }
    if (this.unsubscribeRoundComplete) {
      this.unsubscribeRoundComplete();
      this.unsubscribeRoundComplete = null;
    }

    // Stop game components
    try {
      await this.options.roundObserver.stop();
    } catch (err) {
      this.logger.warn({ component: 'Orchestrator', error: String(err) }, 'Error stopping observer');
    }

    try {
      await this.options.gameAdapter.stop();
    } catch (err) {
      this.logger.warn({ component: 'Orchestrator', error: String(err) }, 'Error stopping adapter');
    }

    // Update session status
    if (this.sessionId) {
      try {
        await this.options.sessionRepo.update(this.sessionId, {
          status: 'stopped',
          endedAt: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.warn({ component: 'Orchestrator', error: String(err) }, 'Error updating session');
      }
    }

    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
      this.mainLoopInterval = null;
    }

    this.logger.info(
      {
        component: 'Orchestrator',
        roundsObserved: this.state.roundsObserved,
        ticksRecorded: this.state.ticksRecorded,
      },
      'Orchestrator stopped'
    );

    this.emit('stopped', { stats: { ...this.state } });
  }

  private async handleStateChange(state: RoundState): Promise<void> {
    if (!this.state.running) return;

    // Detect round start
    if (state.phase === 'running' && state.roundId && state.roundId !== this.currentRoundId) {
      this.currentRoundId = state.roundId;
      this.state.currentRoundId = state.roundId;

      this.logger.info(
        {
          component: 'Orchestrator',
          roundId: state.roundId,
          confidence: state.confidence,
        },
        `New round detected: ${state.roundId}`
      );

      // Create round record
      if (this.sessionId) {
        try {
          await this.options.roundRepo.create({
            externalRoundId: state.roundId,
            sessionId: this.sessionId,
            startedAt: state.startedAt || new Date().toISOString(),
            observationSource: state.source,
            dataQuality: state.confidence,
          });
        } catch (err) {
          this.logger.warn(
            { component: 'Orchestrator', roundId: state.roundId, error: String(err) },
            'Failed to create round record'
          );
        }
      }

      // Emit event
      if (this.sessionId) {
        await this.options.eventBus.emit(
          createEvent(
            'RoundStarted',
            { roundId: state.roundId, sessionId: this.sessionId, startedAt: state.startedAt || new Date().toISOString() },
            { correlationId: state.roundId, source: 'Orchestrator' }
          )
        );
      }
    }
  }

  private async handleRoundComplete(roundId: string, crashPoint: number): Promise<void> {
    if (!this.state.running) return;

    this.state.roundsObserved++;
    this.currentRoundId = null;
    this.state.currentRoundId = null;

    this.logger.info(
      {
        component: 'Orchestrator',
        roundId,
        crashPoint,
        roundsObserved: this.state.roundsObserved,
      },
      `Round complete: ${roundId} crashed at ${crashPoint}x`
    );

    // Update round record with crash point
    try {
      const round = await this.options.roundRepo.findByExternalId(roundId);
      if (round) {
        await this.options.roundRepo.update(round.id, {
          crashedAt: new Date().toISOString(),
          observedCrashPoint: crashPoint,
          finalConfirmedCrashPoint: crashPoint,
          dataQuality: 'high',
        });
      }
    } catch (err) {
      this.logger.warn(
        { component: 'Orchestrator', roundId, error: String(err) },
        'Failed to update round with crash point'
      );
    }

    // Emit event
    if (this.sessionId) {
      await this.options.eventBus.emit(
        createEvent(
          'RoundCrashed',
          { roundId, crashPoint, crashedAt: new Date().toISOString() },
          { correlationId: roundId, source: 'Orchestrator' }
        )
      );
    }

    this.emit('round-complete', { roundId, crashPoint });
  }

  private async handleAdapterEvent(event: import('../game/types').NormalizedGameEvent): Promise<void> {
    if (!this.state.running) return;

    // Record multiplier ticks
    if (event.type === 'multiplier-tick' && event.roundId && event.multiplier !== null) {
      this.state.ticksRecorded++;

      if (this.sessionId) {
        try {
          await this.options.tickRepo.insert({
            roundId: event.roundId,
            multiplier: event.multiplier,
            observedAt: event.timestamp,
            source: event.source,
            latencyMs: event.latencyMs,
            sessionId: this.sessionId,
          });
        } catch (err) {
          this.logger.warn(
            { component: 'Orchestrator', roundId: event.roundId, error: String(err) },
            'Failed to record tick'
          );
        }
      }

      // Emit multiplier update event periodically (not every tick to avoid flooding)
      if (this.state.ticksRecorded % 10 === 0 && this.sessionId) {
        await this.options.eventBus.emit(
          createEvent(
            'MultiplierUpdated',
            { roundId: event.roundId, multiplier: event.multiplier, latencyMs: event.latencyMs },
            { correlationId: event.roundId, source: 'Orchestrator' }
          )
        );
      }
    }
  }

  getState(): Readonly<OrchestratorState> {
    return { ...this.state };
  }

  isRunning(): boolean {
    return this.state.running;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getCurrentRoundId(): string | null {
    return this.currentRoundId;
  }
}
