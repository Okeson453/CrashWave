import { createPool } from '../../src/persistence/client';
import { createRedisClient } from '../../src/persistence/redis-client';

beforeAll(() => {
  createPool({
    connectionString: process.env.DATABASE_URL || 'postgresql://crashuser:crashpass@localhost:5432/crashautomation',
    poolSize: 5,
  });

  createRedisClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379/0',
  });
});
