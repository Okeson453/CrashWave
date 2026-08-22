export type BetState =
  | 'PENDING'
  | 'RESERVED'
  | 'PLACED'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'CASH_OUT_REQUESTED'
  | 'CASHED_OUT'
  | 'LOST'
  | 'FAILED'
  | 'UNKNOWN'
  | 'RECONCILED';

export interface EntryConditions {
  modeIsLive: boolean;
  operatorAuthorized: boolean;
  sessionAuthenticated: boolean;
  gameLoaded: boolean;
  roundStateValid: boolean;
  balanceSufficient: boolean;
  dailyEntriesBelowLimit: boolean;
  notPaused: boolean;
  killSwitchOff: boolean;
  browserHealthy: boolean;
  gameAdapterHealthy: boolean;
  observationConfidenceHigh: boolean;
  noOpenBet: boolean;
  cooldownElapsed: boolean;
}

export interface BetRecord {
  id: string;
  sessionId: string;
  roundId: string;
  dailyKey: string;
  stake: number;
  target: number;
  state: BetState;
  pnl: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CashOutResult {
  success: boolean;
  multiplier: number | null;
  pnl: number | null;
  error?: string;
}

export interface BetPlacementResult {
  success: boolean;
  betId?: string;
  error?: string;
}
