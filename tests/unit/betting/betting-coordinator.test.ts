import { BettingCoordinator } from '../../../src/betting/betting-coordinator';
import { EntryDecisionService } from '../../../src/prediction/entry-decision-service';
import { InMemoryRoundRepository } from '../../../src/persistence/repositories/round-repo';
import { InMemoryPredictionRepository } from '../../../src/persistence/repositories/prediction-repo';
import { HistoricalDataService } from '../../../src/prediction/historical-data-service';
import { RiskEngine } from '../../../src/betting/risk-engine';
import { RiskEvaluationInput } from '../../../src/betting/types';
import { AppConfig } from '../../../src/config/schema';

function riskInput(): RiskEvaluationInput {
  return {
    mode: 'dry-run',
    operatorAuthorized: true,
    sessionAuthenticated: true,
    gameLoaded: true,
    roundState: {
      roundId: 'r1',
      phase: 'starting',
      confidence: 'high',
      multiplier: 1,
      startedAt: new Date().toISOString(),
    } as any,
    currentBalance: 50_000,
    dailyEntriesConfirmed: 0,
    paused: false,
    killSwitch: false,
    browserHealthy: true,
    gameAdapterHealthy: true,
    openBetExists: false,
    cooldownElapsed: true,
    requiredStake: 700,
    balanceBuffer: 0,
    maxDailyEntries: 100,
    minConfidenceForEntry: 'high',
    consecutiveErrors: 0,
    maxConsecutiveErrors: 5,
    cashOutFailures: 0,
    maxCashOutFailures: 3,
    minPredictionProbability: 0,
    minPredictionConfidence: 0,
  };
}

describe('BettingCoordinator', () => {
  it('drives ROUND_STARTED → EntryDecision → RISK_APPROVED/REJECTED on state machine', async () => {
    const roundRepo = new InMemoryRoundRepository();
    // seed history so prediction can run
    for (let i = 0; i < 40; i++) {
      await roundRepo.create({
        externalRoundId: `ext-${i}`,
        sessionId: 's1',
        startedAt: new Date(Date.now() - (40 - i) * 60_000).toISOString(),
        crashedAt: new Date(Date.now() - (40 - i) * 60_000 + 5000).toISOString(),
        observedCrashPoint: i % 3 === 0 ? 2.0 : 1.2,
        finalConfirmedCrashPoint: i % 3 === 0 ? 2.0 : 1.2,
        observationSource: 'websocket',
        dataQuality: 'high',
      });
    }

    const entry = new EntryDecisionService({
      historicalData: new HistoricalDataService(roundRepo as any),
      predictionRepo: new InMemoryPredictionRepository(),
      riskEngine: new RiskEngine(),
    });

    const transitions: string[] = [];
    const coord = new BettingCoordinator({
      config: {
        system: { mode: 'dry-run' },
        betting: { stakePerEntry: 700, cashOutTarget: 1.3, maxDailyEntries: 100 },
      } as unknown as AppConfig,
      entryDecisionService: entry,
      liveBetExecutor: null,
      buildRiskInput: riskInput,
      sessionId: 's1',
      onStateChange: (from, to) => {
        transitions.push(`${from}->${to}`);
      },
    });

    await coord.onRoundStarted('live-round-1', {
      roundId: 'live-round-1',
      phase: 'starting',
      confidence: 'high',
      multiplier: 1,
      startedAt: new Date().toISOString(),
    } as any);

    const state = coord.getStateMachine().getState();
    // After approve path may be ENTRY_APPROVED or further; after reject back to OBSERVING
    expect(['ENTRY_APPROVED', 'ENTRY_EVALUATING', 'OBSERVING', 'BET_PLACING', 'BET_ACTIVE']).toContain(state);
    expect(transitions.length).toBeGreaterThan(0);

    await coord.onRoundCrashed('live-round-1', 1.5);
  });
});
