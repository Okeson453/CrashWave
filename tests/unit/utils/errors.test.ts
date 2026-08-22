import {
  AppError,
  CriticalError,
  TransientError,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../../../src/utils/errors';

describe('AppError', () => {
  it('should create with defaults', () => {
    const err = new AppError('test', 'TEST_CODE');
    expect(err.message).toBe('test');
    expect(err.code).toBe('TEST_CODE');
    expect(err.isCritical).toBe(false);
    expect(err.isTransient).toBe(false);
  });

  it('should capture metadata', () => {
    const err = new AppError('test', 'T', { metadata: { key: 'value' } });
    expect(err.metadata).toEqual({ key: 'value' });
  });

  it('should serialize to JSON', () => {
    const err = new AppError('test', 'T');
    const json = err.toJSON();
    expect(json.name).toBe('AppError');
    expect(json.message).toBe('test');
    expect(json.code).toBe('T');
  });
});

describe('CriticalError', () => {
  it('should be critical and not transient', () => {
    const err = new CriticalError('critical', 'CRIT');
    expect(err.isCritical).toBe(true);
    expect(err.isTransient).toBe(false);
  });
});

describe('TransientError', () => {
  it('should be transient and not critical', () => {
    const err = new TransientError('transient', 'TRANS');
    expect(err.isTransient).toBe(true);
    expect(err.isCritical).toBe(false);
  });
});

describe('ValidationError', () => {
  it('should have VALIDATION_ERROR code', () => {
    const err = new ValidationError('bad input');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.metadata).toEqual({});
  });
});

describe('NotFoundError', () => {
  it('should include resource info', () => {
    const err = new NotFoundError('User', '123');
    expect(err.message).toBe('User not found: 123');
    expect(err.metadata).toEqual({ entity: 'User', id: '123' });
  });
});

describe('ConflictError', () => {
  it('should have CONFLICT_ERROR code', () => {
    const err = new ConflictError('duplicate');
    expect(err.code).toBe('CONFLICT_ERROR');
  });
});
