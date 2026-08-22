/**
 * Wire SettlementEvidenceProvider → ConfirmationObserver authoritative readers.
 * DOM/WS remain observation-only; these readers are the settlement source of truth.
 */
import type { SettlementEvidenceProvider } from './evidence-provider';
import type { AuthoritativeBetConfirmation } from '../betting/confirmation';
import { getLogger } from '../observability/logger';

const logger = () => getLogger().child({ component: 'AuthoritativeReaders' });

/**
 * Map evidence status to placement confirmation.
 * PENDING / WIN / LOSS with external id ⇒ placement accepted.
 */
export function createAuthoritativeBetReader(
  provider: SettlementEvidenceProvider,
  resolveClientOrderId?: (roundId: string, sessionId: string) => string | undefined
): (roundId: string, sessionId: string) => Promise<AuthoritativeBetConfirmation | null> {
  return async (roundId, sessionId) => {
    const clientOrderId = resolveClientOrderId?.(roundId, sessionId);
    if (!clientOrderId) {
      logger().debug({ roundId }, 'No client_order_id for bet reader');
      return null;
    }
    try {
      const ev = await provider.getEvidence({ clientOrderId, roundId });
      if (!ev) return null;
      if (ev.status === 'UNKNOWN') return null;
      // Any known remote status means the bet was accepted server-side
      if (['WIN', 'LOSS', 'VOID', 'PENDING'].includes(ev.status)) {
        return {
          confirmed: true,
          multiplier: ev.multiplier ?? null,
          externalReference: ev.externalBetId ?? ev.externalTxRef ?? null,
        };
      }
      return null;
    } catch (err) {
      logger().warn({ err: String(err), roundId }, 'Authoritative bet reader failed');
      return null;
    }
  };
}

export function createAuthoritativeCashOutReader(
  provider: SettlementEvidenceProvider,
  resolveClientOrderId?: (betId: string, roundId: string) => string | undefined
): (betId: string, roundId: string) => Promise<AuthoritativeBetConfirmation | null> {
  return async (betId, roundId) => {
    const clientOrderId = resolveClientOrderId?.(betId, roundId);
    if (!clientOrderId) {
      logger().debug({ betId, roundId }, 'No client_order_id for cash-out reader');
      return null;
    }
    try {
      const ev = await provider.getEvidence({ clientOrderId, roundId });
      if (!ev) return null;
      if (ev.status === 'WIN' && ev.multiplier != null) {
        return {
          confirmed: true,
          multiplier: ev.multiplier,
          externalReference: ev.externalTxRef ?? ev.externalBetId ?? null,
        };
      }
      if (ev.status === 'LOSS') {
        // Explicit loss is authoritative — not a cash-out success
        return { confirmed: false, multiplier: ev.multiplier ?? null, externalReference: ev.externalBetId ?? null };
      }
      return null;
    } catch (err) {
      logger().warn({ err: String(err), betId }, 'Authoritative cash-out reader failed');
      return null;
    }
  };
}
