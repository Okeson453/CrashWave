import { BaseWorker } from '../framework/base-worker';
import type { WorkerContext } from '../framework/types';
import type { RiskEngine } from '../../betting/risk-engine';
import type { RiskEvaluationInput, RiskEvaluationResult } from '../../betting/types';
import { getEventBus } from '../../core/event-bus/bus';

export interface RiskWorkerDeps {
  riskEngine: RiskEngine;
  buildRiskInput: (payload?: Record<string, unknown>) => RiskEvaluationInput | Promise<RiskEvaluationInput>;
}

const AUTH_TTL_MS = 250;

export class RiskWorker extends BaseWorker {
  private readonly deps: RiskWorkerDeps;
  constructor(deps: RiskWorkerDeps, name = 'risk-1') {
    super({ type: 'risk', name, priority: 'critical', concurrency: 1, heartbeatIntervalMs: 5_000, maxConsecutiveErrors: 3 });
    this.deps = deps;
  }

  async evaluate(payload?: Record<string, unknown>): Promise<RiskEvaluationResult> {
    return this.deps.riskEngine.evaluate(await this.deps.buildRiskInput(payload));
  }

  protected async handle(payload: unknown, ctx: WorkerContext): Promise<void> {
    const p = (payload ?? {}) as Record<string, unknown>;
    const input = await this.deps.buildRiskInput(p);
    const predictionSignal = p.predictionId ? {
      predictionId: String(p.predictionId),
      probability: Number(p.probability),
      confidence: Number(p.confidence),
      target: Number(p.target ?? 1.3),
      expiresAt: String(p.expiresAt ?? new Date(Date.now() + AUTH_TTL_MS).toISOString()),
      dataQuality: Number(p.dataQuality ?? 1),
    } : undefined;
    const result = this.deps.riskEngine.evaluate({ ...input, ...(predictionSignal ? { predictionSignal } : {}) });
    const issuedAt = Date.now();
    const expiresAt = new Date(issuedAt + AUTH_TTL_MS).toISOString();
    const eventBus = getEventBus();

    if (!result.approved) {
      await eventBus.emitTyped('EntryRejected', {
        roundId: String(p.roundId ?? ''),
        sessionId: String(p.sessionId ?? ''),
        predictionId: p.predictionId ? String(p.predictionId) : null,
        reason: result.rejectionReason ?? 'risk_rejected',
      }, ctx.correlationId, this.name);
      return;
    }

    await eventBus.emitTyped('ExecutionAuthorized', {
      ...p,
      riskApproved: true,
      authorized: true,
      authorizedAt: new Date(issuedAt).toISOString(),
      expiresAt,
      riskAuthorizationTtlMs: AUTH_TTL_MS,
    }, ctx.correlationId, this.name);
  }
}
