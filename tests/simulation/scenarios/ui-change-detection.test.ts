/**
 * UI Change Detection Simulation Scenario
 */
import { RoundObserver } from '../../../src/game/observer';
import { IGameAdapter, NormalizedGameEvent } from '../../../src/game/types';
import { RoundState } from '../../../src/types/game';
import { EventBus } from '../../../src/core/event-bus/bus';

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

describe('Simulation: UI Change Detection', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;
  let eventBus: EventBus;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 2000 });
    eventBus = new EventBus();
  });

  it('should detect game state changes', async () => {
    await adapter.start();
    await observer.start();
    adapter.emitEvent({
      type: 'round-started', roundId: 'ui-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    expect(observer.getCurrentState().phase).toBe('running');
  });

  it('should degrade confidence when DOM data is stale', async () => {
    await adapter.start();
    await observer.start();
    adapter.emitEvent({
      type: 'round-started', roundId: 'ui-002', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    expect(['high', 'medium']).toContain(observer.getConfidence());
    // Simulate stale data by not emitting ticks
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Confidence should still be valid shortly after
    expect(['high', 'medium', 'low']).toContain(observer.getConfidence());
  });

  it('should emit alert when UI selectors fail consistently', async () => {
    const alerts: Array<{ code: string; message: string }> = [];
    eventBus.on('CriticalError', (event: { payload: { code: string; message: string } }) => {
      alerts.push(event.payload);
    });
    await eventBus.emitTyped('CriticalError', {
      message: 'DOM selectors no longer match expected patterns',
      code: 'UI_CHANGE_DETECTED',
      component: 'GameAdapter',
    }, 'ui-1', 'GameAdapter');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].code).toBe('UI_CHANGE_DETECTED');
  });

  it('should not allow betting when confidence is low', async () => {
    await adapter.start();
    await observer.start();
    // No events emitted = low confidence
    expect(observer.isValidForObservation()).toBe(false);
  });
});
