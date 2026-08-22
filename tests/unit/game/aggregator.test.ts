import { Aggregator } from '../../../src/game/adapters/aggregator';
import { DOMAdapter } from '../../../src/game/adapters/dom-adapter';
import { WSInterceptor } from '../../../src/game/adapters/ws-interceptor';
import { APIAdapter } from '../../../src/game/adapters/api-adapter';
import { NormalizedGameEvent } from '../../../src/game/types';
import { Page } from 'playwright';

describe('Aggregator', () => {
  let aggregator: Aggregator;
  let mockDomAdapter: DOMAdapter;
  let mockWsAdapter: WSInterceptor;
  let mockApiAdapter: APIAdapter;
  let events: NormalizedGameEvent[];

  beforeEach(() => {
    const mockPage = {
      evaluate: jest.fn().mockResolvedValue(null),
      evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      route: jest.fn().mockResolvedValue(undefined),
      exposeFunction: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue({} as never),
    } as unknown as Page;

    mockDomAdapter = new DOMAdapter({ page: mockPage, pollIntervalMs: 100 });
    mockWsAdapter = new WSInterceptor({ page: mockPage });
    mockApiAdapter = new APIAdapter({ page: mockPage, pollIntervalMs: 500 });

    aggregator = new Aggregator({
      domAdapter: mockDomAdapter,
      wsAdapter: mockWsAdapter,
      apiAdapter: mockApiAdapter,
      staleThresholdMs: 2000,
    });

    events = [];
    aggregator.onEvent((event) => {
      events.push(event);
    });
  });

  afterEach(async () => {
    await aggregator.stop();
    await mockDomAdapter.stop();
    await mockWsAdapter.stop();
    await mockApiAdapter.stop();
  });

  describe('start and stop', () => {
    it('should start and stop successfully', async () => {
      await aggregator.start();
      expect(aggregator.isRunning()).toBe(true);

      await aggregator.stop();
      expect(aggregator.isRunning()).toBe(false);
    });
  });

  describe('event aggregation', () => {
    it('should aggregate events from DOM adapter', async () => {
      await aggregator.start();

      const event: NormalizedGameEvent = {
        type: 'round-started',
        roundId: 'agg-round-001',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 100,
      };

      // Emit from DOM adapter
      const domListeners = (mockDomAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;
      for (const listener of domListeners) {
        await listener(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1].roundId).toBe('agg-round-001');
    });

    it('should aggregate events from multiple sources', async () => {
      await aggregator.start();

      const domEvent: NormalizedGameEvent = {
        type: 'multiplier-tick',
        roundId: 'agg-round-002',
        multiplier: 2.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 150,
      };

      const wsEvent: NormalizedGameEvent = {
        type: 'multiplier-tick',
        roundId: 'agg-round-002',
        multiplier: 2.01,
        crashPoint: null,
        phase: 'running',
        source: 'websocket',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      };

      // Emit from both adapters
      const domListeners = (mockDomAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;
      const wsListeners = (mockWsAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;

      for (const listener of domListeners) {
        await listener(domEvent);
      }
      for (const listener of wsListeners) {
        await listener(wsEvent);
      }

      expect(events.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('conflict detection', () => {
    it('should detect round ID conflicts', async () => {
      await aggregator.start();

      const domEvent: NormalizedGameEvent = {
        type: 'round-started',
        roundId: 'dom-round',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 100,
      };

      const wsEvent: NormalizedGameEvent = {
        type: 'round-started',
        roundId: 'ws-round',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'websocket',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      };

      const domListeners = (mockDomAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;
      const wsListeners = (mockWsAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;

      for (const listener of domListeners) {
        await listener(domEvent);
      }
      for (const listener of wsListeners) {
        await listener(wsEvent);
      }

      const conflicts = aggregator.getConflictHistory();
      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].field).toBe('roundId');
    });

    it('should detect multiplier conflicts', async () => {
      await aggregator.start();

      const domEvent: NormalizedGameEvent = {
        type: 'multiplier-tick',
        roundId: 'conflict-round',
        multiplier: 2.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 100,
      };

      const wsEvent: NormalizedGameEvent = {
        type: 'multiplier-tick',
        roundId: 'conflict-round',
        multiplier: 3.0,
        crashPoint: null,
        phase: 'running',
        source: 'websocket',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      };

      const domListeners = (mockDomAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;
      const wsListeners = (mockWsAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;

      for (const listener of domListeners) {
        await listener(domEvent);
      }
      for (const listener of wsListeners) {
        await listener(wsEvent);
      }

      const conflicts = aggregator.getConflictHistory();
      expect(conflicts.some((c) => c.field === 'multiplier')).toBe(true);
    });
  });

  describe('confidence scoring', () => {
    it('should assign high confidence when sources agree', async () => {
      await aggregator.start();

      const event: NormalizedGameEvent = {
        type: 'round-started',
        roundId: 'high-conf-round',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'websocket',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      };

      const wsListeners = (mockWsAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;
      for (const listener of wsListeners) {
        await listener(event);
      }

      const observation = aggregator.getCurrentObservation();
      expect(observation.confidence).toBe('medium');
    });

    it('should assign low confidence for stale data', async () => {
      await aggregator.start();

      const event: NormalizedGameEvent = {
        type: 'round-started',
        roundId: 'low-conf-round',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'low',
        timestamp: new Date(Date.now() - 5000).toISOString(),
        latencyMs: 2000,
      };

      const domListeners = (mockDomAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;
      for (const listener of domListeners) {
        await listener(event);
      }

      const observation = aggregator.getCurrentObservation();
      expect(observation.confidence).toBe('low');
    });
  });

  describe('toRoundState', () => {
    it('should convert observation to RoundState', async () => {
      await aggregator.start();

      const event: NormalizedGameEvent = {
        type: 'round-started',
        roundId: 'state-round',
        multiplier: 2.5,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 100,
      };

      const domListeners = (mockDomAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;
      for (const listener of domListeners) {
        await listener(event);
      }

      const state = aggregator.toRoundState();
      expect(state.roundId).toBe('state-round');
      expect(state.phase).toBe('running');
      expect(state.currentMultiplier).toBe(2.5);
      expect(state.confidence).toBe('medium');
    });
  });

  describe('event count', () => {
    it('should track event count', async () => {
      await aggregator.start();
      expect(aggregator.getEventCount()).toBe(0);

      const event: NormalizedGameEvent = {
        type: 'multiplier-tick',
        roundId: 'count-round',
        multiplier: 1.5,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 100,
      };

      const domListeners = (mockDomAdapter as unknown as { listeners: Array<(e: NormalizedGameEvent) => void> }).listeners;
      for (const listener of domListeners) {
        await listener(event);
      }

      expect(aggregator.getEventCount()).toBe(1);
    });
  });
});
