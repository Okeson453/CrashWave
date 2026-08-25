/**
 * TenantRuntimeFactory — get-or-create TenantRuntime by tenant id.
 *
 * Composition registers the process-primary runtime (engine mode).
 * Telegram resolves identity → tenant → factory.getOrCreate(tenantId).
 *
 * Engine (single-process) default: share the primary SessionSupervisor across
 * resolved tenants so /login and /status always hit a live supervisor.
 * Set TENANT_RUNTIME_ISOLATE=1 to require an explicit runtime per tenant id.
 */

import { TenantRuntime } from './tenant-runtime';
import type { SessionSupervisor } from '../core/session-supervisor';
import type { HealthMonitor } from '../observability/health/monitor';
import { getLogger } from '../observability/logger';

const logger = () => getLogger().child({ component: 'TenantRuntimeFactory' });

export type TenantRuntimeCreator = (tenantId: string) => Promise<TenantRuntime> | TenantRuntime;

export interface TenantRuntimeFactoryOptions {
  sharePrimary?: boolean;
  create?: TenantRuntimeCreator;
}

export class TenantRuntimeFactory {
  private readonly runtimes = new Map<string, TenantRuntime>();
  private primary: TenantRuntime | null = null;
  private readonly sharePrimary: boolean;
  private readonly createFn?: TenantRuntimeCreator;

  constructor(options: TenantRuntimeFactoryOptions = {}) {
    const isolate = (process.env.TENANT_RUNTIME_ISOLATE ?? '').trim() === '1';
    this.sharePrimary = options.sharePrimary ?? !isolate;
    this.createFn = options.create;
  }

  registerPrimary(runtime: TenantRuntime): void {
    this.primary = runtime;
    this.runtimes.set(runtime.tenantId, runtime);
    logger().info(
      { tenantId: runtime.tenantId, sharePrimary: this.sharePrimary },
      'Primary TenantRuntime registered'
    );
  }

  register(runtime: TenantRuntime): void {
    this.runtimes.set(runtime.tenantId, runtime);
    if (!this.primary) this.primary = runtime;
  }

  async getOrCreate(tenantId: string): Promise<TenantRuntime> {
    if (!tenantId) {
      throw new Error('tenantId is required for TenantRuntimeFactory.getOrCreate');
    }

    const existing = this.runtimes.get(tenantId);
    if (existing) return existing;

    if (this.createFn) {
      const created = await this.createFn(tenantId);
      this.runtimes.set(tenantId, created);
      logger().info({ tenantId }, 'TenantRuntime created via factory createFn');
      return created;
    }

    if (this.sharePrimary && this.primary) {
      this.runtimes.set(tenantId, this.primary);
      logger().debug(
        { tenantId, primaryTenantId: this.primary.tenantId },
        'TenantRuntime shared from primary'
      );
      return this.primary;
    }

    throw new Error(
      `No TenantRuntime for tenant ${tenantId}: supervisor not registered (composition wiring missing)`
    );
  }

  get(tenantId: string): TenantRuntime | null {
    return this.runtimes.get(tenantId) ?? null;
  }

  getPrimary(): TenantRuntime | null {
    return this.primary;
  }

  has(tenantId: string): boolean {
    return this.runtimes.has(tenantId);
  }

  async stopAll(): Promise<void> {
    const seen = new Set<TenantRuntime>();
    for (const rt of this.runtimes.values()) {
      if (seen.has(rt)) continue;
      seen.add(rt);
      try {
        await rt.stop();
      } catch (err) {
        logger().warn({ tenantId: rt.tenantId, error: String(err) }, 'TenantRuntime stop failed');
      }
    }
    this.runtimes.clear();
    this.primary = null;
  }

  static wrapSupervisor(
    tenantId: string,
    supervisor: SessionSupervisor,
    healthMonitor?: HealthMonitor | null
  ): TenantRuntime {
    return new TenantRuntime(tenantId, supervisor, healthMonitor ?? null);
  }
}
