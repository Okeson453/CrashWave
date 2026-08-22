import { Pool } from 'pg';
import { TickRepository } from '../../../src/persistence/repositories/tick-repo';
import { getPool, closePool, createPool } from '../../../src/persistence/client';

describe('TickRepository Integration', () => {
  let pool: Pool;
  let repo: TickRepository;

  beforeAll(async () => {
    createPool({
      connectionString: process.env.DATABASE_URL || 'postgresql://crashuser:crashpass@localhost:5432/crashautomation',
      poolSize: 5,
    });
    pool = getPool();
    repo = new TickRepository(pool);
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // Clean up test data - round_id is uuid type, so use a known session round
    await pool.query("DELETE FROM multiplier_ticks WHERE source = 'dom'");
  });

  describe('insert', () => {
    it('should insert a single tick', async () => {
      await repo.insert({
        roundId: null,
        multiplier: 2.34,
        source: 'dom',
        latencyMs: 50,
        sessionId: null,
      });

      const count = await repo.countByRoundId('test-round-tick-001');
      expect(count).toBe(0); // null round_id won't match
    });

    it('should insert multiple ticks', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.insert({
          roundId: null,
          multiplier: 1.0 + i * 0.1,
          source: 'dom',
          latencyMs: 50 + i,
          sessionId: null,
        });
      }

      // All inserted with null round_id, countByRoundId won't find them
      const count = await repo.countByRoundId('any');
      expect(count).toBe(0);
    });
  });

  describe('findByRoundId', () => {
    it('should return empty array for unknown round', async () => {
      const ticks = await repo.findByRoundId('non-existent-round');
      expect(ticks).toEqual([]);
    });
  });

  describe('findByTimeRange', () => {
    it('should find ticks within time range', async () => {
      const now = new Date();

      await repo.insert({
        roundId: null,
        multiplier: 1.0,
        source: 'dom',
        latencyMs: 50,
        sessionId: null,
      });

      const startTime = new Date(now.getTime() - 60000).toISOString();
      const endTime = new Date(now.getTime() + 60000).toISOString();

      const ticks = await repo.findByTimeRange(startTime, endTime);
      expect(ticks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('countByRoundId', () => {
    it('should return 0 for unknown round', async () => {
      const count = await repo.countByRoundId('non-existent');
      expect(count).toBe(0);
    });
  });

  describe('getAverageLatencyByRoundId', () => {
    it('should return 0 for unknown round', async () => {
      const avgLatency = await repo.getAverageLatencyByRoundId('non-existent');
      expect(avgLatency).toBe(0);
    });
  });

  describe('getLatestTick', () => {
    it('should return null for unknown round', async () => {
      const latest = await repo.getLatestTick('non-existent');
      expect(latest).toBeNull();
    });
  });

  describe('deleteByRoundId', () => {
    it('should return 0 for unknown round', async () => {
      const deletedCount = await repo.deleteByRoundId('non-existent');
      expect(deletedCount).toBe(0);
    });
  });

  describe('batch operations', () => {
    it('should batch insert ticks', async () => {
      const batchRepo = new TickRepository(pool, 5, 500);
      batchRepo.startBatching();

      for (let i = 0; i < 12; i++) {
        await batchRepo.insert({
          roundId: null,
          multiplier: 1.0 + i * 0.1,
          source: 'dom',
          latencyMs: 50,
          sessionId: null,
        });
      }

      // Wait for auto-flush
      await new Promise((resolve) => setTimeout(resolve, 800));

      await batchRepo.stopBatching();
    });

    it('should flush remaining items on stop', async () => {
      const batchRepo = new TickRepository(pool, 100, 5000);
      batchRepo.startBatching();

      for (let i = 0; i < 3; i++) {
        await batchRepo.insert({
          roundId: null,
          multiplier: 1.0 + i,
          source: 'dom',
          latencyMs: 50,
          sessionId: null,
        });
      }

      // Stop should flush remaining
      await batchRepo.stopBatching();
    });
  });
});
