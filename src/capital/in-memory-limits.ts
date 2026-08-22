/**
 * Synchronous In-Memory Limits
 * Enforce max drawdown D_max in CPU memory BEFORE payload construction.
 * Zero async — cannot be bypassed by event-loop delays.
 */
export interface CapitalLimitsConfig {
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
  panicBalanceFloor: number;
  maxStake: number;
  startingBankroll: number;
}

export class InMemoryCapitalGuard {
  private peakBankroll: number;
  private currentBankroll: number;
  private locked = false;
  private lockReason: string | null = null;

  constructor(private config: CapitalLimitsConfig) {
    this.peakBankroll = config.startingBankroll;
    this.currentBankroll = config.startingBankroll;
  }

  updateBalance(balance: number): void {
    this.currentBankroll = balance;
    if (balance > this.peakBankroll) this.peakBankroll = balance;
    this.evaluate();
  }

  private evaluate(): void {
    if (this.currentBankroll <= this.config.panicBalanceFloor) {
      this.locked = true;
      this.lockReason = `PANIC_FLOOR: balance ${this.currentBankroll} <= ${this.config.panicBalanceFloor}`;
      return;
    }
    const drawdownAbs = this.peakBankroll - this.currentBankroll;
    if (drawdownAbs >= this.config.maxDrawdownAbs) {
      this.locked = true;
      this.lockReason = `MAX_DRAWDOWN_ABS: ${drawdownAbs} >= ${this.config.maxDrawdownAbs}`;
      return;
    }
    const drawdownPct = this.peakBankroll > 0 ? drawdownAbs / this.peakBankroll : 0;
    if (drawdownPct >= this.config.maxDrawdownPct) {
      this.locked = true;
      this.lockReason = `MAX_DRAWDOWN_PCT: ${(drawdownPct * 100).toFixed(2)}% >= ${(this.config.maxDrawdownPct * 100).toFixed(2)}%`;
    }
  }

  /** Call synchronously before any bet payload is built */
  canPlaceBet(stake: number): { allowed: boolean; reason?: string } {
    if (this.locked) return { allowed: false, reason: this.lockReason ?? 'CAPITAL_LOCKED' };
    if (stake > this.config.maxStake) return { allowed: false, reason: `STAKE_EXCEEDS_MAX: ${stake} > ${this.config.maxStake}` };
    if (stake > this.currentBankroll) return { allowed: false, reason: 'INSUFFICIENT_BALANCE' };
    if (this.currentBankroll - stake < this.config.panicBalanceFloor) {
      return { allowed: false, reason: 'WOULD_BREACH_PANIC_FLOOR' };
    }
    return { allowed: true };
  }

  get isLocked(): boolean { return this.locked; }
  get reason(): string | null { return this.lockReason; }

  /** Operator override after review */
  unlock(operatorAck: string): void {
    this.locked = false;
    this.lockReason = null;
    // audit log would go here
    void operatorAck;
  }
}
