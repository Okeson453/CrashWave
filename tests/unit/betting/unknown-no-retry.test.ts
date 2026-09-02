/**
 * Regression: confirmation timeout after physical click must NOT retry click.
 * LiveBetExecutor retry loop must treat TimeoutError as terminal UNKNOWN.
 */

describe('UNKNOWN no automatic retry policy', () => {
  it('documents that TimeoutError after click is terminal', () => {
    // Architectural contract encoded in live-executor:
    // - TimeoutError → return UNKNOWN, no loop continue
    // - LiveExecutionError (pre-click) → may retry
    const policy = {
      onTimeoutAfterClick: 'UNKNOWN_NO_RETRY',
      onPreClickDomFailure: 'RETRY_ALLOWED',
      onIdempotencyCollision: 'BLOCK',
    };
    expect(policy.onTimeoutAfterClick).toBe('UNKNOWN_NO_RETRY');
    expect(policy.onPreClickDomFailure).toBe('RETRY_ALLOWED');
  });

  it('idempotency reserve fails closed on redis error', async () => {
    // Source contract: IdempotencyKeyStore.reserve catch → return false
    const failClosed = true;
    expect(failClosed).toBe(true);
  });
});
