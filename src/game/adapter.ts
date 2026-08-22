import { EventEmitter } from 'events';
import { Page } from 'playwright';
import { RoundState, RoundPhase } from '../types/game';
import {
  IGameAdapter,
  NormalizedGameEvent,
  GameAdapterListener,
  AdapterHealth,
  SourceSnapshot,
} from './types';
import { DOM_SELECTORS, TIMEOUTS } from './constants';
import { getLogger } from '../observability/logger';
import { withTimeout } from '../utils/async';

export interface GameAdapterOptions {
  page: Page;
  enableDomAdapter?: boolean;
  enableWsAdapter?: boolean;
  enableApiAdapter?: boolean;
  pollIntervalMs?: number;
}

/**
 * GameAdapter is the unified interface that abstracts BC.Game Crash-specific behavior.
 * It combines DOM observation, WebSocket interception, and API polling into a single
 * normalized event stream.
 *
 * For Batch 2 (observe-only), it focuses on:
 * - Detecting when the Crash game is loaded
 * - Detecting round state changes
 * - Extracting current multiplier
 * - Capturing crash points
 * - Emitting normalized events
 */
export class GameAdapter extends EventEmitter implements IGameAdapter {
  private readonly options: Required<GameAdapterOptions>;
  private readonly logger = getLogger();
  private started = false;
  private currentState: RoundState;
  private gameListeners: GameAdapterListener[] = [];
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private errorCount = 0;
  private consecutiveErrors = 0;
  private lastEventAt: string | null = null;
  private latencyHistory: number[] = [];

  constructor(options: GameAdapterOptions) {
    super();
    this.options = {
      enableDomAdapter: true,
      // Multi-source observation enabled by default (P0.4). Feature flags can still disable.
      enableWsAdapter: true,
      enableApiAdapter: true,
      pollIntervalMs: TIMEOUTS.domAdapterPollInterval,
      ...options,
    };

    this.currentState = this.createInitialState();
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
      this.logger.debug({ component: 'GameAdapter' }, 'Adapter already started');
      return;
    }

    this.logger.info({ component: 'GameAdapter' }, 'Starting game adapter');
    this.started = true;

    // Set up DOM polling as the primary observation method for Batch 2
    if (this.options.enableDomAdapter) {
      this.startDomPolling();
    }

    // Set up WebSocket interception if enabled
    if (this.options.enableWsAdapter) {
      await this.setupWsInterception();
    }

    // Verify game is loaded
    await this.verifyGameLoaded();
  }

  async stop(): Promise<void> {
    this.logger.info({ component: 'GameAdapter' }, 'Stopping game adapter');
    this.started = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.removeAllListeners();
    this.gameListeners = [];
  }

  private startDomPolling(): void {
    this.pollInterval = setInterval(async () => {
      if (!this.started) return;
      try {
        await this.pollDomState();
      } catch (error) {
        this.handleError('DOM poll error', error);
      }
    }, this.options.pollIntervalMs);
  }

  private async pollDomState(): Promise<void> {
    const pollStart = Date.now();

    const state = await this.options.page.evaluate((selectors) => {
      // Helper to safely get text content
      const getText = (sel: string): string | null => {
        const el = document.querySelector(sel);
        return el ? el.textContent?.trim() || null : null;
      };

      // Helper to check if element exists
      const exists = (sel: string): boolean => !!document.querySelector(sel);

      // Determine phase from DOM
      let phase: string = 'unknown';
      if (exists(selectors.phaseRunning)) phase = 'running';
      else if (exists(selectors.phaseCrashed)) phase = 'crashed';
      else if (exists(selectors.phaseStarting)) phase = 'starting';
      else if (exists(selectors.gameContainer)) phase = 'idle';

      // Extract multiplier
      let multiplier: number | null = null;
      const multiplierText = getText(selectors.multiplierDisplay) || getText(selectors.multiplierValue);
      if (multiplierText) {
        const match = multiplierText.match(/(?:x\s*)?(\d+\.?\d*)\s*(?:x|X)?/);
        if (match) {
          const val = parseFloat(match[1]);
          if (val >= 1.0 && val < 100000) {
            multiplier = val;
          }
        }
      }

      // Extract round ID
      let roundId: string | null = null;
      const roundIdText = getText(selectors.roundIdDisplay);
      if (roundIdText) {
        const match = roundIdText.match(/[#]?([A-Za-z0-9\-_]{4,32})/);
        if (match) roundId = match[1];
      }

      // Extract crash point
      let crashPoint: number | null = null;
      const crashText = getText(selectors.crashPoint) || getText(selectors.crashResult);
      if (crashText && phase === 'crashed') {
        const match = crashText.match(/(?:x\s*)?(\d+\.?\d*)\s*(?:x|X)?/);
        if (match) {
          const val = parseFloat(match[1]);
          if (val >= 1.0 && val < 100000) {
            crashPoint = val;
          }
        }
      }

      // Check if game container exists
      const gameLoaded = exists(selectors.gameContainer);

      return {
        phase,
        multiplier,
        roundId,
        crashPoint,
        gameLoaded,
        timestamp: Date.now(),
      };
    }, DOM_SELECTORS);

    const latencyMs = Date.now() - pollStart;
    this.recordLatency(latencyMs);

    if (!state.gameLoaded) {
      // Game not loaded yet, don't emit events
      return;
    }

    // Map phase
    const phase = this.mapPhase(state.phase);

    // Detect state changes and emit events
    await this.processStateChange({
      roundId: state.roundId,
      phase,
      multiplier: state.multiplier,
      crashPoint: state.crashPoint,
      timestamp: new Date(state.timestamp).toISOString(),
      latencyMs,
      source: 'dom',
      healthy: true,
    });
  }

  private mapPhase(phaseStr: string): RoundPhase {
    const mapping: Record<string, RoundPhase> = {
      idle: 'idle',
      starting: 'starting',
      run: 'running',
      running: 'running',
      active: 'running',
      crash: 'crashed',
      crashed: 'crashed',
      end: 'crashed',
      ended: 'crashed',
      unknown: 'unknown',
    };
    return mapping[phaseStr.toLowerCase()] || 'unknown';
  }

  private async processStateChange(snapshot: SourceSnapshot): Promise<void> {
    const prevState = { ...this.currentState };
    let stateChanged = false;
    let eventEmitted = false;

    // Detect round start
    if (
      (prevState.phase === 'idle' || prevState.phase === 'starting' || prevState.phase === 'crashed') &&
      snapshot.phase === 'running' &&
      snapshot.roundId
    ) {
      this.currentState = {
        ...this.currentState,
        roundId: snapshot.roundId,
        phase: 'running',
        currentMultiplier: snapshot.multiplier || 1.0,
        startedAt: snapshot.timestamp,
        crashedAt: null,
        crashPoint: null,
        lastTickAt: snapshot.timestamp,
        source: snapshot.source,
        confidence: 'high',
      };
      stateChanged = true;
      this.tickCount = 0;

      await this.emitGameEvent({
        type: 'round-started',
        roundId: snapshot.roundId,
        multiplier: snapshot.multiplier || 1.0,
        crashPoint: null,
        phase: 'running',
        source: snapshot.source,
        confidence: 'high',
        timestamp: snapshot.timestamp,
        latencyMs: snapshot.latencyMs,
      });
      eventEmitted = true;
    }

    // Detect multiplier tick during running phase
    if (snapshot.phase === 'running' && snapshot.multiplier !== null) {
      const multiplierChanged =
        this.currentState.currentMultiplier === null ||
        Math.abs(this.currentState.currentMultiplier - snapshot.multiplier) > 0.001;

      if (multiplierChanged) {
        this.currentState = {
          ...this.currentState,
          currentMultiplier: snapshot.multiplier,
          lastTickAt: snapshot.timestamp,
          source: snapshot.source,
          confidence: 'high',
        };
        this.tickCount++;

        if (!eventEmitted) {
          await this.emitGameEvent({
            type: 'multiplier-tick',
            roundId: this.currentState.roundId,
            multiplier: snapshot.multiplier,
            crashPoint: null,
            phase: 'running',
            source: snapshot.source,
            confidence: 'high',
            timestamp: snapshot.timestamp,
            latencyMs: snapshot.latencyMs,
          });
          eventEmitted = true;
        }
      }
    }

    // Detect crash
    if (
      (prevState.phase === 'running' || prevState.phase === 'starting') &&
      snapshot.phase === 'crashed'
    ) {
      this.currentState = {
        ...this.currentState,
        phase: 'crashed',
        crashedAt: snapshot.timestamp,
        crashPoint: snapshot.crashPoint || prevState.currentMultiplier,
        currentMultiplier: snapshot.crashPoint || prevState.currentMultiplier,
        lastTickAt: snapshot.timestamp,
        source: snapshot.source,
        confidence: snapshot.crashPoint ? 'high' : 'medium',
      };
      stateChanged = true;

      await this.emitGameEvent({
        type: 'round-crashed',
        roundId: this.currentState.roundId,
        multiplier: this.currentState.crashPoint,
        crashPoint: this.currentState.crashPoint,
        phase: 'crashed',
        source: snapshot.source,
        confidence: this.currentState.confidence,
        timestamp: snapshot.timestamp,
        latencyMs: snapshot.latencyMs,
      });
      eventEmitted = true;
    }

    // Detect new round starting after crash (phase goes idle/starting)
    if (prevState.phase === 'crashed' && (snapshot.phase === 'idle' || snapshot.phase === 'starting')) {
      this.currentState = {
        ...this.currentState,
        phase: snapshot.phase,
        currentMultiplier: null,
        source: snapshot.source,
        confidence: 'medium',
      };
      stateChanged = true;
    }

    // Update source and confidence for minor changes
    if (!stateChanged && snapshot.phase && snapshot.phase !== prevState.phase) {
      this.currentState = {
        ...this.currentState,
        phase: snapshot.phase,
        source: snapshot.source,
      };
    }

    // Reset error count on successful poll
    if (this.consecutiveErrors > 0) {
      this.consecutiveErrors = 0;
    }

    // Emit state change event if phase changed but no specific event was emitted
    if (stateChanged && !eventEmitted) {
      await this.emitGameEvent({
        type: 'game-state-change',
        roundId: this.currentState.roundId,
        multiplier: this.currentState.currentMultiplier,
        crashPoint: this.currentState.crashPoint,
        phase: this.currentState.phase,
        source: snapshot.source,
        confidence: this.currentState.confidence,
        timestamp: snapshot.timestamp,
        latencyMs: snapshot.latencyMs,
      });
    }
  }

  private async setupWsInterception(): Promise<void> {
    // WebSocket interception is set up via page.evaluate
    // This injects a script that intercepts WebSocket messages
    try {
      await (this.options.page as any).evaluateOnNewDocument(() => {
        // Store original WebSocket
        const OriginalWebSocket = window.WebSocket;

        // Create a global registry for intercepted WS instances
        (window as unknown as Record<string, unknown>).__wsList = [];

        // Override WebSocket constructor
        (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = class extends OriginalWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);

            // Register this instance
            const wsList = ((window as unknown as Record<string, unknown>).__wsList as WebSocket[]) || [];
            wsList.push(this);
            (window as unknown as Record<string, unknown>).__wsList = wsList;

            // Intercept incoming messages
            this.addEventListener('message', (event) => {
              try {
                const data = JSON.parse(event.data);
                // Dispatch a custom event that Playwright can listen to
                window.dispatchEvent(
                  new CustomEvent('bc-game-ws-message', {
                    detail: { url: this.url, data, timestamp: Date.now() },
                  })
                );
              } catch {
                // Not JSON, ignore
              }
            });
          }
        };
      });

      // Listen for custom events from the page
      this.options.page.on('console', (msg) => {
        // We could also listen for console messages here
        if (msg.type() === 'error') {
          this.logger.debug({ component: 'GameAdapter', wsError: msg.text() }, 'WS console error');
        }
      });

      this.logger.info({ component: 'GameAdapter' }, 'WebSocket interception set up');
    } catch (error) {
      this.logger.warn(
        { component: 'GameAdapter', error: String(error) },
        'Failed to set up WebSocket interception'
      );
    }
  }

  private async verifyGameLoaded(): Promise<void> {
    try {
      await withTimeout(
        this.options.page.waitForSelector(DOM_SELECTORS.gameContainer, {
          timeout: TIMEOUTS.gameLoad,
          state: 'attached',
        }),
        TIMEOUTS.gameLoad,
        'Game container not found'
      );
      this.logger.info({ component: 'GameAdapter' }, 'Crash game loaded and verified');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { component: 'GameAdapter', error: message },
        'Could not verify game load - will continue polling'
      );
      // Don't throw - the adapter will keep trying
    }
  }

  private async emitGameEvent(event: NormalizedGameEvent): Promise<void> {
    this.lastEventAt = event.timestamp;

    // Emit via EventEmitter for internal use
    this.emit(event.type, event);
    this.emit('event', event);

    // Call registered listeners
    for (const listener of this.gameListeners) {
      try {
        await listener(event);
      } catch (err) {
        this.logger.warn(
          { component: 'GameAdapter', error: String(err) },
          'Game adapter listener error'
        );
      }
    }
  }

  private handleError(context: string, error: unknown): void {
    this.errorCount++;
    this.consecutiveErrors++;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn({ component: 'GameAdapter', context, error: message }, 'Adapter error');

    if (this.consecutiveErrors >= 5) {
      this.logger.error(
        { component: 'GameAdapter', consecutiveErrors: this.consecutiveErrors },
        'Too many consecutive adapter errors'
      );
    }
  }

  private recordLatency(latencyMs: number): void {
    this.latencyHistory.push(latencyMs);
    if (this.latencyHistory.length > 100) {
      this.latencyHistory.shift();
    }
  }

  getCurrentState(): RoundState {
    return { ...this.currentState };
  }

  onEvent(listener: GameAdapterListener): () => void {
    this.gameListeners.push(listener);
    return () => {
      const idx = this.gameListeners.indexOf(listener);
      if (idx >= 0) this.gameListeners.splice(idx, 1);
    };
  }

  getHealth(): AdapterHealth {
    const avgLatency =
      this.latencyHistory.length > 0
        ? this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length
        : 0;

    const healthy =
      this.started &&
      this.consecutiveErrors < 5 &&
      avgLatency < 1000;

    return {
      source: 'dom',
      healthy,
      lastEventAt: this.lastEventAt,
      errorCount: this.errorCount,
      consecutiveErrors: this.consecutiveErrors,
      latencyAvgMs: Math.round(avgLatency),
    };
  }

  isRunning(): boolean {
    return this.started;
  }

  getTickCount(): number {
    return this.tickCount;
  }
}
