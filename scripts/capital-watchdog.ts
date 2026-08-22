#!/usr/bin/env tsx
/**
 * Out-of-band capital watchdog process.
 * Run as a separate OS process from the main trading engine.
 *
 * Usage:
 *   TARGET_PID=<engine_pid> DATABASE_URL=... tsx scripts/capital-watchdog.ts
 *
 * Env:
 *   TARGET_PID          - PID of the primary engine (required)
 *   PANIC_BALANCE_FLOOR - default 500
 *   POLL_INTERVAL_MS    - default 10000
 *   DATABASE_URL        - used to read latest balance from ledger/bets
 */
import dotenv from 'dotenv';
dotenv.config();

import { createPool, getPool, closePool } from '../src/persistence/client';
import { CapitalWatchdog } from '../src/capital/watchdog';
import { createLogger, getLogger } from '../src/observability/logger';

async function main(): Promise<void> {
  createLogger('capital-watchdog', 'info');
  const logger = getLogger();

  const targetPid = parseInt(process.env.TARGET_PID || '', 10);
  if (!targetPid || Number.isNaN(targetPid)) {
    logger.fatal('TARGET_PID env required');
    process.exit(2);
  }

  const floor = parseFloat(process.env.PANIC_BALANCE_FLOOR || '500');
  const pollMs = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    logger.fatal('DATABASE_URL required');
    process.exit(2);
  }

  createPool({ connectionString: dbUrl, poolSize: 2 });

  const readBalance = async (): Promise<number> => {
    const pool = getPool();
    // Prefer latest balance_after from bets; fallback to financial ledger if present
    const r = await pool.query<{ bal: string }>(
      `SELECT COALESCE(
         (SELECT balance_after FROM bets WHERE balance_after IS NOT NULL ORDER BY created_at DESC LIMIT 1),
         (SELECT balance FROM balance_snapshots ORDER BY captured_at DESC LIMIT 1),
         $1
       ) AS bal`,
      [floor + 1]
    );
    return parseFloat(r.rows[0]?.bal ?? String(floor + 1));
  };

  const wd = new CapitalWatchdog(
    {
      panicBalanceFloor: floor,
      pollIntervalMs: pollMs,
      targetPid,
      enabled: true,
    },
    readBalance
  );
  wd.start();
  logger.info({ targetPid, floor, pollMs }, 'Capital watchdog running');

  process.on('SIGINT', async () => {
    wd.stop();
    await closePool();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    wd.stop();
    await closePool();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
