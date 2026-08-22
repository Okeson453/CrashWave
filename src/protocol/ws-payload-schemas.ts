/**
 * Zod-Backed Payload Ingestion
 * Structural shape matching; N consecutive failures → circuit breaker.
 */
import { z } from 'zod';
import { getLogger } from '../observability/logger';

const logger = () => getLogger().child({ component: 'WsPayloadSchemas' });
const FlexNum = z.union([z.number(), z.string().transform((s) => parseFloat(s))]);

export const TickFrameSchema = z.object({
  multiplier: FlexNum.optional(), m: FlexNum.optional(), point: FlexNum.optional(),
  crashPoint: FlexNum.optional(), crash_point: FlexNum.optional(),
  roundId: z.union([z.string(), z.number()]).optional(),
  round_id: z.union([z.string(), z.number()]).optional(),
  gameId: z.union([z.string(), z.number()]).optional(), id: z.union([z.string(), z.number()]).optional(),
  status: z.string().optional(), state: z.string().optional(), phase: z.string().optional(),
  type: z.string().optional(), event: z.string().optional(),
}).passthrough().transform((raw) => {
  const multiplier = raw.multiplier ?? raw.m ?? raw.point ?? raw.crashPoint ?? raw.crash_point ?? null;
  const roundId = raw.roundId ?? raw.round_id ?? raw.gameId ?? raw.id ?? null;
  const phase = raw.status ?? raw.state ?? raw.phase ?? raw.type ?? raw.event ?? null;
  return {
    multiplier: multiplier != null && !Number.isNaN(Number(multiplier)) ? Number(multiplier) : null,
    roundId: roundId != null ? String(roundId) : null,
    phase: phase != null ? String(phase) : null,
    raw,
  };
});
export type ParsedTick = z.infer<typeof TickFrameSchema>;

export const BetAckSchema = z.object({
  betId: z.union([z.string(), z.number()]).optional(), bet_id: z.union([z.string(), z.number()]).optional(),
  orderId: z.union([z.string(), z.number()]).optional(), order_id: z.union([z.string(), z.number()]).optional(),
  clientOrderId: z.union([z.string(), z.number()]).optional(), client_order_id: z.union([z.string(), z.number()]).optional(),
  status: z.string().optional(), accepted: z.boolean().optional(),
  amount: FlexNum.optional(), stake: FlexNum.optional(),
}).passthrough().transform((raw) => ({
  betId: String(raw.betId ?? raw.bet_id ?? raw.orderId ?? raw.order_id ?? ''),
  clientOrderId: String(raw.clientOrderId ?? raw.client_order_id ?? ''),
  status: raw.status ?? (raw.accepted === true ? 'accepted' : undefined),
  amount: raw.amount ?? raw.stake ?? null, raw,
}));

export const CashOutAckSchema = z.object({
  betId: z.union([z.string(), z.number()]).optional(), bet_id: z.union([z.string(), z.number()]).optional(),
  multiplier: FlexNum.optional(), cashout: FlexNum.optional(), cash_out: FlexNum.optional(),
  profit: FlexNum.optional(), status: z.string().optional(),
}).passthrough().transform((raw) => ({
  betId: String(raw.betId ?? raw.bet_id ?? ''),
  multiplier: Number(raw.multiplier ?? raw.cashout ?? raw.cash_out ?? 0) || null,
  profit: raw.profit != null ? Number(raw.profit) : null, status: raw.status, raw,
}));

export const CrashResultSchema = z.object({
  crashPoint: FlexNum.optional(), crash_point: FlexNum.optional(),
  multiplier: FlexNum.optional(), point: FlexNum.optional(),
  roundId: z.union([z.string(), z.number()]).optional(), round_id: z.union([z.string(), z.number()]).optional(),
  hash: z.string().optional(), seed: z.string().optional(),
}).passthrough().transform((raw) => ({
  crashPoint: Number(raw.crashPoint ?? raw.crash_point ?? raw.multiplier ?? raw.point ?? 0) || null,
  roundId: String(raw.roundId ?? raw.round_id ?? ''), hash: raw.hash, seed: raw.seed, raw,
}));

export type PayloadKind = 'tick' | 'bet_ack' | 'cashout_ack' | 'crash' | 'unknown';
export interface ParseResult { kind: PayloadKind; data: unknown; valid: boolean; error?: string; }

export class PayloadCircuitBreaker {
  private consecutiveFailures = 0;
  private tripped = false;
  constructor(private threshold = 8, private onTrip?: (n: number) => void) {}
  get isTripped(): boolean { return this.tripped; }
  recordSuccess(): void { this.consecutiveFailures = 0; }
  recordFailure(reason?: string): void {
    this.consecutiveFailures++;
    logger().warn({ consecutiveFailures: this.consecutiveFailures, reason }, 'WS payload validation failure');
    if (this.consecutiveFailures >= this.threshold && !this.tripped) {
      this.tripped = true;
      (this.onTrip ?? ((n) => logger().fatal({ consecutiveFailures: n }, 'Circuit breaker TRIPPED')))(this.consecutiveFailures);
    }
  }
  reset(): void { this.consecutiveFailures = 0; this.tripped = false; }
}

export function parseWsFrame(raw: string | Buffer, breaker?: PayloadCircuitBreaker): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    breaker?.recordFailure('json_parse');
    return { kind: 'unknown', data: raw, valid: false, error: 'invalid_json' };
  }
  // Prefer crash when explicit crash_point keys present (before generic tick)
  const obj = parsed as Record<string, unknown>;
  if (obj && (obj.crash_point != null || obj.crashPoint != null)) {
    const crashFirst = CrashResultSchema.safeParse(parsed);
    if (crashFirst.success && crashFirst.data.crashPoint !== null) {
      breaker?.recordSuccess(); return { kind: 'crash', data: crashFirst.data, valid: true };
    }
  }
  const tick = TickFrameSchema.safeParse(parsed);
  if (tick.success && (tick.data.multiplier !== null || tick.data.phase !== null)) {
    breaker?.recordSuccess(); return { kind: 'tick', data: tick.data, valid: true };
  }
  const betAck = BetAckSchema.safeParse(parsed);
  if (betAck.success && (betAck.data.betId || betAck.data.clientOrderId)) {
    breaker?.recordSuccess(); return { kind: 'bet_ack', data: betAck.data, valid: true };
  }
  const cashAck = CashOutAckSchema.safeParse(parsed);
  if (cashAck.success && cashAck.data.betId) {
    breaker?.recordSuccess(); return { kind: 'cashout_ack', data: cashAck.data, valid: true };
  }
  const crash = CrashResultSchema.safeParse(parsed);
  if (crash.success && crash.data.crashPoint !== null) {
    breaker?.recordSuccess(); return { kind: 'crash', data: crash.data, valid: true };
  }
  breaker?.recordFailure('no_schema_match');
  return { kind: 'unknown', data: parsed, valid: false, error: 'no_schema_match' };
}
