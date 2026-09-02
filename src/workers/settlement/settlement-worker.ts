import { BaseWorker } from '../framework/base-worker';
import type { WorkerContext } from '../framework/types';
import { getEventBus } from '../../core/event-bus/bus';
import type { AuthoritativeSettlementEngine } from '../../settlement/authoritative-settlement-engine';
import type { SettlementPayload } from '../../settlement/types';

export interface SettlementWorkerDeps { settlementEngine?: AuthoritativeSettlementEngine | null; settle?: (payload: Record<string, unknown>) => Promise<void>; }
export class SettlementWorker extends BaseWorker {
  private deps: SettlementWorkerDeps;
  constructor(deps: SettlementWorkerDeps = {}, name = 'settlement-1') { super({ type: 'settlement', name, priority: 'high', concurrency: 1, heartbeatIntervalMs: 10_000 }); this.deps = deps; }
  bind(deps: SettlementWorkerDeps): void { this.deps = { ...this.deps, ...deps }; }
  protected async handle(payload: unknown, ctx: WorkerContext): Promise<void> {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (this.deps.settle) { await this.deps.settle(p); }
    else if (this.deps.settlementEngine && typeof p.clientOrderId === 'string') {
      const status = p.status === 'LOSS' || p.status === 'VOID' || p.status === 'WIN' ? p.status : 'WIN';
      await this.deps.settlementEngine.settleOrder({
        clientOrderId: p.clientOrderId,
        gameId: typeof p.gameId === 'string' ? p.gameId : undefined,
        status,
        grossPayout: Number(p.grossPayout ?? 0),
        multiplier: Number(p.multiplier ?? 1),
        settledAt: Date.now(),
        externalReference: typeof p.externalReference === 'string' ? p.externalReference : undefined,
      } satisfies SettlementPayload);
    } else {
      throw new Error('settlement_authority_not_bound_or_client_order_missing');
    }
    await getEventBus().emitTyped('BetSettled', { ...p, settledAt: new Date().toISOString(), worker: this.name }, ctx.correlationId, this.name);
  }
}
