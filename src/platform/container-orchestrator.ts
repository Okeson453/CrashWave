/**
 * ContainerOrchestrator — provision / pause / resume / destroy tenant engines.
 *
 * Backends:
 *   - docker (default when `docker` binary available or ORCHESTRATOR_BACKEND=docker)
 *   - process  (in-process marker only — tests / local without Docker)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { getLogger } from '../observability/logger.js';
import { getPool } from '../persistence/client.js';

import { TenantManager } from './tenant-manager.js';
import { TenantSecretVault } from './secret-vault.js';
import { Plan } from './types.js';

const execFileAsync = promisify(execFile);

export interface ContainerInfo {
  containerId: string;
  host: string;
  status: 'provisioning' | 'running' | 'paused' | 'error' | 'stopped' | 'destroyed';
}

export interface ProvisionOptions {
  FIXED_STAKE?: string;
  FIXED_TARGET?: string;
  MAX_DAILY_ENTRIES?: string;
  MODE?: string;
}

export interface ContainerOrchestrator {
  provision(userId: string, opts?: ProvisionOptions): Promise<ContainerInfo>;
  pause(userId: string): Promise<void>;
  resume(userId: string): Promise<void>;
  destroy(userId: string): Promise<void>;
  getStatus(userId: string): Promise<ContainerInfo | null>;
  globalPause(): Promise<void>;
  globalResume(): Promise<void>;
  healthSweep(): Promise<void>;
}

function envFlag(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function buildTenantEnv(
  userId: string,
  opts?: ProvisionOptions
): Promise<Record<string, string>> {
  const tenants = new TenantManager();
  const vault = new TenantSecretVault();
  const user = await tenants.getUserById(userId);
  if (!user) {throw new Error(`User ${userId} not found`);}

  let plan: Plan | null = null;
  if (user.planId) {plan = await tenants.getPlan(user.planId);}

  let customStake: number | null = null;
  try {
    const { getPool } = await import('../persistence/client.js');
    const stakeRow = await getPool().query(
      'SELECT custom_stake FROM users WHERE id = $1',
      [userId]
    );
    if (stakeRow.rows[0]?.custom_stake != null) {
      customStake = parseFloat(String(stakeRow.rows[0].custom_stake));
    }
  } catch {
    customStake = null;
  }

  let creds: { username: string; password: string; totp?: string } | null = null;
  try {
    creds = await vault.decryptForContainer(userId);
  } catch {
    creds = null;
  }

  const env: Record<string, string> = {
    TENANT_ID: userId,
    MODE: opts?.MODE ?? 'observe-only',
    FIXED_STAKE: opts?.FIXED_STAKE ?? String(customStake ?? plan?.fixedStake ?? 700),
    CUSTOM_STAKE: String(customStake ?? plan?.fixedStake ?? 700),
    FIXED_TARGET: opts?.FIXED_TARGET ?? String(plan?.fixedTarget ?? 1.3),
    MAX_DAILY_ENTRIES: opts?.MAX_DAILY_ENTRIES ?? String(plan?.maxDailyEntries ?? 100),
    TELEGRAM_CHAT_ID: user.telegramId.toString(),
    REDIS_KEY_PREFIX: `tenant:${userId}:`,
    DATABASE_URL: envFlag('DATABASE_URL'),
    REDIS_URL: envFlag('REDIS_URL'),
    TELEGRAM_BOT_TOKEN: envFlag('TENANT_TELEGRAM_BOT_TOKEN', envFlag('TELEGRAM_BOT_TOKEN')),
    NODE_ENV: envFlag('NODE_ENV', 'production'),
  };

  if (creds) {
    env.BCGAME_USERNAME = creds.username;
    env.BCGAME_PASSWORD = creds.password;
    if (creds.totp) {env.BCGAME_2FA_SECRET = creds.totp;}
  }

  return env;
}

/**
 * Docker-backed orchestrator using the Docker CLI (no extra npm deps).
 * Image: TENANT_ENGINE_IMAGE (default bc-crash-automation:latest)
 * Network: TENANT_DOCKER_NETWORK (default bridge; set to none for hard isolation)
 */
export class DockerContainerOrchestrator implements ContainerOrchestrator {
  private readonly logger = getLogger();
  private readonly tenants = new TenantManager();
  /** Serialize lifecycle ops per tenant (in-process; multi-node uses Docker name uniqueness) */
  private readonly lifecycleLocks = new Map<string, Promise<void>>();
  private readonly image: string;
  private readonly network: string;
  private readonly namePrefix: string;

  constructor() {
    this.image = envFlag('TENANT_ENGINE_IMAGE', 'bc-crash-automation:latest');
    this.network = envFlag('TENANT_DOCKER_NETWORK', 'bridge');
    this.namePrefix = envFlag('TENANT_CONTAINER_PREFIX', 'tenant-engine');
  }

  private containerName(userId: string): string {
    return `${this.namePrefix}-${userId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40)}`;
  }

  private async docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync('docker', args, {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const msg = e.stderr || e.message || String(err);
      throw new Error(`docker ${args[0]} failed: ${msg}`);
    }
  }

  private async withTenantLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.lifecycleLocks.set(userId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.lifecycleLocks.get(userId) === gate) {
        this.lifecycleLocks.delete(userId);
      }
    }
  }

  async provision(userId: string, opts?: ProvisionOptions): Promise<ContainerInfo> {
    return this.withTenantLock(userId, () => this.provisionUnlocked(userId, opts));
  }

  private async provisionUnlocked(userId: string, opts?: ProvisionOptions): Promise<ContainerInfo> {
    let instance = await this.tenants.getInstance(userId);
    if (!instance) {instance = await this.tenants.createInstance(userId);}

    await this.tenants.updateInstance(userId, { status: 'provisioning' });

    const name = this.containerName(userId);
    // Remove any previous container with same name
    try {
      await this.docker(['rm', '-f', name]);
    } catch {
      /* none */
    }

    const env = await buildTenantEnv(userId, opts);
    const envArgs = Object.entries(env)
      .filter(([, v]) => v != null && v !== '')
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    const volume = `tenant-profile-${userId}`;
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--restart',
      'unless-stopped',
      '--memory',
      envFlag('TENANT_MEMORY_LIMIT', '1g'),
      '--cpus',
      envFlag('TENANT_CPU_LIMIT', '0.5'),
      '--network',
      this.network,
      '-v',
      `${volume}:/data/browser-profile`,
      ...envArgs,
      this.image,
    ];

    try {
      const { stdout } = await this.docker(args);
      const containerId = stdout.trim().slice(0, 64);
      await this.tenants.updateInstance(userId, {
        containerId,
        containerHost: name,
        status: 'running',
        mode: opts?.MODE ?? 'observe-only',
        lastHeartbeat: new Date(),
      });
      await this.tenants.audit({
        actorType: 'system',
        action: 'instance.provisioned',
        targetUserId: userId,
        payload: { containerId, name, backend: 'docker' },
      });
      this.logger.info(
        { component: 'DockerContainerOrchestrator', userId, containerId, name },
        'Tenant container provisioned'
      );
      return { containerId, host: name, status: 'running' };
    } catch (err) {
      await this.tenants.updateInstance(userId, { status: 'error' });
      await this.tenants.audit({
        actorType: 'system',
        action: 'instance.provision_failed',
        targetUserId: userId,
        payload: { error: String(err) },
      });
      throw err;
    }
  }

  async pause(userId: string): Promise<void> {
    return this.withTenantLock(userId, () => this.pauseUnlocked(userId));
  }

  private async pauseUnlocked(userId: string): Promise<void> {
    const instance = await this.tenants.getInstance(userId);
    if (!instance?.containerId && !instance?.containerHost) {
      await this.tenants.updateInstance(userId, { status: 'paused' });
      return;
    }
    const name = instance.containerHost || this.containerName(userId);
    try {
      await this.docker(['pause', name]);
      await this.tenants.updateInstance(userId, { status: 'paused' });
      await this.tenants.audit({
        actorType: 'system',
        action: 'instance.paused',
        targetUserId: userId,
      });
    } catch (err) {
      await this.tenants.updateInstance(userId, { status: 'error' });
      this.logger.error(
        { component: 'DockerContainerOrchestrator', userId, error: String(err) },
        'docker pause failed — DB marked error'
      );
      throw err;
    }
  }

  async resume(userId: string): Promise<void> {
    return this.withTenantLock(userId, () => this.resumeUnlocked(userId));
  }

  private async resumeUnlocked(userId: string): Promise<void> {
    const instance = await this.tenants.getInstance(userId);
    const name = instance?.containerHost || this.containerName(userId);
    try {
      // unpause if paused; start if stopped
      try {
        await this.docker(['unpause', name]);
      } catch {
        await this.docker(['start', name]);
      }
    } catch (err) {
      this.logger.warn(
        { component: 'DockerContainerOrchestrator', userId, error: String(err) },
        'docker resume failed'
      );
      throw err;
    }
    await this.tenants.updateInstance(userId, {
      status: 'running',
      lastHeartbeat: new Date(),
    });
    await this.tenants.audit({
      actorType: 'system',
      action: 'instance.resumed',
      targetUserId: userId,
    });
  }

  async destroy(userId: string): Promise<void> {
    return this.withTenantLock(userId, () => this.destroyUnlocked(userId));
  }

  private async destroyUnlocked(userId: string): Promise<void> {
    const instance = await this.tenants.getInstance(userId);
    const name = instance?.containerHost || this.containerName(userId);
    try {
      await this.docker(['rm', '-f', name]);
    } catch {
      /* already gone */
    }
    await this.tenants.updateInstance(userId, {
      status: 'destroyed',
      containerId: null,
      containerHost: null,
    });
    // Purge encrypted credentials
    await getPool().query(
      `UPDATE users SET
         bc_game_username_encrypted = NULL,
         bc_game_password_encrypted = NULL,
         bc_game_2fa_secret_encrypted = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
    await this.tenants.audit({
      actorType: 'system',
      action: 'instance.destroyed',
      targetUserId: userId,
    });
  }

  async getStatus(userId: string): Promise<ContainerInfo | null> {
    const instance = await this.tenants.getInstance(userId);
    if (!instance) {return null;}
    return {
      containerId: instance.containerId ?? '',
      host: instance.containerHost ?? '',
      status: instance.status,
    };
  }

  async globalPause(): Promise<void> {
    const result = await getPool().query(
      `SELECT user_id FROM tenant_instances WHERE status = 'running'`
    );
    for (const row of result.rows) {
      await this.pause(String(row.user_id));
    }
    this.logger.warn({ component: 'DockerContainerOrchestrator' }, 'GLOBAL PAUSE');
  }

  async globalResume(): Promise<void> {
    const result = await getPool().query(
      `SELECT user_id FROM tenant_instances WHERE status = 'paused'`
    );
    for (const row of result.rows) {
      await this.resume(String(row.user_id));
    }
    this.logger.info({ component: 'DockerContainerOrchestrator' }, 'GLOBAL RESUME');
  }

  async healthSweep(): Promise<void> {
    const result = await getPool().query(
      `SELECT user_id, container_host, container_id, status FROM tenant_instances
       WHERE status = 'running'
         AND (last_heartbeat IS NULL OR last_heartbeat < NOW() - INTERVAL '5 minutes')`
    );
    for (const row of result.rows) {
      const userId = String(row.user_id);
      // Never restart intentionally paused/destroyed/error
      if (String(row.status) !== 'running') {continue;}
      const name = String(row.container_host || this.containerName(userId));
      try {
        // Inspect: if container is not running, mark error — do not blindly restart paused hosts
        const { stdout } = await this.docker([
          'inspect',
          '-f',
          '{{.State.Status}}',
          name,
        ]);
        const dockerStatus = stdout.trim();
        if (dockerStatus === 'paused' || dockerStatus === 'exited') {
          this.logger.warn(
            { component: 'DockerContainerOrchestrator', userId, dockerStatus },
            'Stale heartbeat but container not running — marking error (no auto-restart)'
          );
          await this.tenants.updateInstance(userId, { status: 'error' });
          continue;
        }
        this.logger.warn(
          { component: 'DockerContainerOrchestrator', userId },
          'Stale heartbeat on running container — restart'
        );
        await this.docker(['restart', name]);
        await this.tenants.updateInstance(userId, { lastHeartbeat: new Date() });
        await this.tenants.audit({
          actorType: 'system',
          action: 'instance.restarted',
          targetUserId: userId,
        });
      } catch (err) {
        await this.tenants.updateInstance(userId, { status: 'error' });
        this.logger.error(
          { component: 'DockerContainerOrchestrator', userId, error: String(err) },
          'Health sweep failed'
        );
      }
    }
  }
}

/**
 * Process-marker backend: persists instance state without containers.
 * Used only when Docker is unavailable and ORCHESTRATOR_BACKEND=process.
 */
export class ProcessOrchestrator implements ContainerOrchestrator {
  private readonly logger = getLogger();
  private readonly tenants = new TenantManager();
  private readonly lifecycleLocks = new Map<string, Promise<void>>();

  private async withTenantLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.lifecycleLocks.set(userId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.lifecycleLocks.get(userId) === gate) {
        this.lifecycleLocks.delete(userId);
      }
    }
  }

  async provision(userId: string, opts?: ProvisionOptions): Promise<ContainerInfo> {
    return this.withTenantLock(userId, () => this.provisionUnlocked(userId, opts));
  }

  private async provisionUnlocked(userId: string, opts?: ProvisionOptions): Promise<ContainerInfo> {
    let instance = await this.tenants.getInstance(userId);
    if (!instance) {instance = await this.tenants.createInstance(userId);}
    const containerId = `proc-${userId.slice(0, 8)}-${Date.now()}`;
    await this.tenants.updateInstance(userId, {
      containerId,
      containerHost: 'process',
      status: 'running',
      mode: opts?.MODE ?? 'observe-only',
      lastHeartbeat: new Date(),
    });
    await this.tenants.audit({
      actorType: 'system',
      action: 'instance.provisioned',
      targetUserId: userId,
      payload: { containerId, backend: 'process' },
    });
    this.logger.info(
      { component: 'ProcessOrchestrator', userId, containerId },
      'Tenant instance marked running (process backend)'
    );
    return { containerId, host: 'process', status: 'running' };
  }

  async pause(userId: string): Promise<void> {
    return this.withTenantLock(userId, () => this.pauseUnlocked(userId));
  }

  private async pauseUnlocked(userId: string): Promise<void> {
    await this.tenants.updateInstance(userId, { status: 'paused' });
    await this.tenants.audit({
      actorType: 'system',
      action: 'instance.paused',
      targetUserId: userId,
    });
  }

  async resume(userId: string): Promise<void> {
    return this.withTenantLock(userId, () => this.resumeUnlocked(userId));
  }

  private async resumeUnlocked(userId: string): Promise<void> {
    await this.tenants.updateInstance(userId, {
      status: 'running',
      lastHeartbeat: new Date(),
    });
    await this.tenants.audit({
      actorType: 'system',
      action: 'instance.resumed',
      targetUserId: userId,
    });
  }

  async destroy(userId: string): Promise<void> {
    return this.withTenantLock(userId, () => this.destroyUnlocked(userId));
  }

  private async destroyUnlocked(userId: string): Promise<void> {
    await this.tenants.updateInstance(userId, {
      status: 'destroyed',
      containerId: null,
      containerHost: null,
    });
    await getPool().query(
      `UPDATE users SET
         bc_game_username_encrypted = NULL,
         bc_game_password_encrypted = NULL,
         bc_game_2fa_secret_encrypted = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
    await this.tenants.audit({
      actorType: 'system',
      action: 'instance.destroyed',
      targetUserId: userId,
    });
  }

  async getStatus(userId: string): Promise<ContainerInfo | null> {
    const instance = await this.tenants.getInstance(userId);
    if (!instance) {return null;}
    return {
      containerId: instance.containerId ?? '',
      host: instance.containerHost ?? '',
      status: instance.status,
    };
  }

  async globalPause(): Promise<void> {
    const result = await getPool().query(
      `SELECT user_id FROM tenant_instances WHERE status = 'running'`
    );
    for (const row of result.rows) {await this.pause(String(row.user_id));}
  }

  async globalResume(): Promise<void> {
    const result = await getPool().query(
      `SELECT user_id FROM tenant_instances WHERE status = 'paused'`
    );
    for (const row of result.rows) {await this.resume(String(row.user_id));}
  }

  async healthSweep(): Promise<void> {
    const result = await getPool().query(
      `SELECT user_id FROM tenant_instances
       WHERE status = 'running'
         AND (last_heartbeat IS NULL OR last_heartbeat < NOW() - INTERVAL '5 minutes')`
    );
    for (const row of result.rows) {
      this.logger.warn(
        { component: 'ProcessOrchestrator', userId: row.user_id },
        'Stale heartbeat'
      );
      await this.tenants.updateInstance(String(row.user_id), { status: 'error' });
    }
  }
}

export async function createContainerOrchestrator(): Promise<ContainerOrchestrator> {
  const backend = (process.env.ORCHESTRATOR_BACKEND ?? 'auto').toLowerCase();
  if (backend === 'process') {return new ProcessOrchestrator();}
  if (backend === 'docker') {return new DockerContainerOrchestrator();}
  // auto
  if (await dockerAvailable()) {return new DockerContainerOrchestrator();}
  getLogger().warn(
    { component: 'ContainerOrchestrator' },
    'Docker not available — using process orchestrator backend'
  );
  return new ProcessOrchestrator();
}

/** @deprecated use createContainerOrchestrator */
export const LocalStubOrchestrator = ProcessOrchestrator;
