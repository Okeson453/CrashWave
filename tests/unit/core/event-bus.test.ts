import { EventBus, createEventBus, getEventBus } from '../../../src/core/event-bus/bus';
import { InMemoryPersistentLog } from '../../../src/core/event-bus/persistent-log';
import { createEvent } from '../../../src/core/event-bus/events';

describe('EventBus', () => {
  let bus: EventBus;
  let log: InMemoryPersistentLog;

  beforeEach(() => {
    log = new InMemoryPersistentLog();
    bus = new EventBus({ persistentLog: log });
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  it('should emit and receive events', async () => {
    const handler = jest.fn();
    bus.on('RoundStarted', handler);

    const event = createEvent('RoundStarted', { roundId: 'r1', sessionId: 's1', startedAt: new Date().toISOString() }, {
      correlationId: 'corr-1',
      source: 'test',
    });

    await bus.emit(event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'RoundStarted',
      payload: expect.objectContaining({ roundId: 'r1' }),
    }));
  });

  it('should persist events', async () => {
    const event = createEvent('RoundStarted', { roundId: 'r1', sessionId: 's1', startedAt: new Date().toISOString() }, {
      correlationId: 'corr-1',
      source: 'test',
    });

    await bus.emit(event);
    expect(log.size()).toBe(1);
    const entries = log.getEntries();
    expect(entries[0].eventType).toBe('RoundStarted');
    expect(entries[0].correlationId).toBe('corr-1');
  });

  it('should support typed emit', async () => {
    const handler = jest.fn();
    bus.on('BetPlaced', handler);

    await bus.emitTyped('BetPlaced', {
      betId: 'b1',
      roundId: 'r1',
      sessionId: 's1',
      stake: 700,
      target: 1.30,
    }, 'corr-2', 'test');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'BetPlaced',
    }));
  });

  it('should support once listeners', async () => {
    const handler = jest.fn();
    bus.once('RoundCrashed', handler);

    const event = createEvent('RoundCrashed', { roundId: 'r1', crashPoint: 1.45, crashedAt: new Date().toISOString() }, {
      correlationId: 'corr-1',
      source: 'test',
    });

    await bus.emit(event);
    await bus.emit(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe with returned function', async () => {
    const handler = jest.fn();
    const unsubscribe = bus.on('RoundStarted', handler);

    const event = createEvent('RoundStarted', { roundId: 'r1', sessionId: 's1', startedAt: new Date().toISOString() }, {
      correlationId: 'corr-1',
      source: 'test',
    });

    await bus.emit(event);
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    await bus.emit(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should count listeners', () => {
    bus.on('RoundStarted', () => {});
    bus.on('RoundStarted', () => {});
    expect(bus.listenerCount('RoundStarted')).toBe(2);
  });

  it('should handle handler errors gracefully', async () => {
    const badHandler = jest.fn().mockRejectedValue(new Error('handler error'));
    const goodHandler = jest.fn();
    bus.on('RoundStarted', badHandler);
    bus.on('RoundStarted', goodHandler);

    const event = createEvent('RoundStarted', { roundId: 'r1', sessionId: 's1', startedAt: new Date().toISOString() }, {
      correlationId: 'corr-1',
      source: 'test',
    });

    await bus.emit(event);
    expect(badHandler).toHaveBeenCalled();
    expect(goodHandler).toHaveBeenCalled();
  });

  it('should support multiple event types', async () => {
    const roundHandler = jest.fn();
    const betHandler = jest.fn();
    bus.on('RoundStarted', roundHandler);
    bus.on('BetPlaced', betHandler);

    await bus.emitTyped('RoundStarted', { roundId: 'r1', sessionId: 's1', startedAt: new Date().toISOString() }, 'c1', 'test');
    await bus.emitTyped('BetPlaced', { betId: 'b1', roundId: 'r1', sessionId: 's1', stake: 700, target: 1.30 }, 'c2', 'test');

    expect(roundHandler).toHaveBeenCalledTimes(1);
    expect(betHandler).toHaveBeenCalledTimes(1);
  });
});

describe('createEventBus / getEventBus', () => {
  beforeEach(() => {
    // Reset global bus
    const bus = createEventBus();
    bus.removeAllListeners();
  });

  it('should create and return global bus', () => {
    const bus1 = createEventBus();
    const bus2 = getEventBus();
    expect(bus2).toBe(bus1);
  });
});

describe('InMemoryPersistentLog', () => {
  let log: InMemoryPersistentLog;

  beforeEach(() => {
    log = new InMemoryPersistentLog();
  });

  it('should store and retrieve entries', async () => {
    await log.write({
      id: '1', eventType: 'Test', payload: {}, timestamp: 't1',
      correlationId: 'c1', source: 'test', persistedAt: 't1',
    });
    expect(log.size()).toBe(1);
  });

  it('should filter by type', async () => {
    await log.write({ id: '1', eventType: 'A', payload: {}, timestamp: 't1', correlationId: 'c1', source: 'test', persistedAt: 't1' });
    await log.write({ id: '2', eventType: 'B', payload: {}, timestamp: 't2', correlationId: 'c2', source: 'test', persistedAt: 't2' });
    const entries = log.getEntriesByType('A');
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe('A');
  });

  it('should filter by correlationId', async () => {
    await log.write({ id: '1', eventType: 'A', payload: {}, timestamp: 't1', correlationId: 'c1', source: 'test', persistedAt: 't1' });
    await log.write({ id: '2', eventType: 'B', payload: {}, timestamp: 't2', correlationId: 'c1', source: 'test', persistedAt: 't2' });
    const entries = log.getEntriesByCorrelationId('c1');
    expect(entries).toHaveLength(2);
  });

  it('should enforce max entries', async () => {
    const smallLog = new InMemoryPersistentLog(2);
    await smallLog.write({ id: '1', eventType: 'A', payload: {}, timestamp: 't1', correlationId: 'c1', source: 'test', persistedAt: 't1' });
    await smallLog.write({ id: '2', eventType: 'B', payload: {}, timestamp: 't2', correlationId: 'c2', source: 'test', persistedAt: 't2' });
    await smallLog.write({ id: '3', eventType: 'C', payload: {}, timestamp: 't3', correlationId: 'c3', source: 'test', persistedAt: 't3' });
    expect(smallLog.size()).toBe(2);
  });
});
