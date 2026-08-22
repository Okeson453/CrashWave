import { HealthMonitor } from '../../../src/observability/health/monitor';
import { StaticHealthCheck, DatabaseHealthCheck, RedisHealthCheck } from '../../../src/observability/health/checks';
import { HealthStatus } from '../../../src/types/health';

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      intervalMs: 100,
      degradationThreshold: 2,
      failureThreshold: 3,
    });
  });

  afterEach(() => {
    monitor.stop();
    monitor.removeAllListeners();
  });

  it('should register and run checks', async () => {
    monitor.registerCheck(new StaticHealthCheck('test', 'OK', 'all good'));
    const result = await monitor.runChecks();
    expect(result.overallStatus).toBe('OK');
    expect(result.components).toHaveLength(1);
    expect(result.components[0].component).toBe('test');
  });

  it('should detect degraded state', async () => {
    monitor.registerCheck(new StaticHealthCheck('a', 'OK', 'ok'));
    monitor.registerCheck(new StaticHealthCheck('b', 'DEGRADED', 'slow'));
    const result = await monitor.runChecks();
    expect(result.overallStatus).toBe('DEGRADED');
  });

  it('should detect failing state', async () => {
    monitor.registerCheck(new StaticHealthCheck('a', 'OK', 'ok'));
    monitor.registerCheck(new StaticHealthCheck('b', 'FAILING', 'down'));
    const result = await monitor.runChecks();
    expect(result.overallStatus).toBe('FAILING');
  });

  it('should emit degraded event after threshold', async () => {
    const degradedSpy = jest.fn();
    monitor.on('degraded', degradedSpy);
    monitor.registerCheck(new StaticHealthCheck('test', 'DEGRADED', 'slow'));

    await monitor.runChecks();
    await monitor.runChecks();
    const result = await monitor.runChecks();

    expect(degradedSpy).toHaveBeenCalled();
    expect(result.overallStatus).toBe('DEGRADED');
  });

  it('should emit failing event after threshold', async () => {
    const failingSpy = jest.fn();
    monitor.on('failing', failingSpy);
    monitor.registerCheck(new StaticHealthCheck('test', 'FAILING', 'down'));

    await monitor.runChecks();
    await monitor.runChecks();
    await monitor.runChecks();

    expect(failingSpy).toHaveBeenCalled();
  });

  it('should start and stop interval', () => {
    monitor.registerCheck(new StaticHealthCheck('test', 'OK', 'ok'));
    monitor.start();
    expect(monitor).toBeDefined();
    monitor.stop();
  });

  it('should return last result', async () => {
    monitor.registerCheck(new StaticHealthCheck('test', 'OK', 'ok'));
    await monitor.runChecks();
    const last = monitor.getLastResult();
    expect(last).toBeDefined();
    expect(last?.overallStatus).toBe('OK');
  });

  it('should check health status', async () => {
    monitor.registerCheck(new StaticHealthCheck('test', 'OK', 'ok'));
    await monitor.runChecks();
    expect(monitor.isHealthy()).toBe(true);
  });

  it('should handle check exceptions gracefully', async () => {
    const badCheck = {
      name: 'bad',
      execute: async () => { throw new Error('boom'); },
    };
    monitor.registerCheck(badCheck as any);
    const result = await monitor.runChecks();
    expect(result.overallStatus).toBe('FAILING');
    expect(result.components[0].status).toBe('FAILING');
  });
});

describe('StaticHealthCheck', () => {
  it('should return configured status', async () => {
    const check = new StaticHealthCheck('test', 'OK' as HealthStatus, 'message');
    const result = await check.execute();
    expect(result.component).toBe('test');
    expect(result.status).toBe('OK');
    expect(result.message).toBe('message');
  });
});

describe('DatabaseHealthCheck', () => {
  it('should return OK on success', async () => {
    const check = new DatabaseHealthCheck(async () => true);
    const result = await check.execute();
    expect(result.status).toBe('OK');
  });

  it('should return FAILING on false', async () => {
    const check = new DatabaseHealthCheck(async () => false);
    const result = await check.execute();
    expect(result.status).toBe('FAILING');
  });

  it('should return FAILING on exception', async () => {
    const check = new DatabaseHealthCheck(async () => { throw new Error('db down'); });
    const result = await check.execute();
    expect(result.status).toBe('FAILING');
    expect(result.message).toContain('db down');
  });
});

describe('RedisHealthCheck', () => {
  it('should return OK on success', async () => {
    const check = new RedisHealthCheck(async () => true);
    const result = await check.execute();
    expect(result.status).toBe('OK');
  });

  it('should return FAILING on false', async () => {
    const check = new RedisHealthCheck(async () => false);
    const result = await check.execute();
    expect(result.status).toBe('FAILING');
  });
});
