import { Page } from 'playwright';
import { RoundPhase } from '../../types/game';
import {
  NormalizedGameEvent,
  GameAdapterListener,
  AdapterHealth,
  SourceSnapshot,
} from '../types';
import { DOM_SELECTORS, TIMEOUTS, MULTIPLIER_PATTERNS, ROUND_ID_PATTERNS, PHASE_MAPPINGS } from '../constants';
import { getLogger } from '../../observability/logger';


export interface DOMAdapterOptions {
  page: Page;
  pollIntervalMs?: number;
  enableMutationObserver?: boolean;
}

/**
 * DOMAdapter observes the Crash game UI via DOM polling and optional MutationObserver.
 * It extracts multiplier values, round IDs, crash points, and phase information from
 * visible UI elements.
 *
 * This is the primary observation source for Batch 2 as it works without requiring
 * WebSocket or API access.
 */
export class DOMAdapter {
  private readonly options: Required<DOMAdapterOptions>;
  private readonly logger = getLogger();
  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: GameAdapterListener[] = [];
  private lastEventAt: string | null = null;
  private errorCount = 0;
  private consecutiveErrors = 0;
  private latencyHistory: number[] = [];
  private lastSnapshot: SourceSnapshot | null = null;
  private currentRoundId: string | null = null;
  private lastMultiplier: number | null = null;

  constructor(options: DOMAdapterOptions) {
    this.options = {
      pollIntervalMs: TIMEOUTS.domAdapterPollInterval,
      enableMutationObserver: false,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.info({ component: 'DOMAdapter' }, 'Starting DOM adapter');

    // Set up MutationObserver if enabled
    if (this.options.enableMutationObserver) {
      await this.setupMutationObserver();
    }

    // Start polling
    this.pollTimer = setInterval(() => {
      if (!this.started) return;
      this.poll().catch((err) => this.handleError('poll', err));
    }, this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.logger.info({ component: 'DOMAdapter' }, 'Stopping DOM adapter');
    this.started = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.listeners = [];
  }

  private async setupMutationObserver(): Promise<void> {
    try {
      await (this.options.page as any).evaluateOnNewDocument((selectors: any) => {
        window.addEventListener('DOMContentLoaded', () => {
          const container = document.querySelector(selectors.gameContainer);
          if (!container) return;

          const observer = new MutationObserver((mutations) => {
            const hasRelevantChange = mutations.some((m) => {
              const target = m.target as HTMLElement;
              return (
                target.matches?.(selectors.multiplierDisplay) ||
                target.closest?.(selectors.multiplierDisplay) ||
                target.matches?.(selectors.phaseRunning) ||
                target.matches?.(selectors.phaseCrashed) ||
                target.matches?.(selectors.crashResult)
              );
            });

            if (hasRelevantChange) {
              window.dispatchEvent(new CustomEvent('bc-dom-change', {
                detail: { timestamp: Date.now() },
              }));
            }
          });

          observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          });
        });
      }, DOM_SELECTORS);
    } catch (error) {
      this.logger.warn({ component: 'DOMAdapter', error: String(error) }, 'MutationObserver setup failed');
    }
  }

  private async poll(): Promise<void> {
    const pollStart = Date.now();

    try {
      const snapshot = await this.extractSnapshot();
      const latencyMs = Date.now() - pollStart;
      this.recordLatency(latencyMs);

      if (!snapshot) {
        // Game not loaded yet
        this.consecutiveErrors = 0;
        return;
      }

      // Detect and emit events based on state changes
      await this.processSnapshot({ ...snapshot, latencyMs });

      this.consecutiveErrors = 0;
    } catch (error) {
      this.handleError('poll', error);
    }
  }

  private async extractSnapshot(): Promise<Omit<SourceSnapshot, 'latencyMs'> | null> {
    return await this.options.page.evaluate(({ selectors, patterns }: { selectors: typeof DOM_SELECTORS; patterns: any }) => {
      // Check if game is loaded
      const gameContainer = document.querySelector(selectors.gameContainer || '');
      if (!gameContainer) {
        return null;
      }

      // Helper to get text content safely
      const getText = (sel: string): string | null => {
        const el = document.querySelector(sel);
        return el ? el.textContent?.trim() || null : null;
      };

      // Determine phase
      let phase: string = 'unknown';
      if (document.querySelector(selectors.phaseRunning)) phase = 'running';
      else if (document.querySelector(selectors.phaseCrashed)) phase = 'crashed';
      else if (document.querySelector(selectors.phaseStarting)) phase = 'starting';
      else if (gameContainer) phase = 'idle';

      // Extract multiplier
      let multiplier: number | null = null;
      const multiplierText = getText(selectors.multiplierDisplay) || getText(selectors.multiplierValue);
      if (multiplierText) {
        const match = multiplierText.match(new RegExp(patterns.multiplier));
        if (match) {
          const val = parseFloat(match[1]);
          if (val >= patterns.minMultiplier && val <= patterns.maxMultiplier) {
            multiplier = val;
          }
        }
      }

      // Extract round ID
      let roundId: string | null = null;
      const roundIdText = getText(selectors.roundIdDisplay);
      if (roundIdText) {
        const match = roundIdText.match(new RegExp(patterns.roundId));
        if (match) roundId = match[1];
      }

      // Extract crash point
      let crashPoint: number | null = null;
      if (phase === 'crashed') {
        const crashText = getText(selectors.crashPoint) || getText(selectors.crashResult);
        if (crashText) {
          const match = crashText.match(new RegExp(patterns.multiplier));
          if (match) {
            const val = parseFloat(match[1]);
            if (val >= patterns.minMultiplier && val <= patterns.maxMultiplier) {
              crashPoint = val;
            }
          }
        }
      }

      return {
        source: 'dom' as const,
        roundId,
        multiplier,
        phase: phase as RoundPhase,
        crashPoint,
        timestamp: new Date().toISOString(),
        healthy: true,
      };
    }, { selectors: DOM_SELECTORS, patterns: {
      multiplier: MULTIPLIER_PATTERNS.extract.source,
      minMultiplier: MULTIPLIER_PATTERNS.minimum,
      maxMultiplier: MULTIPLIER_PATTERNS.maximum,
      roundId: ROUND_ID_PATTERNS.extract.source,
    } });
  }

  private async processSnapshot(snapshot: SourceSnapshot): Promise<void> {
    const prev = this.lastSnapshot;
    this.lastSnapshot = snapshot;

    // Map string phase to RoundPhase
    const phase = snapshot.phase ? (PHASE_MAPPINGS[snapshot.phase] || snapshot.phase) : 'unknown';

    // Detect round start
    if (
      prev &&
      (prev.phase === 'idle' || prev.phase === 'starting' || prev.phase === 'crashed') &&
      phase === 'running' &&
      snapshot.roundId
    ) {
      this.currentRoundId = snapshot.roundId;
      this.lastMultiplier = snapshot.multiplier;

      await this.emit({
        type: 'round-started',
        roundId: snapshot.roundId,
        multiplier: snapshot.multiplier || 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: snapshot.timestamp,
        latencyMs: snapshot.latencyMs,
      });
      return;
    }

    // Detect multiplier tick
    if (phase === 'running' && snapshot.multiplier !== null) {
      const multiplierChanged =
        this.lastMultiplier === null ||
        Math.abs(this.lastMultiplier - snapshot.multiplier) > 0.001;

      if (multiplierChanged) {
        this.lastMultiplier = snapshot.multiplier;

        await this.emit({
          type: 'multiplier-tick',
          roundId: this.currentRoundId || snapshot.roundId,
          multiplier: snapshot.multiplier,
          crashPoint: null,
          phase: 'running',
          source: 'dom',
          confidence: 'high',
          timestamp: snapshot.timestamp,
          latencyMs: snapshot.latencyMs,
        });
      }
    }

    // Detect crash
    if (
      prev &&
      (prev.phase === 'running' || prev.phase === 'starting') &&
      phase === 'crashed'
    ) {
      const crashPoint = snapshot.crashPoint || this.lastMultiplier;

      await this.emit({
        type: 'round-crashed',
        roundId: this.currentRoundId || snapshot.roundId,
        multiplier: crashPoint,
        crashPoint,
        phase: 'crashed',
        source: 'dom',
        confidence: snapshot.crashPoint ? 'high' : 'medium',
        timestamp: snapshot.timestamp,
        latencyMs: snapshot.latencyMs,
      });

      this.lastMultiplier = null;
      return;
    }

    // Detect phase change to idle/starting after crash
    if (prev && prev.phase === 'crashed' && (phase === 'idle' || phase === 'starting')) {
      await this.emit({
        type: 'round-ended',
        roundId: this.currentRoundId || snapshot.roundId,
        multiplier: null,
        crashPoint: null,
        phase,
        source: 'dom',
        confidence: 'medium',
        timestamp: snapshot.timestamp,
        latencyMs: snapshot.latencyMs,
      });
    }

    // Detect game state change
    if (prev && prev.phase !== phase) {
      await this.emit({
        type: 'game-state-change',
        roundId: snapshot.roundId,
        multiplier: snapshot.multiplier,
        crashPoint: snapshot.crashPoint,
        phase,
        source: 'dom',
        confidence: 'medium',
        timestamp: snapshot.timestamp,
        latencyMs: snapshot.latencyMs,
      });
    }
  }

  private async emit(event: NormalizedGameEvent): Promise<void> {
    this.lastEventAt = event.timestamp;

    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (err) {
        this.logger.warn({ component: 'DOMAdapter', error: String(err) }, 'Listener error');
      }
    }
  }

  private handleError(context: string, error: unknown): void {
    this.errorCount++;
    this.consecutiveErrors++;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn({ component: 'DOMAdapter', context, error: message }, 'DOM adapter error');
  }

  private recordLatency(latencyMs: number): void {
    this.latencyHistory.push(latencyMs);
    if (this.latencyHistory.length > 100) {
      this.latencyHistory.shift();
    }
  }

  onEvent(listener: GameAdapterListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getHealth(): AdapterHealth {
    const avgLatency =
      this.latencyHistory.length > 0
        ? this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length
        : 0;

    return {
      source: 'dom',
      healthy: this.started && this.consecutiveErrors < 5 && avgLatency < 1000,
      lastEventAt: this.lastEventAt,
      errorCount: this.errorCount,
      consecutiveErrors: this.consecutiveErrors,
      latencyAvgMs: Math.round(avgLatency),
    };
  }

  isRunning(): boolean {
    return this.started;
  }

  getLastSnapshot(): SourceSnapshot | null {
    return this.lastSnapshot;
  }
}
