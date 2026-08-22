import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { getLogger } from '../observability/logger';

export interface MigrationRecord {
  version: string;
  appliedAt: Date;
  checksum: string;
}

export interface MigrationRunner {
  run(): Promise<MigrationRecord[]>;
  getPending(): Promise<string[]>;
}

export class FileMigrationRunner implements MigrationRunner {
  private readonly pool: Pool;
  private readonly migrationsDir: string;
  private readonly tableName = 'schema_migrations';

  constructor(pool: Pool, migrationsDir: string) {
    this.pool = pool;
    this.migrationsDir = migrationsDir;
  }

  async ensureMigrationTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum VARCHAR(64) NOT NULL
      )
    `);
  }

  private getMigrations(): Array<{ filename: string; version: string; content: string }> {
    const files = readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    return files.map((filename) => ({
      filename,
      version: basename(filename, '.sql'),
      content: readFileSync(join(this.migrationsDir, filename), 'utf-8'),
    }));
  }

  private computeChecksum(content: string): string {
    const { createHash } = require('crypto');
    return createHash('sha256').update(content).digest('hex');
  }

  async getApplied(): Promise<Map<string, string>> {
    const result = await this.pool.query(`SELECT version, checksum FROM ${this.tableName}`);
    const map = new Map<string, string>();
    for (const row of result.rows) {
      map.set(row.version, row.checksum);
    }
    return map;
  }

  async getPending(): Promise<string[]> {
    await this.ensureMigrationTable();
    const applied = await this.getApplied();
    const migrations = this.getMigrations();
    return migrations
      .filter((m) => !applied.has(m.version))
      .map((m) => m.filename);
  }

  async run(): Promise<MigrationRecord[]> {
    await this.ensureMigrationTable();
    const applied = await this.getApplied();
    const migrations = this.getMigrations();
    const records: MigrationRecord[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        const expectedChecksum = this.computeChecksum(migration.content);
        const actualChecksum = applied.get(migration.version);
        if (actualChecksum !== expectedChecksum) {
          throw new Error(
            `Migration checksum mismatch for ${migration.filename}. ` +
            `Expected: ${expectedChecksum}, Got: ${actualChecksum}. ` +
            `Do NOT modify applied migrations.`
          );
        }
        getLogger().debug(
          { component: 'MigrationRunner' },
          `Skipping already applied: ${migration.filename}`
        );
        continue;
      }

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration.content);
        const checksum = this.computeChecksum(migration.content);
        await client.query(
          `INSERT INTO ${this.tableName} (version, checksum) VALUES ($1, $2)`,
          [migration.version, checksum]
        );
        await client.query('COMMIT');
        records.push({
          version: migration.version,
          appliedAt: new Date(),
          checksum,
        });
        getLogger().info(
          { component: 'MigrationRunner' },
          `Applied migration: ${migration.filename}`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    return records;
  }
}
