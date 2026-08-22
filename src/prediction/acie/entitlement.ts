/**
 * Entitlement Gate — product tier limits (NOT part of ACIE intelligence).
 * Sits after Strategy; ACIE remains tier-agnostic.
 */

import { EntitlementCheck, EntitlementResult } from './types.js';

export class EntitlementGate {
  check(ctx: EntitlementCheck): EntitlementResult {
    if (ctx.dailyEntriesUsed >= ctx.dailyEntriesLimit) {
      return {
        allowed: false,
        reason: `Daily entry limit reached: ${ctx.dailyEntriesUsed}/${ctx.dailyEntriesLimit} (plan: ${ctx.planName}).`,
      };
    }
    return { allowed: true };
  }
}
