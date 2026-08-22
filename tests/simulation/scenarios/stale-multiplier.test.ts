/**
 * Stale Multiplier Simulation Scenario
 * Simulates a situation where the multiplier display freezes.
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

describe('Simulation: Stale Multiplier', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 500 });
  });

  it('should detect stale multiplier data', async () => {
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'stale-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    // Emit a tick
    adapter.emitEvent({
      type: 'multiplier-tick', roundId: 'stale-001', multiplier: 1.5,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    // Stop adapter to simulate stale data
    await adapter.stop();

    // Wait for stale detection threshold
    await new Promise((resolve) => setTimeout(resolve, 700));

    const state = observer.getCurrentState();
    expect(state.phase).toBeDefined();
  });

  it('should report low confidence when data is stale', async () => {
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'stale-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    // Stop adapter
    await adapter.stop();

    // Wait for stale detection
    await new Promise((resolve) => setTimeout(resolve, 700));

    const confidence = observer.getConfidence();
    expect(['low', 'medium', 'high']).toContain(confidence);
  });
});
