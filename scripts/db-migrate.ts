import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const TABLE_NAME = 'schema_migrations';

interface Migration {
  filename: string;
  version: string;
  content: string;
}

function getMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  return files.map((filename) => ({
    filename,
    version: basename(filename, '.sql'),
    content: readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8'),
  }));
}

async function ensureMigrationTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum VARCHAR(64) NOT NULL
    )
  `);
}

function computeChecksum(content: string): string {
  const { createHash } = require('crypto');
  return createHash('sha256').update(content).digest('hex');
}

async function getAppliedMigrations(pool: Pool): Promise<Map<string, string>> {
  const result = await pool.query(`SELECT version, checksum FROM ${TABLE_NAME}`);
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.version, row.checksum);
  }
  return map;
}

async function applyMigration(pool: Pool, migration: Migration): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(migration.content);
    const checksum = computeChecksum(migration.content);
    await client.query(
      `INSERT INTO ${TABLE_NAME} (version, checksum) VALUES ($1, $2)`,
      [migration.version, checksum]
    );
    await client.query('COMMIT');
    console.log(`Applied migration: ${migration.filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
  });

  try {
    await ensureMigrationTable(pool);
    const applied = await getAppliedMigrations(pool);
    const migrations = getMigrations();

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        const expectedChecksum = computeChecksum(migration.content);
        const actualChecksum = applied.get(migration.version);
        if (actualChecksum !== expectedChecksum) {
          console.error(
            `Migration checksum mismatch for ${migration.filename}. ` +
            `Expected: ${expectedChecksum}, Got: ${actualChecksum}. ` +
            `Do NOT modify applied migrations.`
          );
          process.exit(1);
        }
        console.log(`Skipping already applied: ${migration.filename}`);
        continue;
      }

      await applyMigration(pool, migration);
    }

    console.log('All migrations applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
