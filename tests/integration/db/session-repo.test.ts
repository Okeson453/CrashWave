import { Pool } from 'pg';
import { SessionRepository } from '../../../src/persistence/repositories/session-repo';
import { getPool, closePool, createPool } from '../../../src/persistence/client';

describe('SessionRepository Integration', () => {
  let pool: Pool;
  let repo: SessionRepository;

  beforeAll(async () => {
    createPool({
      connectionString: process.env.DATABASE_URL || 'postgresql://crashuser:crashpass@localhost:5432/crashautomation',
      poolSize: 5,
    });
    pool = getPool();
    repo = new SessionRepository(pool);
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // Clean up test data
    await pool.query("DELETE FROM sessions WHERE mode LIKE 'test-%'");
  });

  describe('create', () => {
    it('should create a new session', async () => {
      const session = await repo.create({
        mode: 'observe-only',
        status: 'initializing',
        configVersion: 1,
        notes: 'Test session',
      });

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.mode).toBe('observe-only');
      expect(session.status).toBe('initializing');
      expect(session.configVersion).toBe(1);
      expect(session.notes).toBe('Test session');
      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
    });

    it('should create session with null notes', async () => {
      const session = await repo.create({
        mode: 'observe-only',
        status: 'observing',
        configVersion: 1,
      });

      expect(session.notes).toBeNull();
    });
  });

  describe('findById', () => {
    it('should find session by ID', async () => {
      const created = await repo.create({
        mode: 'observe-only',
        status: 'observing',
        configVersion: 1,
      });

      const found = await repo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.mode).toBe('observe-only');
    });

    it('should return null for non-existent ID', async () => {
      const found = await repo.findById('non-existent-id');
      expect(found).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should list sessions with pagination', async () => {
      // Create multiple sessions
      for (let i = 0; i < 3; i++) {
        await repo.create({
          mode: 'observe-only',
          status: 'observing',
          configVersion: 1,
        });
      }

      const sessions = await repo.findAll(10, 0);
      expect(sessions.length).toBeGreaterThanOrEqual(3);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.create({
          mode: 'observe-only',
          status: 'observing',
          configVersion: 1,
        });
      }

      const sessions = await repo.findAll(2, 0);
      expect(sessions.length).toBeLessThanOrEqual(2);
    });
  });

  describe('findByStatus', () => {
    it('should find sessions by status', async () => {
      await repo.create({
        mode: 'observe-only',
        status: 'stopped',
        configVersion: 1,
      });

      const sessions = await repo.findByStatus('stopped');
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions[0].status).toBe('stopped');
    });
  });

  describe('update', () => {
    it('should update session fields', async () => {
      const created = await repo.create({
        mode: 'observe-only',
        status: 'initializing',
        configVersion: 1,
      });

      const updated = await repo.update(created.id, {
        status: 'observing',
        notes: 'Updated notes',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('observing');
      expect(updated!.notes).toBe('Updated notes');
      expect(updated!.mode).toBe('observe-only'); // Unchanged
    });

    it('should return null for non-existent ID', async () => {
      const updated = await repo.update('non-existent-id', { status: 'stopped' });
      expect(updated).toBeNull();
    });

    it('should not update when no fields provided', async () => {
      const created = await repo.create({
        mode: 'observe-only',
        status: 'observing',
        configVersion: 1,
      });

      const updated = await repo.update(created.id, {});
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('observing');
    });
  });

  describe('delete', () => {
    it('should delete a session', async () => {
      const created = await repo.create({
        mode: 'observe-only',
        status: 'observing',
        configVersion: 1,
      });

      const deleted = await repo.delete(created.id);
      expect(deleted).toBe(true);

      const found = await repo.findById(created.id);
      expect(found).toBeNull();
    });

    it('should return false for non-existent ID', async () => {
      const deleted = await repo.delete('non-existent-id');
      expect(deleted).toBe(false);
    });
  });

  describe('count', () => {
    it('should return the total count of sessions', async () => {
      const beforeCount = await repo.count();

      await repo.create({
        mode: 'observe-only',
        status: 'observing',
        configVersion: 1,
      });

      const afterCount = await repo.count();
      expect(afterCount).toBe(beforeCount + 1);
    });
  });
});
