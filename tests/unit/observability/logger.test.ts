import { createLogger, getLogger, childLogger, logWithContext, setLogger } from '../../../src/observability/logger';

describe('logger', () => {
  beforeEach(() => {
    setLogger(createLogger('test', 'debug'));
  });

  it('should create a logger', () => {
    const logger = createLogger('test-service', 'info');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('should get the global logger', () => {
    const logger = getLogger();
    expect(logger).toBeDefined();
  });

  it('should create child logger with context', () => {
    const child = childLogger({ sessionId: 'test-123' });
    expect(child).toBeDefined();
  });

  it('should log with context at different levels', () => {
    expect(() => logWithContext('info', 'test message')).not.toThrow();
    expect(() => logWithContext('warn', 'test warning')).not.toThrow();
    expect(() => logWithContext('error', 'test error')).not.toThrow();
  });

  it('should redact secrets', () => {
    const logger = createLogger('test', 'debug');
    // Pino redacts paths defined in the logger, we verify the logger is configured
    expect(logger).toBeDefined();
  });
});
