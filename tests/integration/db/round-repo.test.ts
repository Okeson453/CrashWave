import { Pool } from 'pg';
import { RoundRepository } from '../../../src/persistence/repositories/round-repo';
import { getPool, closePool, createPool } from '../../../src/persistence/client';

describe('RoundRepository Integration', () => {
  let pool: Pool;
  let repo: RoundRepository;
  let testSessionId: string;

  beforeAll(async () => {
    createPool({
      connectionString: process.env.DATABASE_URL || 'postgresql://crashuser:crashpass@localhost:5432/crashautomation',
      poolSize: 5,
    });
    pool = getPool();
    repo = new RoundRepository(pool);
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // Clean up test data
    await pool.query("DELETE FROM rounds WHERE external_round_id LIKE 'test-%'");
    await pool.query("DELETE FROM sessions WHERE mode LIKE 'observe-only'");

    // Create a test session for foreign key reference
    const sessionResult = await pool.query(
      "INSERT INTO sessions (mode, status, config_version) VALUES ('observe-only', 'observing', 1) RETURNING id"
    );
    testSessionId = sessionResult.rows[0].id;
  });

  describe('create', () => {
    it('should create a new round record', async () => {
      const round = await repo.create({
        externalRoundId: 'test-round-001',
        sessionId: testSessionId,
        startedAt: new Date().toISOString(),
        observationSource: 'dom',
        dataQuality: 'high',
      });

      expect(round).toBeDefined();
      expect(round.id).toBeDefined();
      expect(round.externalRoundId).toBe('test-round-001');
      expect(round.sessionId).toBe(testSessionId);
    });

    it('should create round with crash point', async () => {
      const round = await repo.create({
        externalRoundId: 'test-round-002',
        sessionId: testSessionId,
        startedAt: new Date().toISOString(),
        crashedAt: new Date().toISOString(),
        observedCrashPoint: 3.45,
        finalConfirmedCrashPoint: 3.45,
        observationSource: 'dom',
        dataQuality: 'high',
      });

      expect(round.observedCrashPoint).toBe(3.45);
      expect(round.finalConfirmedCrashPoint).toBe(3.45);
    });
  });

  describe('findById', () => {
    it('should find round by ID', async () => {
      const created = await repo.create({
        externalRoundId: 'test-round-003',
        sessionId: testSessionId,
        observationSource: 'dom',
      });

      const found = await repo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.externalRoundId).toBe('test-round-003');
    });

    it('should return null for non-existent ID', async () => {
      const found = await repo.findById('non-existent-id');
      expect(found).toBeNull();
    });
  });

  describe('findByExternalId', () => {
    it('should find round by external ID', async () => {
      await repo.create({
        externalRoundId: 'test-round-004',
        sessionId: testSessionId,
        observationSource: 'dom',
      });

      const found = await repo.findByExternalId('test-round-004');

      expect(found).not.toBeNull();
      expect(found!.externalRoundId).toBe('test-round-004');
    });

    it('should return null for non-existent external ID', async () => {
      const found = await repo.findByExternalId('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('findBySessionId', () => {
    it('should find rounds by session ID', async () => {
      await repo.create({
        externalRoundId: 'test-round-005',
        sessionId: testSessionId,
        observationSource: 'dom',
      });

      await repo.create({
        externalRoundId: 'test-round-006',
        sessionId: testSessionId,
        observationSource: 'dom',
      });

      const rounds = await repo.findBySessionId(testSessionId);
      expect(rounds.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('update', () => {
    it('should update round with crash point', async () => {
      const created = await repo.create({
        externalRoundId: 'test-round-007',
        sessionId: testSessionId,
        startedAt: new Date().toISOString(),
        observationSource: 'dom',
      });

      const updated = await repo.update(created.id, {
        crashedAt: new Date().toISOString(),
        observedCrashPoint: 2.5,
        finalConfirmedCrashPoint: 2.5,
        dataQuality: 'high',
      });

      expect(updated).not.toBeNull();
      expect(updated!.observedCrashPoint).toBe(2.5);
      expect(updated!.finalConfirmedCrashPoint).toBe(2.5);
    });
  });

  describe('delete', () => {
    it('should delete a round', async () => {
      const created = await repo.create({
        externalRoundId: 'test-round-010',
        sessionId: testSessionId,
        observationSource: 'dom',
      });

      const deleted = await repo.delete(created.id);
      expect(deleted).toBe(true);

      const found = await repo.findById(created.id);
      expect(found).toBeNull();
    });
  });

  describe('count', () => {
    it('should return round count', async () => {
      const beforeCount = await repo.count();

      await repo.create({
        externalRoundId: 'test-round-011',
        sessionId: testSessionId,
        observationSource: 'dom',
      });

      const afterCount = await repo.count();
      expect(afterCount).toBe(beforeCount + 1);
    });
  });
});
