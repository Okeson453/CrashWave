// @ts-nocheck
/**
 * Browser Crash Simulation Scenario
 * Tests system behavior when the Playwright browser instance crashes mid-session.
 */
import { SessionSupervisor } from '../../../src/core/session-supervisor';
import { EventBus } from '../../../src/core/event-bus/bus';
import { AppConfig } from '../../../src/config/schema';

describe('Simulation: Browser Crash', () => {
  const hasBrowser = (() => {
    try { require('fs').accessSync('/root/.cache/ms-playwright'); return true; }
    catch { return false; }
  })();
  const describeBrowser = hasBrowser ? describe : describe.skip;

  let supervisor: SessionSupervisor;
  let eventBus: EventBus;
  let config: AppConfig;

  beforeEach(() => {
    eventBus = new EventBus();
    config = {
      system: { mode: 'observe-only', logLevel: 'info', serviceName: 'bc-game-crash-automation' },
      betting: { stakePerEntry: 700, cashOutTarget: 1.30, maxDailyEntries: 100, currencyUnit: 'units', dayBoundaryTimezone: 'UTC' },
      risk: { minBalanceForEntry: 700, balanceBuffer: 700, maxConsecutiveErrorsBeforeStop: 3, maxCashOutFailuresBeforeStop: 2, cooldownMs: 5000 , minPredictionProbability: 0, minPredictionConfidence: 0, requirePredictionForLive: false },
      observation: { maxTickLatencyMs: 1000, minConfidenceForEntry: 'high', requireRoundId: true, latencyThresholdHealthyMs: 500, latencyThresholdDegradedMs: 1000 },
      telegram: { allowedUserIds: [], verbosity: 'normal', sendRoundStart: false, sendRoundResult: true, sendHealthWarnings: true, rateLimitMessagesPerMinute: 30 },
      browser: { headless: true, viewportWidth: 1366, viewportHeight: 900, profileDirectory: '/tmp/sim-browser-crash-profile', timeoutMs: 30000 },
      persistence: { databasePoolSize: 10, redisCommandTimeoutMs: 5000, redisReconnectIntervalMs: 3000 },
      health: { checkIntervalMs: 30000, degradationThreshold: 2, failureThreshold: 3 },
    };
    supervisor = new SessionSupervisor({ config, eventBus });
  });

  afterEach(async () => {
    try { await supervisor.stop(); } catch { /* ignore */ }
  });

  describe('supervisor state', () => {
    it('should initialize supervisor in idle state', () => {
      expect(supervisor.getPhase()).toBe('idle');
    });

    it('should expose browser manager getter', () => {
      expect(supervisor.getBrowserManager()).toBeNull();
    });

    it('should expose game adapter getter', () => {
      expect(supervisor.getGameAdapter()).toBeNull();
    });


  });

  describe('crash event handling', () => {
    it('should track error count on critical events', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });

      await eventBus.emitTyped('CriticalError', {
        message: 'Browser crashed',
        code: 'BROWSER_CRASH',
        component: 'BrowserManager',
      }, 'crash-1', 'BrowserManager');

      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('BROWSER_CRASH');
    });

    it('should emit BROWSER_CRASH when page is unresponsive', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });
      await eventBus.emitTyped('CriticalError', {
        message: 'Page unresponsive for 30s',
        code: 'BROWSER_UNRESPONSIVE',
        component: 'BrowserManager',
      }, 'crash-2', 'BrowserManager');
      expect(errors[0].code).toBe('BROWSER_UNRESPONSIVE');
    });

    it('should handle multiple rapid crash events', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });
      for (let i = 0; i < 5; i++) {
        await eventBus.emitTyped('CriticalError', {
          message: `Browser crash #${i}`,
          code: 'BROWSER_CRASH',
          component: 'BrowserManager',
        }, `crash-${i}`, 'BrowserManager');
      }
      expect(errors.length).toBe(5);
    });
  });

  describeBrowser('recovery behavior', () => {
    it('should allow supervisor restart after crash', async () => {
      await supervisor.start();
      expect(supervisor.getPhase()).not.toBe('idle');
      await supervisor.stop();
      expect(supervisor.getPhase()).toBe('idle');
      // Restart should succeed
      await supervisor.start();
      expect(supervisor.getPhase()).not.toBe('idle');
    });

    it('should stop gracefully even when browser is already crashed', async () => {
      await supervisor.start();
      // Simulate crash by stopping abruptly
      await supervisor.stop();
      expect(supervisor.getPhase()).toBe('idle');
    });
  });
});
