/**
 * Role-aware Postgres pool sizing.
 *
 * Personal-use adaptation: the advanced Crash build has a multi-role
 * `resolveProcessRole()` (control-plane, automation-worker, mini-app-game,
 * 'all'). Personal use is a single-process monolith, so we treat the
 * role as a constant. If the operator sets DATABASE_POOL_SIZE / DB_POOL_SIZE,
 * that wins; otherwise the personal-use default is 10 (single process,
 * single user, no need for the 30-connection control-plane default).
 */

import type { AppConfig } from '../config/schema.js';

export function resolveProcessRole(_config?: AppConfig): 'all' {
  // Personal use: single process, single role.
  return 'all';
}

export function resolveDatabasePoolSize(config?: AppConfig): number {
  const env = Number(process.env.DATABASE_POOL_SIZE ?? process.env.DB_POOL_SIZE);
  if (Number.isFinite(env) && env > 0) return Math.min(100, Math.floor(env));

  const fromConfig = config?.persistence?.databasePoolSize;
  if (typeof fromConfig === 'number' && fromConfig > 0) return fromConfig;

  // Personal-use default: 10 connections (single process, single user).
  return 10;
}
