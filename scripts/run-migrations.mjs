#!/usr/bin/env node
/**
 * Production-safe migration runner (no tsx required).
 * Applies migrations/*.sql in order, tracked in schema_migrations.
 */
import { createHash } from 'crypto';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || join(ROOT, 'migrations');
const TABLE = 'schema_migrations';

function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

function loadMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({
      filename,
      version: basename(filename, '.sql'),
      content: readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'),
    }));
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const skip = (process.env.SKIP_MIGRATIONS || '').toLowerCase();
  if (skip === '1' || skip === 'true' || skip === 'yes') {
    console.log('SKIP_MIGRATIONS set — skipping schema migrations');
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum VARCHAR(64) NOT NULL
      )
    `);

    const { rows } = await pool.query(`SELECT version, checksum FROM ${TABLE}`);
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const migrations = loadMigrations();
    console.log(`Found ${migrations.length} migration file(s) in ${MIGRATIONS_DIR}`);

    for (const m of migrations) {
      if (applied.has(m.version)) {
        const expected = checksum(m.content);
        if (applied.get(m.version) !== expected) {
          console.error(
            `Checksum mismatch for ${m.filename}. Do not modify applied migrations.`
          );
          process.exit(1);
        }
        console.log(`Skip (already applied): ${m.filename}`);
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(m.content);
        await client.query(
          `INSERT INTO ${TABLE} (version, checksum) VALUES ($1, $2)`,
          [m.version, checksum(m.content)]
        );
        await client.query('COMMIT');
        console.log(`Applied: ${m.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Failed: ${m.filename}`, err);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log('All migrations applied successfully.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
