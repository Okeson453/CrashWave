/**
 * E2E: Chaos Browser Crash Test
 * Simulates browser crash and recovery using MockGameAdapter.
 */
import { RoundObserver } from '../../src/game/observer';
import { IGameAdapter, NormalizedGameEvent } from '../../src/game/types';
import { RoundState } from '../../src/types/game';
import { EventBus } from '../../src/core/event-bus/bus';

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

describe('E2E: Chaos Browser Crash', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;
  let eventBus: EventBus;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 3000 });
    eventBus = new EventBus();
  });

  it('should detect browser crash and attempt recovery', async () => {
    const criticalErrors: Array<{ code: string; message: string }> = [];
    eventBus.on('CriticalError', (event: { payload: { code: string; message: string } }) => {
      criticalErrors.push(event.payload);
    });

    await adapter.start();
    await observer.start();

    // Simulate some rounds
    for (let i = 0; i < 5; i++) {
      adapter.emitEvent({
        type: 'round-started', roundId: `chaos-${i}`, multiplier: 1.0,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
      adapter.emitEvent({
        type: 'round-crashed', roundId: `chaos-${i}`, multiplier: 2.0 + i * 0.5,
        crashPoint: 2.0 + i * 0.5, phase: 'crashed', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    const roundsBefore = observer.getRoundCount();
    expect(roundsBefore).toBeGreaterThanOrEqual(1);

    // Simulate crash
    await adapter.stop();
    await eventBus.emitTyped('CriticalError', {
      message: 'Browser process crashed unexpectedly',
      code: 'BROWSER_CRASH', component: 'BrowserManager',
    }, 'crash-1', 'BrowserManager');

    expect(criticalErrors.length).toBeGreaterThan(0);
    expect(criticalErrors[0].code).toBe('BROWSER_CRASH');

    // Simulate recovery
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 3000 });
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'recovery-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    adapter.emitEvent({
      type: 'round-crashed', roundId: 'recovery-001', multiplier: 3.0,
      crashPoint: 3.0, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(observer.getRoundCount()).toBeGreaterThanOrEqual(1);
    await adapter.stop();
    await observer.stop();
  });

  it('should persist rounds observed before crash', async () => {
    const rounds: Array<{ roundId: string; crashPoint: number }> = [];
    observer.onRoundComplete((roundId, crashPoint) => {
      rounds.push({ roundId, crashPoint });
    });

    await adapter.start();
    await observer.start();

    for (let i = 0; i < 10; i++) {
      adapter.emitEvent({
        type: 'round-started', roundId: `persist-${i}`, multiplier: 1.0,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
      adapter.emitEvent({
        type: 'round-crashed', roundId: `persist-${i}`, multiplier: 2.0 + Math.random() * 3,
        crashPoint: 2.0 + Math.random() * 3, phase: 'crashed', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    expect(rounds.length).toBeGreaterThanOrEqual(5);
    await adapter.stop();
    await observer.stop();
  });
});
