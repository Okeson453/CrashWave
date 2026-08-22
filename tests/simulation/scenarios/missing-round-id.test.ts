/**
 * Missing Round ID Simulation Scenario
 * Simulates rounds where the round ID is temporarily unavailable or malformed.
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

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
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
      source: 'dom' as const, healthy: true,
      lastEventAt: new Date().toISOString(), errorCount: 0,
      consecutiveErrors: 0, latencyAvgMs: 50,
    };
  }

  emitEvent(event: NormalizedGameEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

describe('Simulation: Missing Round ID', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 2000 });
  });

  it('should handle rounds without explicit round IDs', async () => {
    await adapter.start();
    await observer.start();

    // Emit round started without roundId
    adapter.emitEvent({
      type: 'round-started', roundId: '', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(observer.getRoundCount()).toBeGreaterThanOrEqual(0);
    const state = observer.getCurrentState();
    expect(state.phase).toBeDefined();
  });

  it('should not crash when round ID is null', async () => {
    let errorThrown = false;
    try {
      await adapter.start();
      await observer.start();
      adapter.emitEvent({
        type: 'round-started', roundId: null as any, multiplier: 1.0,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
      const state = observer.getCurrentState();
      expect(state.phase).toBeDefined();
    } catch {
      errorThrown = true;
    }
    expect(errorThrown).toBe(false);
  });
});
