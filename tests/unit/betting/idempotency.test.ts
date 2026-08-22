import { InMemoryIdempotencyStore } from '../../../src/betting/idempotency';

describe('InMemoryIdempotencyStore', () => {
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
  });

  afterEach(() => {
    store.clear();
    store.dispose();
  });

  describe('reserve', () => {
    it('reserves a new key', async () => {
      const result = await store.reserve('session-1', 'round-1', 'bet-1');
      expect(result).toBe(true);
    });

    it('rejects duplicate reservation', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      const result = await store.reserve('session-1', 'round-1', 'bet-2');
      expect(result).toBe(false);
    });

    it('allows different session same round', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      const result = await store.reserve('session-2', 'round-1', 'bet-2');
      expect(result).toBe(true);
    });

    it('allows same session different round', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      const result = await store.reserve('session-1', 'round-2', 'bet-2');
      expect(result).toBe(true);
    });
  });

  describe('complete', () => {
    it('marks reserved key as completed', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      await store.complete('session-1', 'round-1', { success: true, betId: 'bet-1' });
      const record = await store.getRecord('session-1', 'round-1');
      expect(record?.status).toBe('COMPLETED');
      expect(record?.result?.success).toBe(true);
    });

    it('does nothing for non-existent key', async () => {
      await store.complete('session-1', 'round-1', { success: true, betId: 'bet-1' });
      const record = await store.getRecord('session-1', 'round-1');
      expect(record).toBeNull();
    });
  });

  describe('fail', () => {
    it('marks reserved key as failed', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      await store.fail('session-1', 'round-1', 'timeout');
      const record = await store.getRecord('session-1', 'round-1');
      expect(record?.status).toBe('FAILED');
      expect(record?.result?.success).toBe(false);
    });
  });

  describe('release', () => {
    it('removes the key', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      await store.release('session-1', 'round-1');
      const exists = await store.exists('session-1', 'round-1');
      expect(exists).toBe(false);
    });
  });

  describe('hasStatus', () => {
    it('returns true for matching status', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      const result = await store.hasStatus('session-1', 'round-1', 'PENDING');
      expect(result).toBe(true);
    });

    it('returns false for non-matching status', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      const result = await store.hasStatus('session-1', 'round-1', 'COMPLETED');
      expect(result).toBe(false);
    });
  });

  describe('exists', () => {
    it('returns true for existing key', async () => {
      await store.reserve('session-1', 'round-1', 'bet-1');
      expect(await store.exists('session-1', 'round-1')).toBe(true);
    });

    it('returns false for non-existing key', async () => {
      expect(await store.exists('session-1', 'round-1')).toBe(false);
    });
  });

  describe('generateKey', () => {
    it('generates deterministic keys', () => {
      const key1 = InMemoryIdempotencyStore.generateKey('s1', 'r1');
      const key2 = InMemoryIdempotencyStore.generateKey('s1', 'r1');
      expect(key1).toBe(key2);
      expect(key1).toBe('s1:r1');
    });
  });

  describe('cleanup', () => {
    it('removes expired entries', async () => {
      // In-memory store doesn't use real TTL, but cleanup should work
      await store.reserve('session-1', 'round-1', 'bet-1');
      const removed = await store.cleanup();
      expect(removed).toBe(0); // No entries expired yet
    });
  });
});
