import { getRedisClient, createRedisClient } from '../../../src/persistence/redis-client';

describe('Redis Connection Integration', () => {
  let client: ReturnType<typeof getRedisClient>;

  beforeAll(() => {
    createRedisClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379/0',
    });
    client = getRedisClient();
  });

  afterAll(async () => {
    const client = getRedisClient();
    await client.quit();
  });

  describe('basic operations', () => {
    it('should set and get a value', async () => {
      const key = 'test:connection:key1';
      const value = 'hello-redis';

      await client.set(key, value);
      const result = await client.get(key);

      expect(result).toBe(value);

      // Cleanup
      await client.del(key);
    });

    it('should handle non-existent keys', async () => {
      const result = await client.get('test:connection:non-existent');
      expect(result).toBeNull();
    });

    it('should delete keys', async () => {
      const key = 'test:connection:delete-me';
      await client.set(key, 'value');

      const deleted = await client.del(key);
      expect(deleted).toBe(1);

      const result = await client.get(key);
      expect(result).toBeNull();
    });
  });

  describe('hash operations', () => {
    it('should set and get hash fields', async () => {
      const key = 'test:connection:hash1';

      await client.hset(key, 'field1', 'value1');
      await client.hset(key, 'field2', 'value2');

      const result = await client.hgetall(key);
      expect(result).toEqual({ field1: 'value1', field2: 'value2' });

      // Cleanup
      await client.del(key);
    });
  });

  describe('list operations', () => {
    it('should push and pop from list', async () => {
      const key = 'test:connection:list1';

      await client.lpush(key, 'item1', 'item2', 'item3');

      const length = await client.llen(key);
      expect(length).toBe(3);

      const item = await client.rpop(key);
      expect(item).toBe('item1');

      // Cleanup
      await client.del(key);
    });
  });

  describe('pub/sub', () => {
    it('should publish and receive messages', async () => {
      const channel = 'test:connection:channel';
      const message = 'test-message';

      // Create a subscriber client
      const subscriber = getRedisClient().duplicate();
      await subscriber.connect();

      const receivedMessages: string[] = [];

      subscriber.on('message', (_ch: string, msg: string) => {
        receivedMessages.push(msg);
      });
      await subscriber.subscribe(channel);

      // Publish message
      await client.publish(channel, message);

      // Wait for message
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedMessages).toContain(message);

      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    });
  });

  describe('expiration', () => {
    it('should set keys with expiration', async () => {
      const key = 'test:connection:expire';

      await client.set(key, 'value', 'EX', 1);

      const existsBefore = await client.exists(key);
      expect(existsBefore).toBe(1);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const existsAfter = await client.exists(key);
      expect(existsAfter).toBe(0);
    });
  });

  describe('connection health', () => {
    it('should report connection status', async () => {
      const isReady = client.status === 'ready';
      expect(isReady).toBe(true);
    });

    it('should handle multiple operations', async () => {
      const keyPrefix = 'test:connection:multi';
      const operations = [];

      for (let i = 0; i < 10; i++) {
        operations.push(client.set(`${keyPrefix}:${i}`, `value-${i}`));
      }

      await Promise.all(operations);

      for (let i = 0; i < 10; i++) {
        const value = await client.get(`${keyPrefix}:${i}`);
        expect(value).toBe(`value-${i}`);
      }

      // Cleanup
      const keys = [];
      for (let i = 0; i < 10; i++) {
        keys.push(`${keyPrefix}:${i}`);
      }
      await client.del(...keys);
    });
  });
});
