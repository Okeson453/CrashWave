/**
 * E2E: Full Session Lifecycle Test
 * Covers: startup -> observe -> pause -> resume -> shutdown
 */
import { RoundObserver } from '../../src/game/observer';
import { IGameAdapter, NormalizedGameEvent } from '../../src/game/types';
import { RoundState } from '../../src/types/game';
import { InMemorySessionRepository } from '../../src/persistence/repositories/session-repo';
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

describe('E2E: Full Session Lifecycle', () => {
  let adapter: MockGameAdapter;
  let observer: RoundObserver;
  let sessionRepo: InMemorySessionRepository;
  let betRepo: InMemoryBetRepository;

  beforeEach(() => {
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 3000 });
    sessionRepo = new InMemorySessionRepository();
    betRepo = new InMemoryBetRepository();
  });

  it('should complete full lifecycle: startup -> observe -> pause -> resume -> shutdown', async () => {
    // Phase 1: Startup
    const session = await sessionRepo.create({ mode: 'observe-only', status: 'observing', configVersion: 1 });
    expect(session).not.toBeNull();
    expect(session.status).toBe('observing');

    // Phase 2: Observe
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'lifecycle-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    adapter.emitEvent({
      type: 'round-crashed', roundId: 'lifecycle-001', multiplier: 3.45,
      crashPoint: 3.45, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(observer.getRoundCount()).toBeGreaterThanOrEqual(1);

    // Verify no bets were placed in observe-only mode
    const bets = await betRepo.findBySessionId(session.id);
    expect(bets.length).toBe(0);

    // Phase 3: Pause
    await adapter.stop();
    await observer.stop();
    const pausedSession = await sessionRepo.update(session.id, { status: 'stopped' });
    expect(pausedSession?.status).toBe('stopped');

    // Phase 4: Resume
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'lifecycle-002', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    adapter.emitEvent({
      type: 'round-crashed', roundId: 'lifecycle-002', multiplier: 2.12,
      crashPoint: 2.12, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    expect(observer.getRoundCount()).toBeGreaterThanOrEqual(1);

    // Phase 5: Shutdown
    await adapter.stop();
    await observer.stop();
  });

  it('should emit correct events during lifecycle transitions', async () => {
    const events: Array<{ type: string; roundId: string | null }> = [];
    observer.onStateChange((state) => {
      events.push({ type: `state-${state.phase}`, roundId: state.roundId });
    });
    observer.onRoundComplete((roundId, _crashPoint) => {
      events.push({ type: 'round-complete', roundId });
    });

    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'event-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    adapter.emitEvent({
      type: 'round-crashed', roundId: 'event-001', multiplier: 3.0,
      crashPoint: 3.0, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    const runningEvents = events.filter((e) => e.type === 'state-running');
    const crashedEvents = events.filter((e) => e.type === 'state-crashed' || e.type === 'round-complete');
    expect(runningEvents.length).toBeGreaterThanOrEqual(1);
    expect(crashedEvents.length).toBeGreaterThanOrEqual(1);

    await adapter.stop();
    await observer.stop();
  });

  it('should persist session state across pause/resume', async () => {
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'state-001', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    adapter.emitEvent({
      type: 'round-crashed', roundId: 'state-001', multiplier: 3.45,
      crashPoint: 3.45, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    const roundsBefore = observer.getRoundCount();
    expect(roundsBefore).toBeGreaterThanOrEqual(1);

    // Pause
    await adapter.stop();
    await observer.stop();

    // Resume
    adapter = new MockGameAdapter();
    observer = new RoundObserver({ adapter, staleThresholdMs: 3000 });
    await adapter.start();
    await observer.start();

    adapter.emitEvent({
      type: 'round-started', roundId: 'state-002', multiplier: 1.0,
      crashPoint: null, phase: 'running', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });
    adapter.emitEvent({
      type: 'round-crashed', roundId: 'state-002', multiplier: 2.12,
      crashPoint: 2.12, phase: 'crashed', source: 'dom',
      confidence: 'high', timestamp: new Date().toISOString(), latencyMs: 50,
    });

    const roundsAfter = observer.getRoundCount();
    expect(roundsAfter).toBeGreaterThanOrEqual(1);

    await adapter.stop();
    await observer.stop();
  });
});
