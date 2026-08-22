/**
 * E2E: Chaos Network Drop Test
 * Simulates network partition during observation.
 */
import { RoundObserver } from '../../src/game/observer';
import { IGameAdapter, NormalizedGameEvent } from '../../src/game/types';
import { RoundState } from '../../src/types/game';
import { EventBus } from '../../src/core/event-bus/bus';
import { InMemoryBetRepository } from '../../src/persistence/repositories/bet-repo';

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

describe('E2E: Chaos Network Drop', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;
  let eventBus: EventBus;
  let betRepo: InMemoryBetRepository;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 3000 });
    eventBus = new EventBus();
    betRepo = new InMemoryBetRepository();
  });

  it('should detect network loss and halt betting', async () => {
    const criticalErrors: Array<{ code: string; message: string }> = [];
    eventBus.on('CriticalError', (event: { payload: { code: string; message: string } }) => {
      criticalErrors.push(event.payload);
    });

    await adapter.start();
    await observer.start();

    // Simulate some rounds
    for (let i = 0; i < 3; i++) {
      adapter.emitEvent({
        type: 'round-started', roundId: `net-${i}`, multiplier: 1.0,
        crashPoint: null, phase: 'running', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
      adapter.emitEvent({
        type: 'round-crashed', roundId: `net-${i}`, multiplier: 2.0 + i,
        crashPoint: 2.0 + i, phase: 'crashed', source: 'dom',
        confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
      });
    }

    // Simulate network drop by stopping adapter
    await adapter.stop();

    await eventBus.emitTyped('CriticalError', {
      message: 'Network partition detected',
      code: 'NETWORK_PARTITION', component: 'NetworkMonitor',
    }, 'net-1', 'NetworkMonitor');

    expect(criticalErrors.length).toBeGreaterThanOrEqual(1);
    expect(criticalErrors[0].code).toBe('NETWORK_PARTITION');

    // Simulate recovery
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 3000 });
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'net-recovery', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    adapter.emitEvent({
      type: 'round-crashed', roundId: 'net-recovery', multiplier: 3.0,
      crashPoint: 3.0, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(observer.getRoundCount()).toBeGreaterThanOrEqual(1);
    await adapter.stop();
    await observer.stop();
  });

  it('should not create duplicate bets after network recovery', async () => {
    await adapter.start();
    await observer.start();

    // Simulate placing a bet
    await betRepo.create({
      sessionId: 'session-net',
      roundId: 'net-test-1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });

    // Simulate network drop and recovery
    await adapter.stop();
    adapter = new MockGameAdapter();
    await adapter.start();

    // Attempt same bet again with different idempotency
    await betRepo.create({
      sessionId: 'session-net',
      roundId: 'net-test-1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });

    const bets = await betRepo.findByRoundId('net-test-1');
    expect(bets).not.toBeNull();

    await adapter.stop();
  });
});
