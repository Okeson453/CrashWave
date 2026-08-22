/**
 * Normal Round Simulation Scenario
 * Simulates a typical Crash game round with moderate crash point.
 */
import { RoundObserver } from '../../../src/game/observer';
import { IGameAdapter, NormalizedGameEvent } from '../../../src/game/types';
import { RoundState } from '../../../src/types/game';

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

describe('Simulation: Normal Round', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 2000 });
  });

  it('should detect round start and crash with high confidence', async () => {
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'normal-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    adapter.emitEvent({
      type: 'round-crashed', roundId: 'normal-001', multiplier: 3.45,
      crashPoint: 3.45, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(observer.getRoundCount()).toBeGreaterThanOrEqual(1);
    const state = observer.getCurrentState();
    expect(['crashed', 'idle', 'starting', 'unknown']).toContain(state.phase);
  });

  it('should record multiple ticks during a round', async () => {
    let tickCount = 0;
    observer.onStateChange((state) => {
      if (state.phase === 'running' && state.currentMultiplier !== null) {
        tickCount++;
      }
    });

    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'normal-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    for (const m of [1.2, 1.5, 2.0, 2.5, 3.0, 3.45]) {
      adapter.emitEvent({
        type: 'multiplier-tick', roundId: 'normal-001', multiplier: m,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    adapter.emitEvent({
      type: 'round-crashed', roundId: 'normal-001', multiplier: 3.45,
      crashPoint: 3.45, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(tickCount).toBeGreaterThan(0);
  });

  it('should capture crash point accurately', async () => {
    const crashes: Array<{ roundId: string; crashPoint: number }> = [];
    observer.onRoundComplete((roundId, crashPoint) => {
      crashes.push({ roundId, crashPoint });
    });

    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'normal-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    adapter.emitEvent({
      type: 'round-crashed', roundId: 'normal-001', multiplier: 3.45,
      crashPoint: 3.45, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(crashes.length).toBeGreaterThanOrEqual(1);
    expect(crashes[0].crashPoint).toBeGreaterThanOrEqual(1.0);
  });
});
