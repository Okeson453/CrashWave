/**
 * TenantRuntime — per-tenant process boundary for session, orchestration, and health.
 *
 * Telegram identity resolves to a tenant; the factory hands back a runtime whose
 * SessionSupervisor owns the persistent browser and BC.Game session for that tenant.
 */

import type { SessionSupervisor, SupervisorState } from '../core/session-supervisor';
import type { HealthMonitor } from '../observability/health/monitor';
import type { HealthCheckResult } from '../types/health';
import { getLogger } from '../observability/logger';

const logger = () => getLogger().child({ component: 'TenantRuntime' });

export interface TenantAuthenticateInput {
  email: string;
  password: string;
}

export interface TenantAuthenticateResult {
  ok: boolean;
  authenticated: boolean;
  regionBlocked?: boolean;
  gameLoaded?: boolean;
  observing?: boolean;
  detail?: string;
  maskedEmail?: string;
}

export interface TenantEngineStatus {
  tenantId: string;
  session: Readonly<SupervisorState>;
  orchestrator: {
    mode: string;
    running: boolean;
    sessionId: string | null;
    roundsObserved: number;
    errors: number;
    startedAt: string | null;
    authenticated: boolean;
    phase: string;
  };
  health: HealthCheckResult | null;
}

/**
 * Live runtime for one tenant. In engine mode this wraps the process-local
 * SessionSupervisor; in multi-tenant deployments the factory may create
 * one runtime per tenant (or proxy to a remote container).
 */
export class TenantRuntime {
  private started = false;

  constructor(
    public readonly tenantId: string,
    public readonly sessionSupervisor: SessionSupervisor,
    private readonly healthMonitor: HealthMonitor | null = null
  ) {}

  /**
   * One-shot BC.Game login through the tenant's browser session.
   * Password must never be persisted by callers after this returns.
   */
  async authenticate(input: TenantAuthenticateInput): Promise<TenantAuthenticateResult> {
    logger().info(
      { tenantId: this.tenantId },
      'Tenant authenticate requested'
    );
    return this.sessionSupervisor.loginWithCredentials(input.email, input.password);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.sessionSupervisor.start();
    this.started = true;
    logger().info({ tenantId: this.tenantId }, 'TenantRuntime started');
  }

  async stop(): Promise<void> {
    if (!this.started) {
      try {
        await this.sessionSupervisor.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    await this.sessionSupervisor.stop();
    this.started = false;
    logger().info({ tenantId: this.tenantId }, 'TenantRuntime stopped');
  }

  getSessionStatus(): Readonly<SupervisorState> {
    return this.sessionSupervisor.getState();
  }

  getOrchestratorStatus(): ReturnType<SessionSupervisor['getOrchestratorState']> {
    return this.sessionSupervisor.getOrchestratorState();
  }

  getHealthStatus(): HealthCheckResult | null {
    return this.healthMonitor?.getLastResult() ?? null;
  }

  getStatus(): TenantEngineStatus {
    const orch = this.getOrchestratorStatus();
    return {
      tenantId: this.tenantId,
      session: this.getSessionStatus(),
      orchestrator: {
        mode: String(orch.mode ?? 'unknown'),
        running: Boolean(orch.running),
        sessionId: (orch.sessionId as string | null) ?? null,
        roundsObserved: Number(orch.roundsObserved ?? 0),
        errors: Number(orch.errors ?? 0),
        startedAt: (orch.startedAt as string | null) ?? null,
        authenticated: Boolean(orch.authenticated),
        phase: String(orch.phase ?? this.getSessionStatus().phase),
      },
      health: this.getHealthStatus(),
    };
  }

  isStarted(): boolean {
    return this.started;
  }
}
