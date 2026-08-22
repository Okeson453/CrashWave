import { z } from 'zod';

export const SettlementPayloadSchema = z.object({
  clientOrderId: z.string().min(1),
  gameId: z.string().optional(),
  status: z.enum(['WIN', 'LOSS', 'VOID']),
  grossPayout: z.number().nonnegative(),
  multiplier: z.number().gte(1.0),
  settledAt: z.number(), // epoch ms
  externalReference: z.string().optional(),
  evidence: z.record(z.unknown()).optional(),
});

export type SettlementPayload = z.infer<typeof SettlementPayloadSchema>;

export type SettlementOrderStatus =
  | 'ORDER_INTENT'
  | 'DISPATCHED'
  | 'PENDING_SETTLEMENT'
  | 'RECONCILING'
  | 'SETTLED_WIN'
  | 'SETTLED_LOSS'
  | 'VOID'
  | 'FAILED';

export interface CreateOrderIntent {
  clientOrderId: string;
  tenantId?: string | null;
  betId?: string | null;
  gameId?: string;
  roundId?: string;
  wagerAmount: number;
  targetMultiplier: number;
}

export const LEDGER_ACCOUNTS = {
  HOT_WALLET: 'ASSET:CASINO_HOT_WALLET',
  UNSETTLED: 'LIABILITY:UNSETTLED_EXPOSURE',
  REALIZED_PNL: 'EQUITY:REALIZED_PNL',
  HOUSE_EDGE: 'EXPENSE:CASINO_HOUSE_EDGE',
} as const;
