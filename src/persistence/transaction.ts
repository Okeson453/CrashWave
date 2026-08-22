import { PoolClient, QueryResultRow } from 'pg';
import { getPool } from './client';
import { getLogger } from '../observability/logger';
import { getTenantId } from '../platform/tenant-context';

export interface TransactionContext {
  client: PoolClient;
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<import('pg').QueryResult<T>>;
}

export async function withTransaction<T>(
  fn: (ctx: TransactionContext) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const tenantId = getTenantId();
    if (tenantId) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await client.query(`SELECT set_config('app.platform_role', '', true)`);
    }
    getLogger().debug({ component: 'Transaction' }, 'Transaction started');

    const ctx: TransactionContext = {
      client,
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => {
        return client.query<T>(sql, params);
      },
    };

    const result = await fn(ctx);

    await client.query('COMMIT');
    getLogger().debug({ component: 'Transaction' }, 'Transaction committed');

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    getLogger().error(
      { component: 'Transaction' },
      `Transaction rolled back: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  } finally {
    client.release();
  }
}

export class UnitOfWork {
  private client: PoolClient | null = null;
  private committed = false;
  private rolledBack = false;

  async begin(): Promise<void> {
    if (this.client) {
      throw new Error('Unit of work already started');
    }
    this.client = await getPool().connect();
    await this.client.query('BEGIN');
    getLogger().debug({ component: 'UnitOfWork' }, 'Unit of work started');
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<import('pg').QueryResult<T>> {
    if (!this.client) {
      throw new Error('Unit of work not started. Call begin() first.');
    }
    return this.client.query<T>(sql, params);
  }

  async commit(): Promise<void> {
    if (!this.client) {
      throw new Error('Unit of work not started');
    }
    if (this.committed || this.rolledBack) {
      throw new Error('Unit of work already finalized');
    }
    await this.client.query('COMMIT');
    this.committed = true;
    getLogger().debug({ component: 'UnitOfWork' }, 'Unit of work committed');
  }

  async rollback(): Promise<void> {
    if (!this.client) {
      throw new Error('Unit of work not started');
    }
    if (this.committed || this.rolledBack) {
      throw new Error('Unit of work already finalized');
    }
    await this.client.query('ROLLBACK');
    this.rolledBack = true;
    getLogger().debug({ component: 'UnitOfWork' }, 'Unit of work rolled back');
  }

  async end(): Promise<void> {
    if (this.client) {
      this.client.release();
      this.client = null;
      getLogger().debug({ component: 'UnitOfWork' }, 'Unit of work ended');
    }
  }

  isActive(): boolean {
    return this.client !== null && !this.committed && !this.rolledBack;
  }
}
