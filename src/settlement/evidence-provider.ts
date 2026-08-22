/**
 * Settlement Evidence Provider
 * Authoritative external settlement evidence — required for UNKNOWN resolution
 * and final ledger commit. DOM/WS observations alone are insufficient.
 */
import { z } from 'zod';

export const SettlementEvidenceSchema = z.object({
  clientOrderId: z.string(),
  externalBetId: z.string().optional(),
  externalTxRef: z.string().optional(),
  status: z.enum(['WIN', 'LOSS', 'VOID', 'PENDING', 'UNKNOWN']),
  multiplier: z.number().optional(),
  grossPayout: z.number().nonnegative().optional(),
  confirmedAt: z.string().datetime().optional(),
  raw: z.unknown().optional(),
  source: z.enum(['operator_api', 'operator_history', 'webhook', 'manual']),
  hmacValid: z.boolean().optional(),
});

export type SettlementEvidence = z.infer<typeof SettlementEvidenceSchema>;

export interface SettlementEvidenceProvider {
  /** Fetch authoritative status for a client_order_id / external bet id */
  getEvidence(query: {
    clientOrderId: string;
    externalBetId?: string;
    roundId?: string;
  }): Promise<SettlementEvidence | null>;

  /** Optional: verify HMAC signature on a callback payload */
  verifyCallback?(headers: Record<string, string>, body: string): boolean;
}

/**
 * Null provider — always returns null (forces UNKNOWN / no auto-settle).
 * Replace with platform-specific implementation for live.
 */
export class NullEvidenceProvider implements SettlementEvidenceProvider {
  async getEvidence(): Promise<null> {
    return null;
  }
}

/**
 * REST history evidence provider (generic).
 * Configure base URL + headers; maps common BC.Game-like history shapes.
 */
export class RestHistoryEvidenceProvider implements SettlementEvidenceProvider {
  constructor(
    private opts: {
      baseUrl: string;
      headers?: Record<string, string>;
      fetchImpl?: typeof fetch;
    }
  ) {}

  async getEvidence(query: {
    clientOrderId: string;
    externalBetId?: string;
    roundId?: string;
  }): Promise<SettlementEvidence | null> {
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const url = new URL('/api/bet-history', this.opts.baseUrl);
    url.searchParams.set('clientOrderId', query.clientOrderId);
    if (query.externalBetId) url.searchParams.set('betId', query.externalBetId);
    if (query.roundId) url.searchParams.set('roundId', query.roundId);

    const res = await fetchFn(url.toString(), {
      headers: {
        Accept: 'application/json',
        ...this.opts.headers,
      },
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const item = Array.isArray(body) ? body[0] : body?.data ?? body;
    if (!item) return null;

    const statusRaw = String(item.status ?? item.result ?? '').toUpperCase();
    let status: SettlementEvidence['status'] = 'UNKNOWN';
    if (statusRaw.includes('WIN') || statusRaw.includes('CASH')) status = 'WIN';
    else if (statusRaw.includes('LOSS') || statusRaw.includes('CRASH') || statusRaw.includes('BUST'))
      status = 'LOSS';
    else if (statusRaw.includes('VOID') || statusRaw.includes('CANCEL')) status = 'VOID';
    else if (statusRaw.includes('PEND') || statusRaw.includes('ACTIVE')) status = 'PENDING';

    return SettlementEvidenceSchema.parse({
      clientOrderId: query.clientOrderId,
      externalBetId: item.betId ?? item.id ?? query.externalBetId,
      externalTxRef: item.txId ?? item.transactionId,
      status,
      multiplier: item.multiplier ?? item.cashout ?? item.exitMultiplier,
      grossPayout: item.payout ?? item.grossPayout ?? item.profit,
      confirmedAt: item.settledAt ?? item.updatedAt,
      raw: item,
      source: 'operator_history',
    });
  }
}
