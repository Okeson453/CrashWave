import { sha256, sha512, deterministicHash, hashForIdempotencyKey, hashForAuditTrail, hashForConfigVersion } from '../../../src/security/hash';

describe('sha256', () => {
  it('should produce consistent hashes', () => {
    const h1 = sha256('test');
    const h2 = sha256('test');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('should produce different hashes for different inputs', () => {
    const h1 = sha256('a');
    const h2 = sha256('b');
    expect(h1).not.toBe(h2);
  });
});

describe('sha512', () => {
  it('should produce 128 char hex', () => {
    const h = sha512('test');
    expect(h).toHaveLength(128);
  });
});

describe('deterministicHash', () => {
  it('should produce consistent hashes for same inputs', () => {
    const h1 = deterministicHash(['a', 1, true]);
    const h2 = deterministicHash(['a', 1, true]);
    expect(h1).toBe(h2);
  });

  it('should produce different hashes for different inputs', () => {
    const h1 = deterministicHash(['a', 1, true]);
    const h2 = deterministicHash(['a', 1, false]);
    expect(h1).not.toBe(h2);
  });
});

describe('hashForIdempotencyKey', () => {
  it('should produce consistent keys', () => {
    const k1 = hashForIdempotencyKey('session-1', 'round-1');
    const k2 = hashForIdempotencyKey('session-1', 'round-1');
    expect(k1).toBe(k2);
  });

  it('should produce different keys for different inputs', () => {
    const k1 = hashForIdempotencyKey('session-1', 'round-1');
    const k2 = hashForIdempotencyKey('session-1', 'round-2');
    expect(k1).not.toBe(k2);
  });
});

describe('hashForAuditTrail', () => {
  it('should produce consistent hashes', () => {
    const h1 = hashForAuditTrail('user', 'action', 'type', 'id', 'ts', 'payload');
    const h2 = hashForAuditTrail('user', 'action', 'type', 'id', 'ts', 'payload');
    expect(h1).toBe(h2);
  });
});

describe('hashForConfigVersion', () => {
  it('should produce consistent hashes', () => {
    const h1 = hashForConfigVersion(700, 1.30, 100, 'user', 'ts');
    const h2 = hashForConfigVersion(700, 1.30, 100, 'user', 'ts');
    expect(h1).toBe(h2);
  });
});
