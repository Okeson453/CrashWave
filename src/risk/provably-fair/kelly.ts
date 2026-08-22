export interface KellyParams {
  winProbability: number; netOdds: number; lambda: number;
  maxFraction?: number; bankroll: number; absoluteMaxStake?: number;
}

export function fractionalKellyStake(p: KellyParams): number {
  const { winProbability: pWin, netOdds: b, lambda, bankroll } = p;
  const q = 1 - pWin;
  if (b <= 0 || pWin <= 0 || bankroll <= 0) return 0;
  const edge = b * pWin - q;
  if (edge <= 0) return 0;
  const fullKelly = edge / b;
  const fraction = Math.min(fullKelly * lambda, p.maxFraction ?? 0.05);
  let stake = bankroll * fraction;
  if (p.absoluteMaxStake != null) stake = Math.min(stake, p.absoluteMaxStake);
  return Math.max(0, Math.floor(stake * 100) / 100);
}

export interface ParetoParams { xm: number; alpha: number; target: number; }
export function paretoSurvival(params: ParetoParams): number {
  if (params.target <= params.xm) return 1;
  return Math.pow(params.xm / params.target, params.alpha);
}
export function consecutiveLossProbability(n: number, pLossSingle: number): number {
  return Math.pow(pLossSingle, n);
}
export function shouldTriggerVolatilityCooldown(opts: {
  consecutiveLosses: number; expectedLossProb: number; sigmaThreshold?: number;
}): boolean {
  const sigma = opts.sigmaThreshold ?? 3;
  const meanStreak = 1 / Math.max(opts.expectedLossProb, 1e-6);
  const stdStreak = Math.sqrt((1 - opts.expectedLossProb) / Math.max(opts.expectedLossProb ** 2, 1e-12));
  return opts.consecutiveLosses >= meanStreak + sigma * stdStreak;
}
