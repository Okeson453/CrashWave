import { Page } from 'playwright';
import { NormalizedGameEvent, GameAdapterListener, AdapterHealth } from '../types';
import { RoundPhase } from '../../types/game';
import { API_ENDPOINTS, TIMEOUTS } from '../constants';
import { getLogger } from '../../observability/logger';

const PHASE_MAPPINGS: Record<string, RoundPhase> = {
  idle: 'idle',
  waiting: 'idle',
  betting: 'starting',
  starting: 'starting',
  running: 'running',
  active: 'running',
  inprogress: 'running',
  crashed: 'crashed',
  crash: 'crashed',
  ended: 'crashed',
  complete: 'crashed',
  unknown: 'unknown',
};

export interface APIAdapterOptions {
  page: Page;
  baseUrl?: string;
  pollIntervalMs?: number;
  enableNetworkInterception?: boolean;
}



/**
 * APIAdapter polls HTTP APIs and intercepts network responses to observe
 * round history and current round state. It serves as a validation source
 * that can confirm crash points after rounds complete.
 *
 * For Batch 2, this adapter primarily:
 * - Polls for round history to confirm crash points
 * - Intercepts network responses for round data
 * - Provides authoritative crash point confirmation
 */
export class APIAdapter {
  private readonly options: Required<APIAdapterOptions>;
  private readonly logger = getLogger();
  private started = false;
  private listeners: GameAdapterListener[] = [];
  private lastEventAt: string | null = null;
  private errorCount = 0;
  private consecutiveErrors = 0;
  private latencyHistory: number[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private knownRoundIds: Set<string> = new Set();
  private currentRoundId: string | null = null;
  private networkResponses: Array<{ url: string; data: unknown; timestamp: number }> = [];

  constructor(options: APIAdapterOptions) {
    this.options = {
      baseUrl: 'https://bc.game',
      pollIntervalMs: TIMEOUTS.apiPollInterval,
      enableNetworkInterception: true,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.info({ component: 'APIAdapter' }, 'Starting API adapter');

    if (this.options.enableNetworkInterception) {
      await this.setupNetworkInterception();
    }

    // Start polling for round history
    this.pollTimer = setInterval(() => {
      if (!this.started) return;
      this.poll().catch((err) => this.handleError('poll', err));
    }, this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.logger.info({ component: 'APIAdapter' }, 'Stopping API adapter');
    this.started = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Remove network listener
    try {
      await this.options.page.route('**/*', (route) => route.continue());
    } catch {
      // Ignore cleanup errors
    }

    this.listeners = [];
  }

  private async setupNetworkInterception(): Promise<void> {
    try {
      await this.options.page.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();

        // Intercept responses that look like round data
        if (
          url.includes('crash') ||
          url.includes('round') ||
          url.includes('game') ||
          url.includes('history')
        ) {
          try {
            const response = await route.fetch();
            const body = await response.json().catch(() => null);

            if (body) {
              this.networkResponses.push({
                url,
                data: body,
                timestamp: Date.now(),
              });

              // Trim history
              if (this.networkResponses.length > 100) {
                this.networkResponses.shift();
              }

              await this.processNetworkResponse(url, body);
            }
          } catch {
            // Ignore fetch errors, just continue
          }
        }

        await route.continue();
      });
    } catch (error) {
      this.logger.warn(
        { component: 'APIAdapter', error: String(error) },
        'Network interception setup failed'
      );
    }
  }

  private async processNetworkResponse(_url: string, data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;

    const payload = data as Record<string, unknown>;
    const timestamp = new Date().toISOString();

    // Try to extract round data from various response shapes
    if (payload.rounds && Array.isArray(payload.rounds)) {
      for (const round of payload.rounds) {
        await this.processRoundHistoryItem(round as Record<string, unknown>, timestamp);
      }
    }

    if (payload.round || payload.data) {
      const roundData = (payload.round || payload.data) as Record<string, unknown>;
      await this.processRoundHistoryItem(roundData, timestamp);
    }

    if (payload.currentRound || payload.current_round) {
      const current = (payload.currentRound || payload.current_round) as Record<string, unknown>;
      await this.processCurrentRound(current, timestamp);
    }
  }

  private async processRoundHistoryItem(round: Record<string, unknown>, timestamp: string): Promise<void> {
    const roundId = this.extractRoundId(round);
    const crashPoint = this.extractMultiplier(round, 'crashPoint');

    if (!roundId || !crashPoint) return;

    // Only emit if we haven't seen this round before
    if (this.knownRoundIds.has(roundId)) return;
    this.knownRoundIds.add(roundId);

    await this.emit({
      type: 'round-crashed',
      roundId,
      multiplier: crashPoint,
      crashPoint,
      phase: 'crashed',
      source: 'api',
      confidence: 'high',
      timestamp,
      latencyMs: 0,
      rawPayload: round,
    });
  }

  private async processCurrentRound(round: Record<string, unknown>, timestamp: string): Promise<void> {
    const roundId = this.extractRoundId(round);
    const multiplier = this.extractMultiplier(round, 'multiplier');
    const phaseStr = typeof round.phase === 'string' ? round.phase :
                     typeof round.state === 'string' ? round.state : 'unknown';
    const phase = PHASE_MAPPINGS[phaseStr.toLowerCase()] || 'unknown';

    if (roundId) {
      this.currentRoundId = roundId;
    }

    if (phase === 'running' && multiplier !== null) {
      await this.emit({
        type: 'multiplier-tick',
        roundId: roundId || this.currentRoundId,
        multiplier,
        crashPoint: null,
        phase: 'running',
        source: 'api',
        confidence: 'medium',
        timestamp,
        latencyMs: 0,
        rawPayload: round,
      });
    }
  }

  private async poll(): Promise<void> {
    const pollStart = Date.now();

    try {
      // Try to fetch round history via page.evaluate (in-page fetch)
      const history = await this.options.page.evaluate(async ({ baseUrl, endpoint }: { baseUrl: string; endpoint: string }) => {
        try {
          const response = await fetch(`${baseUrl}${endpoint}?limit=20`, {
            method: 'GET',
            credentials: 'include',
          });
          if (!response.ok) return null;
          return await response.json();
        } catch {
          return null;
        }
      }, { baseUrl: this.options.baseUrl, endpoint: API_ENDPOINTS.roundHistory });

      const latencyMs = Date.now() - pollStart;
      this.recordLatency(latencyMs);

      if (history) {
        await this.processNetworkResponse(API_ENDPOINTS.roundHistory, history);
      }

      this.consecutiveErrors = 0;
    } catch (error) {
      this.handleError('api-poll', error);
    }
  }

  private extractRoundId(data: Record<string, unknown>): string | null {
    const candidates = [
      data.roundId,
      data.round_id,
      data.id,
      data.gameId,
      data.game_id,
      data.hash,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length >= 4) {
        return candidate;
      }
    }

    return null;
  }

  private extractMultiplier(data: Record<string, unknown>, fieldName?: string): number | null {
    if (fieldName && typeof data[fieldName] === 'number') {
      const val = data[fieldName] as number;
      if (val >= 1.0 && val < 100000) return val;
    }

    const candidates = [
      data.multiplier,
      data.crashPoint,
      data.crash_point,
      data.value,
      data.result,
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

  private async emit(event: NormalizedGameEvent): Promise<void> {
    this.lastEventAt = event.timestamp;

    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (err) {
        this.logger.warn({ component: 'APIAdapter', error: String(err) }, 'Listener error');
      }
    }
  }

  private handleError(context: string, error: unknown): void {
    this.errorCount++;
    this.consecutiveErrors++;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn({ component: 'APIAdapter', context, error: message }, 'API adapter error');
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
      source: 'api',
      healthy: this.started && this.consecutiveErrors < 5,
      lastEventAt: this.lastEventAt,
      errorCount: this.errorCount,
      consecutiveErrors: this.consecutiveErrors,
      latencyAvgMs: Math.round(avgLatency),
    };
  }

  isRunning(): boolean {
    return this.started;
  }

  getKnownRoundIds(): string[] {
    return Array.from(this.knownRoundIds);
  }

  getNetworkResponseCount(): number {
    return this.networkResponses.length;
  }
}
