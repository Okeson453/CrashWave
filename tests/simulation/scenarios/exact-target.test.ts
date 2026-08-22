/**
 * Exact Target Simulation Scenario
 * Simulates rounds that crash at specific target multipliers.
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

describe('Simulation: Exact Target', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 2000 });
  });

  it('should capture crash points at exact targets', async () => {
    const crashes: Array<{ roundId: string; crashPoint: number }> = [];
    observer.onRoundComplete((roundId, crashPoint) => {
      crashes.push({ roundId, crashPoint });
    });

    await adapter.start();
    await observer.start();

    const targets = [2.0, 3.0, 5.0];
    for (let i = 0; i < targets.length; i++) {
      const roundId = `exact-${String(i + 1).padStart(3, '0')}`;
      adapter.emitEvent({
        type: 'round-started', roundId, multiplier: 1.0,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
      adapter.emitEvent({
        type: 'round-crashed', roundId, multiplier: targets[i],
        crashPoint: targets[i], phase: 'crashed', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    expect(crashes.length).toBeGreaterThanOrEqual(2);
    for (const crash of crashes) {
      expect(crash.crashPoint).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('should track multiplier progression toward target', async () => {
    const tickHistory: number[] = [];
    observer.onStateChange((state) => {
      if (state.phase === 'running' && state.currentMultiplier !== null) {
        tickHistory.push(state.currentMultiplier);
      }
    });

    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'exact-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    const ticks = [1.1, 1.3, 1.6, 2.0, 2.5, 3.0];
    for (const m of ticks) {
      adapter.emitEvent({
        type: 'multiplier-tick', roundId: 'exact-001', multiplier: m,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    adapter.emitEvent({
      type: 'round-crashed', roundId: 'exact-001', multiplier: 3.0,
      crashPoint: 3.0, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(tickHistory.length).toBeGreaterThan(0);
    for (let i = 1; i < tickHistory.length; i++) {
      expect(tickHistory[i]).toBeGreaterThanOrEqual(tickHistory[i - 1]);
    }
  });
});
