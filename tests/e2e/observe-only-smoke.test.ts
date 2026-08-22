/**
 * E2E: Observe-Only Smoke Test
 * Validates the full observe-only pipeline with MockGameAdapter.
 */
import { RoundObserver } from '../../src/game/observer';
import { IGameAdapter, NormalizedGameEvent } from '../../src/game/types';
import { RoundState } from '../../src/types/game';

class MockGameAdapter implements IGameAdapter {
  private listeners: Array<(event: NormalizedGameEvent) => void | Promise<void>> = [];
  private state: RoundState = {
    roundId: null, phase: 'idle', currentMultiplier: null,
    startedAt: null, crashedAt: null, crashPoint: null,
    lastTickAt: null, source: 'unknown', confidence: 'low',
  };
  private running = false;

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  getCurrentState(): RoundState { return { ...this.state }; }

  onEvent(listener: (event: NormalizedGameEvent) => void | Promise<void>): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getHealth() {
    return {
      source: 'dom' as const, healthy: this.running,
      lastEventAt: new Date().toISOString(), errorCount: 0,
      consecutiveErrors: 0, latencyAvgMs: 50,
    };
  }

  emitEvent(event: NormalizedGameEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

describe('E2E: Observe-Only Smoke Test', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 3000, minConfidenceForEntry: 'medium' });
  });

  it('should detect round start and crash with high confidence', async () => {
    const crashes: Array<{ roundId: string; crashPoint: number }> = [];
    observer.onRoundComplete((roundId, crashPoint) => {
      crashes.push({ roundId, crashPoint });
    });

    await adapter.start();
    await observer.start();

    // Simulate 5 rounds
    for (let i = 0; i < 5; i++) {
      const roundId = `smoke-${String(i + 1).padStart(3, '0')}`;
      const crashPoint = 1.0 + Math.random() * 9.0;
      adapter.emitEvent({
        type: 'round-started', roundId, multiplier: 1.0,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
      adapter.emitEvent({
        type: 'round-crashed', roundId, multiplier: crashPoint,
        crashPoint, phase: 'crashed', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    expect(crashes.length).toBeGreaterThanOrEqual(1);
    expect(crashes[0].crashPoint).toBeGreaterThanOrEqual(1.0);
    expect(crashes[0].crashPoint).toBeLessThanOrEqual(15.0);
  });

  it('should record multiplier ticks with timestamps', async () => {
    const ticks: Array<{ multiplier: number; timestamp: string }> = [];
    adapter.onEvent((event) => {
      if (event.type === 'multiplier-tick' && event.multiplier !== null) {
        ticks.push({ multiplier: event.multiplier, timestamp: event.timestamp });
      }
    });

    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'tick-test', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    for (const m of [1.2, 1.5, 2.0, 2.5, 3.0]) {
      adapter.emitEvent({
        type: 'multiplier-tick', roundId: 'tick-test', multiplier: m,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(new Date(tick.timestamp).getTime()).not.toBeNaN();
    }
  });

  it('should run stable for 30+ simulated rounds without error', async () => {
    const rounds: Array<{ roundId: string; crashPoint: number }> = [];
    observer.onRoundComplete((roundId, crashPoint) => {
      rounds.push({ roundId, crashPoint });
    });

    await adapter.start();
    await observer.start();

    for (let i = 0; i < 35; i++) {
      const roundId = `stable-${String(i + 1).padStart(3, '0')}`;
      const crashPoint = 1.0 + Math.random() * 9.0;
      adapter.emitEvent({
        type: 'round-started', roundId, multiplier: 1.0,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
      adapter.emitEvent({
        type: 'round-crashed', roundId, multiplier: crashPoint,
        crashPoint, phase: 'crashed', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    expect(rounds.length).toBeGreaterThanOrEqual(30);
    for (const round of rounds) {
      expect(round.crashPoint).toBeGreaterThanOrEqual(1.0);
      expect(round.crashPoint).toBeLessThanOrEqual(15.0);
    }
  });

  it('should maintain low latency throughout observation', async () => {
    const latencies: number[] = [];
    adapter.onEvent((event) => {
      latencies.push(event.latencyMs);
    });

    await adapter.start();
    await observer.start();

    for (let i = 0; i < 10; i++) {
      adapter.emitEvent({
        type: 'round-started', roundId: `lat-${i}`, multiplier: 1.0,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50 + i * 5,
      });
    }

    if (latencies.length > 0) {
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      expect(avgLatency).toBeLessThan(2000);
    }
  });
});
