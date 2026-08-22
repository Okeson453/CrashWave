import { Page } from 'playwright';
import { getLogger } from '../observability/logger';
import { DOM_SELECTORS } from '../game/constants';

interface WsMessageEntry {
  timestamp: number;
  data: string;
}

declare global {
  interface Window {
    __crashAutomationWsMessages?: WsMessageEntry[];
  }
}


/**
 * ConfirmationResult carries the outcome of a confirmation observation.
 */
export interface ConfirmationResult {
  confirmed: boolean;
  source: 'dom' | 'websocket' | 'api' | null;
  multiplier?: number | null;
  timestamp: string;
  details?: string;
}

/**
 * Configuration for the ConfirmationObserver.
 */
export interface AuthoritativeBetConfirmation {
  confirmed: boolean;
  multiplier?: number | null;
  externalReference?: string | null;
}

export interface ConfirmationObserverConfig {
  /** How long to poll the DOM between checks */
  domPollIntervalMs: number;
  /** Selector that indicates a bet was successfully placed */
  betPlacedDomSelector: string;
  /** Selector that indicates a cash-out was confirmed */
  cashOutConfirmedDomSelector: string;
  /** WebSocket message pattern that signals bet placement */
  betPlacedWsPattern: RegExp;
  /** WebSocket message pattern that signals cash-out */
  cashOutWsPattern: RegExp;
  /** Max time to wait for a single confirmation */
  defaultTimeoutMs: number;
  /** Fail closed unless an authoritative reader confirms settlement. */
  requireAuthoritativeConfirmation: boolean;
}

const DEFAULT_OBSERVER_CONFIG: ConfirmationObserverConfig = {
  domPollIntervalMs: 100,
  betPlacedDomSelector: DOM_SELECTORS.activeBetIndicator,
  cashOutConfirmedDomSelector: DOM_SELECTORS.cashOutConfirmed,
  betPlacedWsPattern: /"type":"bet_placed"|"event":"bet"|"betId"/i,
  cashOutWsPattern: /"type":"cashout"|"event":"cashout"|"cashOut"/i,
  defaultTimeoutMs: 5000,
  requireAuthoritativeConfirmation: true,
};

/**
 * ConfirmationObserver aggregates confirmation signals from multiple
 * sources — DOM mutations, WebSocket traffic, and API polling — to
 * determine whether a bet was placed or a cash-out succeeded. DOM and
 * WebSocket signals are observations only. In hardened live mode an explicit
 * authoritative reader must confirm server settlement; otherwise the caller
 * receives an unconfirmed result and must reconcile.
 */
export class ConfirmationObserver {
  private readonly logger = getLogger();
  private readonly config: ConfirmationObserverConfig;
  private wsListenerAttached = false;
  private authoritativeBetReader: ((roundId: string, sessionId: string) => Promise<AuthoritativeBetConfirmation | null>) | null = null;
  private authoritativeCashOutReader: ((betId: string, roundId: string) => Promise<AuthoritativeBetConfirmation | null>) | null = null;

  constructor(
    private readonly page: Page,
    config?: Partial<ConfirmationObserverConfig>
  ) {
    this.config = { ...DEFAULT_OBSERVER_CONFIG, ...config };
  }

  setAuthoritativeBetReader(reader: (roundId: string, sessionId: string) => Promise<AuthoritativeBetConfirmation | null>): void {
    this.authoritativeBetReader = reader;
  }

  setAuthoritativeCashOutReader(reader: (betId: string, roundId: string) => Promise<AuthoritativeBetConfirmation | null>): void {
    this.authoritativeCashOutReader = reader;
  }

  /**
   * Attaches a WebSocket message listener to the page so we can
   * inspect server messages for confirmation signals.
   */
  async attachWebSocketListener(): Promise<void> {
    if (this.wsListenerAttached) return;

    try {
      // Intercept WebSocket traffic via page init script
      await this.page.addInitScript(() => {
        const OriginalWebSocket = window.WebSocket;
        window.__crashAutomationWsMessages = [];

        window.WebSocket = class extends OriginalWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener('message', (event) => {
              try {
                window.__crashAutomationWsMessages!.push({
                  timestamp: Date.now(),
                  data: typeof event.data === 'string' ? event.data : '[binary]',
                });
                // Keep only last 500 messages
                const msgs = window.__crashAutomationWsMessages!;
                if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
              } catch {
                // ignore
              }
            });
          }
        } as unknown as typeof OriginalWebSocket;
      });

      this.wsListenerAttached = true;
      this.logger.info({ component: 'ConfirmationObserver' }, 'WebSocket listener attached');
    } catch (error) {
      this.logger.warn(
        { component: 'ConfirmationObserver', error: String(error) },
        'Failed to attach WebSocket listener'
      );
    }
  }

  /**
   * Waits for confirmation that a bet was placed for the given round.
   * Returns true if confirmed, throws TimeoutError if not.
   */
  async waitForBetPlaced(roundId: string, _sessionId: string, timeoutMs?: number): Promise<boolean> {
    const deadline = Date.now() + (timeoutMs ?? this.config.defaultTimeoutMs);
    const correlationId = `confirm-bet-${roundId}`;

    this.logger.debug(
      { component: 'ConfirmationObserver', correlationId, roundId },
      'Starting bet placement confirmation observation'
    );

    while (Date.now() < deadline) {
      if (this.authoritativeBetReader) {
        const authoritative = await this.authoritativeBetReader(roundId, _sessionId).catch(() => null);
        if (authoritative?.confirmed) {
          this.logger.info({ component: 'ConfirmationObserver', correlationId, roundId, source: 'api' }, 'Bet placement confirmed by authoritative reader');
          return true;
        }
      } else if (this.config.requireAuthoritativeConfirmation) {
        // DOM/WebSocket signals are observations only; they cannot prove server settlement.
        await this.delay(this.config.domPollIntervalMs);
        continue;
      }
      // 1. Check DOM (legacy/non-authoritative mode only)
      const domConfirmed = await this.checkDomForBetPlaced();
      if (domConfirmed) {
        this.logger.info(
          { component: 'ConfirmationObserver', correlationId, roundId, source: 'dom' },
          'Bet placement confirmed via DOM'
        );
        return true;
      }

      // 2. Check WebSocket messages
      const wsConfirmed = await this.checkWebSocketForBetPlaced(roundId);
      if (wsConfirmed) {
        this.logger.info(
          { component: 'ConfirmationObserver', correlationId, roundId, source: 'websocket' },
          'Bet placement confirmed via WebSocket'
        );
        return true;
      }

      await this.delay(this.config.domPollIntervalMs);
    }

    this.logger.warn(
      { component: 'ConfirmationObserver', correlationId, roundId },
      'Bet placement confirmation timed out'
    );
    return false;
  }

  /**
   * Waits for confirmation that a cash-out succeeded for the given bet.
   * Returns the confirmed multiplier if confirmed, null if timed out.
   */
  async waitForCashOut(betId: string, roundId: string, timeoutMs?: number): Promise<number | null> {
    const deadline = Date.now() + (timeoutMs ?? this.config.defaultTimeoutMs);
    const correlationId = `confirm-cashout-${betId}`;

    this.logger.debug(
      { component: 'ConfirmationObserver', correlationId, betId, roundId },
      'Starting cash-out confirmation observation'
    );

    while (Date.now() < deadline) {
      if (this.authoritativeCashOutReader) {
        const authoritative = await this.authoritativeCashOutReader(betId, roundId).catch(() => null);
        if (authoritative?.confirmed && authoritative.multiplier != null) {
          this.logger.info({ component: 'ConfirmationObserver', correlationId, betId, source: 'api', multiplier: authoritative.multiplier, externalReference: authoritative.externalReference }, 'Cash-out confirmed by authoritative reader');
          return authoritative.multiplier;
        }
      } else if (this.config.requireAuthoritativeConfirmation) {
        await this.delay(this.config.domPollIntervalMs);
        continue;
      }
      // 1. Check DOM (legacy/non-authoritative mode only)
      const domResult = await this.checkDomForCashOut();
      if (domResult.confirmed && domResult.multiplier !== undefined) {
        this.logger.info(
          { component: 'ConfirmationObserver', correlationId, betId, source: 'dom', multiplier: domResult.multiplier },
          'Cash-out confirmed via DOM'
        );
        return domResult.multiplier;
      }

      // 2. Check WebSocket messages
      const wsMultiplier = await this.checkWebSocketForCashOut(betId, roundId);
      if (wsMultiplier !== null) {
        this.logger.info(
          { component: 'ConfirmationObserver', correlationId, betId, source: 'websocket', multiplier: wsMultiplier },
          'Cash-out confirmed via WebSocket'
        );
        return wsMultiplier;
      }

      await this.delay(this.config.domPollIntervalMs);
    }

    this.logger.warn(
      { component: 'ConfirmationObserver', correlationId, betId, roundId },
      'Cash-out confirmation timed out'
    );
    return null;
  }

  /**
   * Checks the DOM for visual indicators that a bet was placed.
   */
  private async checkDomForBetPlaced(): Promise<boolean> {
    try {
      const element = this.page.locator(this.config.betPlacedDomSelector).first();
      const visible = await element.isVisible().catch(() => false);
      return visible;
    } catch {
      return false;
    }
  }

  /**
   * Checks the DOM for visual indicators that a cash-out was confirmed.
   * Also attempts to read the multiplier from the win-amount element.
   */
  private async checkDomForCashOut(): Promise<ConfirmationResult> {
    try {
      const element = this.page.locator(this.config.cashOutConfirmedDomSelector).first();
      const visible = await element.isVisible().catch(() => false);
      if (!visible) {
        return { confirmed: false, source: null, timestamp: new Date().toISOString() };
      }

      // Try to extract multiplier from text content
      let multiplier: number | undefined;
      try {
        const text = await element.textContent({ timeout: 500 }).catch(() => '');
        const match = text?.match(/([0-9]+\.?[0-9]*)x?/);
        if (match) {
          multiplier = parseFloat(match[1]);
        }
      } catch {
        // ignore parse errors
      }

      return {
        confirmed: true,
        source: 'dom',
        multiplier,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return { confirmed: false, source: null, timestamp: new Date().toISOString() };
    }
  }

  /**
   * Checks intercepted WebSocket messages for bet placement confirmation.
   */
  private async checkWebSocketForBetPlaced(roundId: string): Promise<boolean> {
    try {
      const messages: Array<{ timestamp: number; data: string }> = await this.page.evaluate(() => {
        return window.__crashAutomationWsMessages ?? [];
      });

      // Filter recent messages matching the bet-placed pattern
      const recentMessages = messages.filter(
        (m) => m.timestamp > Date.now() - 30000
      );

      for (const msg of recentMessages) {
        if (this.config.betPlacedWsPattern.test(msg.data)) {
          // Additional heuristic: check if roundId is mentioned
          if (msg.data.includes(roundId) || msg.data.includes(roundId.slice(-8))) {
            return true;
          }
          // If pattern matches but roundId not found, still count it as
          // a weak signal — but we require DOM confirmation too.
          // For now, accept pattern match alone as a pragmatic compromise.
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Checks intercepted WebSocket messages for cash-out confirmation.
   */
  private async checkWebSocketForCashOut(_betId: string, _roundId: string): Promise<number | null> {
    try {
      const messages: Array<{ timestamp: number; data: string }> = await this.page.evaluate(() => {
        return window.__crashAutomationWsMessages ?? [];
      });

      const recentMessages = messages.filter(
        (m) => m.timestamp > Date.now() - 30000
      );

      for (const msg of recentMessages) {
        if (this.config.cashOutWsPattern.test(msg.data)) {
          // Try to extract multiplier from the message
          const multiplierMatch = msg.data.match(/"multiplier"[:\s]+([0-9]+\.?[0-9]*)/i);
          if (multiplierMatch) {
            return parseFloat(multiplierMatch[1]);
          }

          // Fallback: look for any numeric value that could be the multiplier
          const genericMatch = msg.data.match(/([0-9]+\.[0-9]{2,})x?/);
          if (genericMatch) {
            return parseFloat(genericMatch[1]);
          }

          // If we can't parse multiplier but pattern matches, return 0
          // to signal confirmation (caller will use observed multiplier)
          return 0;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Clears the WebSocket message buffer to prevent stale data
   * from interfering with future observations.
   */
  async clearWebSocketBuffer(): Promise<void> {
    try {
      await this.page.evaluate(() => {
        window.__crashAutomationWsMessages = [];
      });
    } catch {
      // ignore
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
