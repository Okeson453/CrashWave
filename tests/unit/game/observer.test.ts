import { RoundObserver } from '../../../src/game/observer';
import { IGameAdapter, NormalizedGameEvent } from '../../../src/game/types';
import { RoundState } from '../../../src/types/game';

class MockGameAdapter implements IGameAdapter {
  private listeners: Array<(event: NormalizedGameEvent) => void | Promise<void>> = [];
  private state: RoundState = {
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

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  getCurrentState(): RoundState {
    return { ...this.state };
  }

  onEvent(listener: (event: NormalizedGameEvent) => void | Promise<void>): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getHealth() {
    return {
      source: 'dom' as const,
      healthy: true,
      lastEventAt: new Date().toISOString(),
      errorCount: 0,
      consecutiveErrors: 0,
      latencyAvgMs: 50,
    };
  }

  emitEvent(event: NormalizedGameEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

describe('RoundObserver', () => {
  let observer: RoundObserver;
  let mockAdapter: MockGameAdapter;
  let stateChanges: RoundState[];
  let roundCompletes: Array<{ roundId: string; crashPoint: number }>;

  beforeEach(() => {
    mockAdapter = new MockGameAdapter();
    observer = new RoundObserver({
      adapter: mockAdapter,
      staleThresholdMs: 2000,
      minConfidenceForEntry: 'high',
      maxLatencyMs: 1000,
    });

    stateChanges = [];
    roundCompletes = [];

    observer.onStateChange((state) => {
      stateChanges.push(state);
    });

    observer.onRoundComplete((roundId, crashPoint) => {
      roundCompletes.push({ roundId, crashPoint });
    });
  });

  afterEach(async () => {
    await observer.stop();
  });

  describe('start and stop', () => {
    it('should start and stop successfully', async () => {
      await observer.start();
      expect(observer.isRunning()).toBe(true);

      await observer.stop();
      expect(observer.isRunning()).toBe(false);
    });

    it('should not start twice', async () => {
      await observer.start();
      await observer.start();
      expect(observer.isRunning()).toBe(true);
    });
  });

  describe('round-started handling', () => {
    it('should detect round start and update state', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-001',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      const state = observer.getCurrentState();
      expect(state.roundId).toBe('round-001');
      expect(state.phase).toBe('running');
      expect(state.currentMultiplier).toBe(1.0);
      expect(state.confidence).toBe('medium');
    });

    it('should emit state change on round start', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-002',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      expect(stateChanges.length).toBeGreaterThan(0);
      expect(stateChanges[stateChanges.length - 1].roundId).toBe('round-002');
    });
  });

  describe('multiplier-tick handling', () => {
    it('should record ticks during running phase', async () => {
      await observer.start();

      // Start round
      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-003',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      // Emit ticks
      for (let i = 1; i <= 5; i++) {
        mockAdapter.emitEvent({
          type: 'multiplier-tick',
          roundId: 'round-003',
          multiplier: 1.0 + i * 0.1,
          crashPoint: null,
          phase: 'running',
          source: 'dom',
          confidence: 'high',
          timestamp: new Date().toISOString(),
          latencyMs: 50,
        });
      }

      const state = observer.getCurrentState();
      expect(state.currentMultiplier).toBe(1.5);
      expect(observer.getTickHistory().length).toBe(5);
    });

    it('should ignore ticks when not in running phase', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'multiplier-tick',
        roundId: 'round-004',
        multiplier: 2.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      // Should not record tick because no round was started
      expect(observer.getTickHistory().length).toBe(0);
    });

    it('should ignore ticks with mismatched round ID', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-005',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      mockAdapter.emitEvent({
        type: 'multiplier-tick',
        roundId: 'round-wrong',
        multiplier: 2.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      expect(observer.getTickHistory().length).toBe(0);
    });
  });

  describe('round-crashed handling', () => {
    it('should detect crash and update state', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-006',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      mockAdapter.emitEvent({
        type: 'round-crashed',
        roundId: 'round-006',
        multiplier: 3.45,
        crashPoint: 3.45,
        phase: 'crashed',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      const state = observer.getCurrentState();
      expect(state.phase).toBe('crashed');
      expect(state.crashPoint).toBe(3.45);
    });

    it('should emit round-complete event', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-007',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      mockAdapter.emitEvent({
        type: 'round-crashed',
        roundId: 'round-007',
        multiplier: 2.0,
        crashPoint: 2.0,
        phase: 'crashed',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      expect(roundCompletes.length).toBe(1);
      expect(roundCompletes[0].roundId).toBe('round-007');
      expect(roundCompletes[0].crashPoint).toBe(2.0);
    });

    it('should increment round count on crash', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-008',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      mockAdapter.emitEvent({
        type: 'round-crashed',
        roundId: 'round-008',
        multiplier: 1.5,
        crashPoint: 1.5,
        phase: 'crashed',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      expect(observer.getRoundCount()).toBe(1);
    });
  });

  describe('stale detection', () => {
    it('should not be stale when no round is running', async () => {
      await observer.start();
      expect(observer.isStale()).toBe(false);
    });

    it('should be stale when no ticks received for too long', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-009',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date(Date.now() - 3000).toISOString(),
        latencyMs: 50,
      });

      expect(observer.isStale()).toBe(true);
    });
  });

  describe('confidence', () => {
    it('should return low confidence when stale', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-010',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'dom',
        confidence: 'high',
        timestamp: new Date(Date.now() - 3000).toISOString(),
        latencyMs: 50,
      });

      expect(observer.getConfidence()).toBe('low');
    });

    it('should return high confidence for recent websocket events', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-011',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'websocket',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      expect(observer.getConfidence()).toBe('high');
    });
  });

  describe('valid for observation', () => {
    it('should be valid when running with high confidence', async () => {
      await observer.start();

      mockAdapter.emitEvent({
        type: 'round-started',
        roundId: 'round-012',
        multiplier: 1.0,
        crashPoint: null,
        phase: 'running',
        source: 'websocket',
        confidence: 'high',
        timestamp: new Date().toISOString(),
        latencyMs: 50,
      });

      expect(observer.isValidForObservation()).toBe(true);
    });

    it('should not be valid when not running', async () => {
      await observer.start();
      expect(observer.isValidForObservation()).toBe(false);
    });
  });
});
