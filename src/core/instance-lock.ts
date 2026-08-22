/**
 * Single-active-instance enforcement (Phase 5).
 * Long-lived Redis lock with heartbeat; only one betting instance allowed.
 */

import Redis from 'ioredis';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { getLogger } from '../observability/logger';

export interface InstanceLockOptions {
  redis: Redis;
  key?: string;
  ttlMs?: number;
  heartbeatIntervalMs?: number;
  instanceId?: string;
}

export class InstanceLock {
  private readonly redis: Redis;
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly token: string;
  private readonly instanceId: string;
  private readonly logger = getLogger();
  private timer: ReturnType<typeof setInterval> | null = null;
  private held = false;

  constructor(options: InstanceLockOptions) {
    this.redis = options.redis;
    this.key = options.key ?? 'crash:active-instance';
    this.ttlMs = options.ttlMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.token = randomBytes(16).toString('hex');
    this.instanceId =
      options.instanceId ?? `${hostname()}:${process.pid}:${Date.now()}`;
  }

  getToken(): string {
    return this.token;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  isHeld(): boolean {
    return this.held;
  }

  /**
   * Try to become the active instance. Returns false if another holder exists.
   */
  async tryAcquire(): Promise<boolean> {
    const value = JSON.stringify({
      instanceId: this.instanceId,
      token: this.token,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    const result = await this.redis.set(this.key, value, 'PX', this.ttlMs, 'NX');
    if (result === 'OK') {
      this.held = true;
      this.startHeartbeat();
      this.logger.info(
        { component: 'InstanceLock', instanceId: this.instanceId },
        'Acquired active-instance lock'
      );
      return true;
    }
    const current = await this.redis.get(this.key);
    this.logger.warn(
      { component: 'InstanceLock', current },
      'Active-instance lock held by another process'
    );
    return false;
  }

  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.heartbeatIntervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  private async refresh(): Promise<void> {
    if (!this.held) return;
    try {
      // Only refresh if we still own the token
      const lua = `
        local cur = redis.call('GET', KEYS[1])
        if not cur then return 0 end
        if string.find(cur, ARGV[1], 1, true) then
          redis.call('PEXPIRE', KEYS[1], ARGV[2])
          return 1
        end
        return 0
      `;
      const ok = await this.redis.eval(lua, 1, this.key, this.token, String(this.ttlMs));
      if (ok !== 1) {
        this.held = false;
        this.logger.error(
          { component: 'InstanceLock' },
          'Lost active-instance lock (token mismatch or expired)'
        );
      }
    } catch (err) {
      this.logger.warn({ component: 'InstanceLock', error: String(err) }, 'Heartbeat failed');
    }
  }

  async release(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.held) return;
    try {
      const lua = `
        local cur = redis.call('GET', KEYS[1])
        if not cur then return 0 end
        if string.find(cur, ARGV[1], 1, true) then
          redis.call('DEL', KEYS[1])
          return 1
        end
        return 0
      `;
      await this.redis.eval(lua, 1, this.key, this.token);
    } catch (err) {
      this.logger.warn({ component: 'InstanceLock', error: String(err) }, 'Release failed');
    }
    this.held = false;
    this.logger.info({ component: 'InstanceLock' }, 'Released active-instance lock');
  }
}
