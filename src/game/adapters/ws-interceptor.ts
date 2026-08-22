import { Page } from 'playwright';
import { NormalizedGameEvent, GameAdapterListener, AdapterHealth } from '../types';
import { RoundPhase } from '../../types/game';
import { WS_MESSAGE_TYPES, TIMEOUTS, PHASE_MAPPINGS } from '../constants';
import { getLogger } from '../../observability/logger';

export interface WSInterceptorOptions {
  page: Page;
  messageTypes?: string[];
  reconnectIntervalMs?: number;
}

interface WSMessage {
  type: string;
  payload: unknown;
  timestamp: number;
}

/**
 * WSInterceptor intercepts WebSocket messages from the BC.Game Crash game.
 * It injects a script into the page to override the WebSocket constructor,
 * capturing all incoming messages and dispatching them as custom DOM events
 * that Playwright can listen to.
 *
 * This adapter provides lower-latency observation than DOM polling when
 * WebSocket messages are available.
 */
export class WSInterceptor {
  private readonly options: Required<WSInterceptorOptions>;
  private readonly logger = getLogger();
  private started = false;
  private listeners: GameAdapterListener[] = [];
  private lastEventAt: string | null = null;
  private errorCount = 0;
  private consecutiveErrors = 0;
  private messageCount = 0;
  private latencyHistory: number[] = [];
  private currentRoundId: string | null = null;
  private pageEventHandler: ((data: { url: string; data: unknown; timestamp: number }) => void) | null = null;

  constructor(options: WSInterceptorOptions) {
    this.options = {
      messageTypes: Object.values(WS_MESSAGE_TYPES),
      reconnectIntervalMs: TIMEOUTS.wsReconnectInterval,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.info({ component: 'WSInterceptor' }, 'Starting WebSocket interceptor');

    // Inject the WebSocket interception script
    await this.injectInterceptor();

    // Set up listener for custom events from the page
    await this.setupPageListener();
  }

  async stop(): Promise<void> {
    this.logger.info({ component: 'WSInterceptor' }, 'Stopping WebSocket interceptor');
    this.started = false;

    // Remove page event listener
    if (this.pageEventHandler) {
      try {
        await this.options.page.evaluate(() => {
          window.removeEventListener('bc-game-ws-message', () => {});
        });
      } catch {
        // Ignore cleanup errors
      }
    }

    this.listeners = [];
  }

  private async injectInterceptor(): Promise<void> {
    try {
      await (this.options.page as any).evaluateOnNewDocument(() => {
        // Store original WebSocket
        const OriginalWebSocket = window.WebSocket;

        // Global registry for intercepted WS instances
        const wsRegistry: WebSocket[] = [];
        (window as unknown as Record<string, unknown>).__wsList = wsRegistry;

        // Override WebSocket constructor
        (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = class extends OriginalWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            wsRegistry.push(this);

            this.addEventListener('message', (event: MessageEvent) => {
              try {
                const data = JSON.parse(event.data);
                window.dispatchEvent(
                  new CustomEvent('bc-game-ws-message', {
                    detail: {
                      url: this.url,
                      data,
                      timestamp: Date.now(),
                    },
                  })
                );
              } catch {
                // Not JSON, ignore
              }
            });

            this.addEventListener('close', () => {
              const idx = wsRegistry.indexOf(this);
              if (idx >= 0) wsRegistry.splice(idx, 1);
            });

            this.addEventListener('error', () => {
              window.dispatchEvent(
                new CustomEvent('bc-game-ws-error', {
                  detail: { url: this.url, timestamp: Date.now() },
                })
              );
            });
          }
        };
      });
    } catch (error) {
      this.logger.error(
        { component: 'WSInterceptor', error: String(error) },
        'Failed to inject WebSocket interceptor'
      );
      throw error;
    }
  }

  private async setupPageListener(): Promise<void> {
    // Use page.evaluate to add a listener that sends messages back to Node
    // We use exposeFunction to create a bridge
    try {
      await (this.options.page as any).exposeFunction('__bcGameWsCallback', (detail: { url: string; data: unknown; timestamp: number }) => {
        this.handleWsMessage(detail).catch((err) => {
          this.logger.warn({ component: 'WSInterceptor', error: String(err) }, 'WS message handler error');
        });
      });

      await this.options.page.evaluate(() => {
        window.addEventListener('bc-game-ws-message', ((event: CustomEvent) => {
          const detail = event.detail as { url: string; data: unknown; timestamp: number };
          // @ts-expect-error - exposed function
          window.__bcGameWsCallback(detail);
        }) as EventListener);
      });
    } catch (error) {
      // exposeFunction might fail if already exposed
      this.logger.warn(
        { component: 'WSInterceptor', error: String(error) },
        'Page listener setup failed, will use fallback'
      );
    }
  }

  private async handleWsMessage(detail: { url: string; data: unknown; timestamp: number }): Promise<void> {
    if (!this.started) return;

    const latencyMs = Date.now() - detail.timestamp;
    this.recordLatency(latencyMs);
    this.messageCount++;

    try {
      const message = detail.data as WSMessage;

      // Check if this is a message type we care about
      if (!this.isRelevantMessage(message)) {
        return;
      }

      await this.processMessage(message, latencyMs);
      this.consecutiveErrors = 0;
    } catch (error) {
      this.handleError('message-processing', error);
    }
  }

  private isRelevantMessage(message: WSMessage): boolean {
    if (!message || typeof message !== 'object') return false;
    const msgType = (message.type || ((message as unknown) as Record<string, unknown>).event || '').toString();
    return this.options.messageTypes.some((t) => msgType.includes(t) || t.includes(msgType));
  }

  private async processMessage(message: WSMessage, latencyMs: number): Promise<void> {
    const timestamp = new Date().toISOString();
    const msgType = (message.type || ((message as unknown) as Record<string, unknown>).event || '').toString();
    const payload = message.payload || message;

    // Map WS message types to game events
    if (msgType.includes('start') || msgType.includes('round:start')) {
      const roundId = this.extractRoundId(payload);
      const multiplier = this.extractMultiplier(payload);

      if (roundId) {
        this.currentRoundId = roundId;
      }

      await this.emit({
        type: 'round-started',
        roundId: roundId || this.currentRoundId,
        multiplier: multiplier || 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'websocket',
        confidence: 'high',
        timestamp,
        latencyMs,
        rawPayload: payload,
      });
    } else if (msgType.includes('tick') || msgType.includes('update')) {
      const roundId = this.extractRoundId(payload);
      const multiplier = this.extractMultiplier(payload);

      if (roundId) {
        this.currentRoundId = roundId;
      }

      if (multiplier !== null) {
        await this.emit({
          type: 'multiplier-tick',
          roundId: roundId || this.currentRoundId,
          multiplier,
          crashPoint: null,
          phase: 'running',
          source: 'websocket',
          confidence: 'high',
          timestamp,
          latencyMs,
          rawPayload: payload,
        });
      }
    } else if (msgType.includes('crash') || msgType.includes('end')) {
      const roundId = this.extractRoundId(payload);
      const crashPoint = this.extractMultiplier(payload);

      if (roundId) {
        this.currentRoundId = roundId;
      }

      await this.emit({
        type: 'round-crashed',
        roundId: roundId || this.currentRoundId,
        multiplier: crashPoint,
        crashPoint,
        phase: 'crashed',
        source: 'websocket',
        confidence: crashPoint ? 'high' : 'medium',
        timestamp,
        latencyMs,
        rawPayload: payload,
      });
    } else if (msgType.includes('state') || msgType.includes('phase')) {
      const phase = this.extractPhase(payload);

      await this.emit({
        type: 'game-state-change',
        roundId: this.currentRoundId,
        multiplier: null,
        crashPoint: null,
        phase,
        source: 'websocket',
        confidence: 'high',
        timestamp,
        latencyMs,
        rawPayload: payload,
      });
    }
  }

  private extractRoundId(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as unknown as Record<string, unknown>;

    const candidates = [
      p.roundId,
      p.round_id,
      p.id,
      p.gameId,
      p.game_id,
      p.hash,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length >= 4) {
        return candidate;
      }
    }

    return null;
  }

  private extractMultiplier(payload: unknown): number | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as unknown as Record<string, unknown>;

    const candidates = [
      p.multiplier,
      p.currentMultiplier,
      p.current_multiplier,
      p.value,
      p.crashPoint,
      p.crash_point,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'number') {
        if (candidate >= 1.0 && candidate < 100000) {
          return candidate;
        }
      }
      if (typeof candidate === 'string') {
        const val = parseFloat(candidate);
        if (!isNaN(val) && val >= 1.0 && val < 100000) {
          return val;
        }
      }
    }

    return null;
  }

  private extractPhase(payload: unknown): RoundPhase {
    if (!payload || typeof payload !== 'object') return 'unknown';
    const p = payload as unknown as Record<string, unknown>;

    const phaseStr =
      typeof p.phase === 'string' ? p.phase :
      typeof p.state === 'string' ? p.state :
      typeof p.status === 'string' ? p.status :
      'unknown';

    return PHASE_MAPPINGS[phaseStr.toLowerCase()] || 'unknown';
  }

  private async emit(event: NormalizedGameEvent): Promise<void> {
    this.lastEventAt = event.timestamp;

    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (err) {
        this.logger.warn({ component: 'WSInterceptor', error: String(err) }, 'Listener error');
      }
    }
  }

  private handleError(context: string, error: unknown): void {
    this.errorCount++;
    this.consecutiveErrors++;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn({ component: 'WSInterceptor', context, error: message }, 'WS interceptor error');
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
      source: 'websocket',
      healthy: this.started && this.consecutiveErrors < 5 && this.messageCount > 0,
      lastEventAt: this.lastEventAt,
      errorCount: this.errorCount,
      consecutiveErrors: this.consecutiveErrors,
      latencyAvgMs: Math.round(avgLatency),
    };
  }

  isRunning(): boolean {
    return this.started;
  }

  getMessageCount(): number {
    return this.messageCount;
  }
}
