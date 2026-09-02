/**
 * Deterministic State Reconciliation (RECONCILING)
 *
 * On disconnect → reconnect:
 *   FSM → RECONCILING (blocks outbound bets)
 *   REST query open orders by client_order_id
 *   Resolve: Accepted&Resolved | Accepted&Running | Unreceived/Dropped
 */
import { getLogger } from '../observability/logger';
const logger = () => getLogger().child({ component: 'ReconciliationService' });

export type ReconciliationResolution = 'CASHED_OUT' | 'LOST' | 'UNKNOWN' | 'STILL_ACTIVE' | 'NOT_FOUND';

export interface OpenOrderQuery {
  clientOrderId: string;
  betId?: string;
}

export interface OrderStatus {
  clientOrderId: string;
  status: 'accepted' | 'running' | 'cashed_out' | 'lost' | 'cancelled' | 'not_found';
  multiplier?: number;
  pnl?: number;
  externalBetId?: string;
}

export type OrderStatusReader = (q: OpenOrderQuery) => Promise<OrderStatus>;

export interface ReconciliationResult {
  resolution: ReconciliationResolution;
  orderStatus?: OrderStatus;
  localPnLUpdated: boolean;
  balanceSynced: boolean;
}

/**
 * Pre-flight: generate unique client_order_id and lock it in memory
 * before dispatching any network frame.
 */
export class ClientOrderIdRegistry {
  private pending = new Map<string, { createdAt: number; stake: number; target: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 120_000) { this.ttlMs = ttlMs; }

  generate(stake: number, target: number): string {
    const id = `coid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.pending.set(id, { createdAt: Date.now(), stake, target });
    this.gc();
    return id;
  }

  has(id: string): boolean { return this.pending.has(id); }
  get(id: string) { return this.pending.get(id); }
  release(id: string): void { this.pending.delete(id); }
  listPending(): string[] { return [...this.pending.keys()]; }

  private gc(): void {
    const now = Date.now();
    for (const [id, v] of this.pending) {
      if (now - v.createdAt > this.ttlMs) this.pending.delete(id);
    }
  }
}

export class ReconciliationService {
  constructor(
    private orderReader: OrderStatusReader,
    private registry: ClientOrderIdRegistry,
  ) {}

  /**
   * Run full reconciliation sequence. Must be called while FSM is in RECONCILING.
   * Blocks outbound bet triggers until complete.
   */
  async reconcile(activeClientOrderId?: string): Promise<ReconciliationResult> {
    logger().info({ activeClientOrderId, pending: this.registry.listPending() }, 'Starting reconciliation');

    const ids = activeClientOrderId
      ? [activeClientOrderId]
      : this.registry.listPending();

    if (ids.length === 0) {
      logger().info('No pending orders — reconciliation complete (idle)');
      return { resolution: 'NOT_FOUND', localPnLUpdated: false, balanceSynced: false };
    }

    for (const coid of ids) {
      try {
        const status = await this.orderReader({ clientOrderId: coid });
        logger().info({ coid, status: status.status }, 'Order status from REST');

        switch (status.status) {
          case 'cashed_out':
            this.registry.release(coid);
            return {
              resolution: 'CASHED_OUT',
              orderStatus: status,
              localPnLUpdated: true,
              balanceSynced: true,
            };
          case 'lost':
          case 'cancelled':
            this.registry.release(coid);
            return {
              resolution: 'LOST',
              orderStatus: status,
              localPnLUpdated: true,
              balanceSynced: true,
            };
          case 'running':
          case 'accepted':
            // Still active — re-subscribe WS, optionally issue REST cashout as backup
            return {
              resolution: 'STILL_ACTIVE',
              orderStatus: status,
              localPnLUpdated: false,
              balanceSynced: false,
            };
          case 'not_found':
            this.registry.release(coid);
            // Unreceived / dropped — clear lock, return to IDLE path
            return {
              resolution: 'NOT_FOUND',
              orderStatus: status,
              localPnLUpdated: false,
              balanceSynced: false,
            };
        }
      } catch (err) {
        logger().error({ err, coid }, 'REST order query failed — leaving UNKNOWN');
        return { resolution: 'UNKNOWN', localPnLUpdated: false, balanceSynced: false };
      }
    }

    return { resolution: 'UNKNOWN', localPnLUpdated: false, balanceSynced: false };
  }
}
