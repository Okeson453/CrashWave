/**
 * TenantResolver — Telegram identity → tenant.
 * New Telegram accounts get an isolated tenant on first contact (/start).
 */

import { TenantManager } from './tenant-manager';
import type { Tenant } from './types';
import { getLogger } from '../observability/logger';

const logger = () => getLogger().child({ component: 'TenantResolver' });

export interface ResolvedTenantContext {
  tenantId: string;
  telegramUserId: number;
  chatId: number;
  tenant: Tenant;
  created: boolean;
}

export class TenantResolver {
  constructor(private readonly tenants: TenantManager = new TenantManager()) {}

  async resolveOrCreateByTelegramId(
    telegramUserId: number | bigint,
    opts?: { username?: string; chatId?: number }
  ): Promise<ResolvedTenantContext> {
    const tgId = typeof telegramUserId === 'bigint' ? telegramUserId : BigInt(telegramUserId);
    const chatId = opts?.chatId ?? Number(tgId);

    let tenant = await this.tenants.getUserByTelegramId(tgId);
    let created = false;

    if (!tenant) {
      tenant = await this.tenants.createUser({
        telegramId: tgId,
        telegramUsername: opts?.username,
      });
      created = true;
      logger().info(
        { tenantId: tenant.id, telegramUserId: String(tgId) },
        'Created tenant from Telegram identity'
      );
      await this.tenants.audit({
        actorType: 'user',
        actorId: tenant.id,
        action: 'tenant.created',
        targetUserId: tenant.id,
        payload: { telegramId: String(tgId), username: opts?.username ?? null },
      });
    } else if (opts?.username && tenant.telegramUsername !== opts.username) {
      try {
        await this.tenants.audit({
          actorType: 'user',
          actorId: tenant.id,
          action: 'tenant.seen',
          targetUserId: tenant.id,
          payload: { username: opts.username },
        });
      } catch {
        /* ignore */
      }
    }

    return {
      tenantId: tenant.id,
      telegramUserId: Number(tgId),
      chatId,
      tenant,
      created,
    };
  }

  async resolveOnly(telegramUserId: number | bigint): Promise<Tenant | null> {
    const tgId = typeof telegramUserId === 'bigint' ? telegramUserId : BigInt(telegramUserId);
    return this.tenants.getUserByTelegramId(tgId);
  }

  async resolveOrCreate(ctx: {
    from?: { id: number; username?: string };
    chat?: { id: number };
    tenantId?: string;
  }): Promise<ResolvedTenantContext> {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId == null || !Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      throw new Error('Cannot resolve tenant: missing Telegram user id');
    }
    const resolved = await this.resolveOrCreateByTelegramId(telegramUserId, {
      username: ctx.from?.username,
      chatId: ctx.chat?.id,
    });
    ctx.tenantId = resolved.tenantId;
    return resolved;
  }

  async resolve(ctx: {
    from?: { id: number };
    tenantId?: string;
  }): Promise<Tenant | null> {
    if (ctx.tenantId) {
      const byId = await this.tenants.getUserById(ctx.tenantId);
      if (byId) return byId;
    }
    const telegramUserId = ctx.from?.id;
    if (telegramUserId == null) return null;
    return this.resolveOnly(telegramUserId);
  }
}
