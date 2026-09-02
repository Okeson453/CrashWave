/**
 * Decision Engine — sits between prediction and execution.
 * Design ref: Section 2.8, Section 11
 */

import { randomUUID } from 'crypto';
import { getLogger } from '../observability/logger';
import { OpportunityRanker } from '../opportunity/ranker';
import {
  scoreOpportunity,
  type OpportunityDimensions,
  type ScoredOpportunity,
  type DecisionRecord,
  type DecisionType,
} from '../opportunity/types';
import type { SheathMode } from '../core/sheath-mode';
import { LatencyTimer } from '../observability/performance/latency';
import { featureHotCache, predictionHotCache } from '../observability/performance/hot-cache';

export interface DecisionInput {
  roundId: string;
  tenantId?: string | null;
  probability: number;
  confidence: number;
  dimensions: OpportunityDimensions;
  regime?: string | null;
  modelVersion?: string | null;
  predictionId?: string;
  /** Dynamic threshold override from recent performance */
  dynamicThreshold?: number;
}

export interface DecisionEngineOptions {
  baseEnterThreshold?: number;
  ranker?: OpportunityRanker;
  sheathMode?: SheathMode;
}

export class DecisionEngine {
  private readonly logger = getLogger();
  private readonly ranker: OpportunityRanker;
  private readonly sheathMode: SheathMode | null;
  private readonly baseEnterThreshold: number;

  constructor(options: DecisionEngineOptions = {}) {
    this.ranker = options.ranker ?? new OpportunityRanker();
    this.sheathMode = options.sheathMode ?? null;
    this.baseEnterThreshold = options.baseEnterThreshold ?? 0.42;
  }

  getRanker(): OpportunityRanker {
    return this.ranker;
  }

  decide(input: DecisionInput): DecisionRecord {
    const timer = new LatencyTimer();
    const now = new Date().toISOString();

    // Prefer hot-cache dimensions when available (strengthens consistency, avoids recompute)
    const cachedFeatures = featureHotCache.get('latest');
    const cachedPred = predictionHotCache.get(input.roundId);
    let dims = input.dimensions;
    if (cachedFeatures) {
      dims = {
        ...dims,
        dataQuality: cachedFeatures.quality_score ?? dims.dataQuality,
        temporalConsistency: Math.min(
          1,
          0.5 + (cachedFeatures.hit_rate_13 ?? 0.5) * 0.5
        ),
      };
    }
    let probability = input.probability;
    let confidence = input.confidence;
    if (cachedPred) {
      probability = cachedPred.probability;
      confidence = cachedPred.confidence;
    }

    const qualityScore = scoreOpportunity(dims);
    const expiresAt = new Date(Date.now() + 45_000).toISOString();

    const opportunity: ScoredOpportunity = {
      id: randomUUID(),
      roundId: input.roundId,
      tenantId: input.tenantId ?? null,
      dimensions: dims,
      qualityScore,
      probability,
      confidence,
      regime: input.regime ?? cachedPred?.regimeId ?? null,
      modelVersion: input.modelVersion ?? cachedPred?.modelVersion ?? null,
      scoredAt: now,
      expiresAt,
    };

    const ranked = this.ranker.upsert(opportunity);
    const threshold = input.dynamicThreshold ?? this.baseEnterThreshold;
    const reasons: string[] = [];
    let decision: DecisionType = 'REJECT';

    // Sheath gate
    if (this.sheathMode?.isBettingSuspended()) {
      decision = 'SHEATH';
      reasons.push(`Betting suspended: sheath state=${this.sheathMode.getState()}`);
    } else if (!ranked) {
      decision = 'REJECT';
      reasons.push(`Quality ${qualityScore.toFixed(3)} below min ranker threshold`);
    } else if (qualityScore < threshold) {
      decision = 'REJECT';
      reasons.push(`Quality ${qualityScore.toFixed(3)} < threshold ${threshold.toFixed(3)}`);
    } else if (!this.ranker.isApproved(ranked.id)) {
      decision = 'WAIT';
      reasons.push(`Rank ${ranked.rank} outside top fraction of opportunity window`);
    } else if (confidence < 0.25) {
      decision = 'MONITOR';
      reasons.push('Confidence too low for entry; monitoring only');
    } else {
      decision = 'ENTER';
      reasons.push(
        `Quality ${qualityScore.toFixed(3)} ≥ ${threshold.toFixed(3)}, rank=${ranked.rank}`
      );
    }

    const latencyMs = timer.record('decision');
    const record: DecisionRecord = {
      id: randomUUID(),
      opportunityId: opportunity.id,
      roundId: input.roundId,
      decision,
      qualityScore,
      rank: ranked?.rank ?? null,
      thresholdUsed: threshold,
      reasons,
      provenance: {
        predictionId: input.predictionId,
        modelVersions: input.modelVersion ? [input.modelVersion] : undefined,
        regime: input.regime,
        sheathState: this.sheathMode?.getState(),
      },
      decidedAt: now,
    };

    this.logger.info(
      {
        component: 'DecisionEngine',
        roundId: input.roundId,
        decision: record.decision,
        qualityScore,
        rank: record.rank,
        reasons,
        latencyMs: Math.round(latencyMs * 100) / 100,
      },
      `Decision: ${record.decision}`
    );

    return record;
  }
}
