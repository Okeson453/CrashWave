/**
 * PredictionRepository — persist predictions and their outcomes for audit / evaluation.
 */

import { Pool } from 'pg';
import { getLogger } from '../../observability/logger.js';
import { CriticalError } from '../../utils/errors.js';
import { getPool } from '../client.js';
import { PredictionSignal } from '../../prediction/types.js';

export interface PredictionRecord {
  id: string;
  predictionId: string;
  sessionId: string | null;
  roundId: string | null;
  externalRoundId: string | null;
  modelName: string;
  modelVersion: string;
  featureVersion: string;
  targetVersion: string | null;
  targetThreshold: number;
  score: number;
  probability: number;
  confidence: number;
  regimeId: string | null;
  regimeName: string | null;
  dataQuality: number | null;
  featureSummary: Record<string, number> | null;
  reasoning: string[] | null;
  createdAt: string;
  expiresAt: string;
  ingestedAt: string;
}

export interface PredictionOutcomeRecord {
  id: string;
  predictionId: string;
  roundId: string | null;
  riskApproved: boolean | null;
  riskRejectionReason: string | null;
  betExecuted: boolean;
  actualCrashPoint: number | null;
  thresholdHit: boolean | null;
  predictionCorrect: boolean | null;
  probabilityError: number | null;
  absoluteError: number | null;
  resolvedAt: string;
}

export interface CreatePredictionInput {
  signal: PredictionSignal;
  sessionId?: string | null;
  roundId?: string | null;
  externalRoundId?: string | null;
  regimeName?: string | null;
  targetVersion?: string | null;
}

export interface ResolveOutcomeInput {
  predictionId: string;
  roundId?: string | null;
  riskApproved?: boolean | null;
  riskRejectionReason?: string | null;
  betExecuted?: boolean;
  actualCrashPoint?: number | null;
  targetThreshold: number;
}

export class PredictionRepository {
  private readonly logger = getLogger();
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || getPool();
  }

  async create(input: CreatePredictionInput): Promise<PredictionRecord> {
    const s = input.signal;
    const [modelName, modelVersion] = s.modelVersion.includes('@')
      ? s.modelVersion.split('@')
      : [s.modelVersion, 'unknown'];

    const query = `
      INSERT INTO predictions (
        prediction_id, session_id, round_id, external_round_id,
        model_name, model_version, feature_version, target_version,
        target_threshold, score, probability, confidence,
        regime_id, regime_name, data_quality, feature_summary, reasoning,
        created_at, expires_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )
      ON CONFLICT (prediction_id) DO UPDATE SET ingested_at = now()
      RETURNING *
    `;

    try {
      const result = await this.pool.query(query, [
        s.predictionId,
        input.sessionId ?? null,
        input.roundId ?? null,
        input.externalRoundId ?? null,
        modelName,
        modelVersion,
        s.featureVersion,
        input.targetVersion ?? null,
        s.target,
        s.score,
        s.probability,
        s.confidence,
        s.regimeId,
        input.regimeName ?? null,
        s.dataQuality,
        JSON.stringify(s.featureSummary),
        JSON.stringify(s.reasoning),
        s.timestamp,
        s.expiresAt,
      ]);
      return this.mapPrediction(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'PredictionRepository', error: message }, 'Failed to persist prediction');
      throw new CriticalError(`Prediction persist failed: ${message}`, 'PREDICTION_PERSIST_FAILED');
    }
  }

  async resolveOutcome(input: ResolveOutcomeInput): Promise<PredictionOutcomeRecord> {
    const hit =
      input.actualCrashPoint != null
        ? input.actualCrashPoint >= input.targetThreshold
        : null;

    // Load prediction probability for error calc
    const pred = await this.findByPredictionId(input.predictionId);
    const probability = pred?.probability ?? null;
    const correct = hit != null ? hit === true : null; // correct if threshold was hit when we predicted entry
    const probabilityError =
      probability != null && hit != null ? probability - (hit ? 1 : 0) : null;
    const absoluteError =
      probabilityError != null ? Math.abs(probabilityError) : null;

    const query = `
      INSERT INTO prediction_outcomes (
        prediction_id, round_id, risk_approved, risk_rejection_reason,
        bet_executed, actual_crash_point, threshold_hit, prediction_correct,
        probability_error, absolute_error
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (prediction_id) DO UPDATE SET
        risk_approved = COALESCE(EXCLUDED.risk_approved, prediction_outcomes.risk_approved),
        risk_rejection_reason = COALESCE(EXCLUDED.risk_rejection_reason, prediction_outcomes.risk_rejection_reason),
        bet_executed = EXCLUDED.bet_executed,
        actual_crash_point = COALESCE(EXCLUDED.actual_crash_point, prediction_outcomes.actual_crash_point),
        threshold_hit = COALESCE(EXCLUDED.threshold_hit, prediction_outcomes.threshold_hit),
        prediction_correct = COALESCE(EXCLUDED.prediction_correct, prediction_outcomes.prediction_correct),
        probability_error = COALESCE(EXCLUDED.probability_error, prediction_outcomes.probability_error),
        absolute_error = COALESCE(EXCLUDED.absolute_error, prediction_outcomes.absolute_error),
        resolved_at = now()
      RETURNING *
    `;

    try {
      const result = await this.pool.query(query, [
        input.predictionId,
        input.roundId ?? null,
        input.riskApproved ?? null,
        input.riskRejectionReason ?? null,
        input.betExecuted ?? false,
        input.actualCrashPoint ?? null,
        hit,
        correct,
        probabilityError,
        absoluteError,
      ]);
      return this.mapOutcome(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'PredictionRepository', error: message }, 'Failed to resolve outcome');
      throw new CriticalError(`Prediction outcome failed: ${message}`, 'PREDICTION_OUTCOME_FAILED');
    }
  }

  async findByPredictionId(predictionId: string): Promise<PredictionRecord | null> {
    const result = await this.pool.query(`SELECT * FROM predictions WHERE prediction_id = $1`, [
      predictionId,
    ]);
    if (result.rows.length === 0) return null;
    return this.mapPrediction(result.rows[0]);
  }

  private mapPrediction(row: Record<string, unknown>): PredictionRecord {
    return {
      id: String(row.id),
      predictionId: String(row.prediction_id),
      sessionId: row.session_id ? String(row.session_id) : null,
      roundId: row.round_id ? String(row.round_id) : null,
      externalRoundId: row.external_round_id ? String(row.external_round_id) : null,
      modelName: String(row.model_name),
      modelVersion: String(row.model_version),
      featureVersion: String(row.feature_version),
      targetVersion: row.target_version ? String(row.target_version) : null,
      targetThreshold: Number(row.target_threshold),
      score: Number(row.score),
      probability: Number(row.probability),
      confidence: Number(row.confidence),
      regimeId: row.regime_id ? String(row.regime_id) : null,
      regimeName: row.regime_name ? String(row.regime_name) : null,
      dataQuality: row.data_quality != null ? Number(row.data_quality) : null,
      featureSummary:
        typeof row.feature_summary === 'object' && row.feature_summary
          ? (row.feature_summary as Record<string, number>)
          : row.feature_summary
            ? JSON.parse(String(row.feature_summary))
            : null,
      reasoning: Array.isArray(row.reasoning)
        ? (row.reasoning as string[])
        : row.reasoning
          ? JSON.parse(String(row.reasoning))
          : null,
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      ingestedAt: String(row.ingested_at),
    };
  }

  private mapOutcome(row: Record<string, unknown>): PredictionOutcomeRecord {
    return {
      id: String(row.id),
      predictionId: String(row.prediction_id),
      roundId: row.round_id ? String(row.round_id) : null,
      riskApproved: row.risk_approved == null ? null : Boolean(row.risk_approved),
      riskRejectionReason: row.risk_rejection_reason ? String(row.risk_rejection_reason) : null,
      betExecuted: Boolean(row.bet_executed),
      actualCrashPoint: row.actual_crash_point != null ? Number(row.actual_crash_point) : null,
      thresholdHit: row.threshold_hit == null ? null : Boolean(row.threshold_hit),
      predictionCorrect: row.prediction_correct == null ? null : Boolean(row.prediction_correct),
      probabilityError: row.probability_error != null ? Number(row.probability_error) : null,
      absoluteError: row.absolute_error != null ? Number(row.absolute_error) : null,
      resolvedAt: String(row.resolved_at),
    };
  }
}

/** In-memory implementation for unit tests (no DB). */
export class InMemoryPredictionRepository {
  private predictions = new Map<string, PredictionRecord>();
  private outcomes = new Map<string, PredictionOutcomeRecord>();
  private seq = 1;

  async create(input: CreatePredictionInput): Promise<PredictionRecord> {
    const s = input.signal;
    const [modelName, modelVersion] = s.modelVersion.includes('@')
      ? s.modelVersion.split('@')
      : [s.modelVersion, 'unknown'];
    const rec: PredictionRecord = {
      id: `pred-${this.seq++}`,
      predictionId: s.predictionId,
      sessionId: input.sessionId ?? null,
      roundId: input.roundId ?? null,
      externalRoundId: input.externalRoundId ?? null,
      modelName,
      modelVersion,
      featureVersion: s.featureVersion,
      targetVersion: input.targetVersion ?? null,
      targetThreshold: s.target,
      score: s.score,
      probability: s.probability,
      confidence: s.confidence,
      regimeId: s.regimeId,
      regimeName: input.regimeName ?? null,
      dataQuality: s.dataQuality,
      featureSummary: { ...s.featureSummary },
      reasoning: [...s.reasoning],
      createdAt: s.timestamp,
      expiresAt: s.expiresAt,
      ingestedAt: new Date().toISOString(),
    };
    this.predictions.set(s.predictionId, rec);
    return rec;
  }

  async resolveOutcome(input: ResolveOutcomeInput): Promise<PredictionOutcomeRecord> {
    const pred = this.predictions.get(input.predictionId);
    const hit =
      input.actualCrashPoint != null
        ? input.actualCrashPoint >= input.targetThreshold
        : null;
    const probability = pred?.probability ?? null;
    const rec: PredictionOutcomeRecord = {
      id: `out-${this.seq++}`,
      predictionId: input.predictionId,
      roundId: input.roundId ?? null,
      riskApproved: input.riskApproved ?? null,
      riskRejectionReason: input.riskRejectionReason ?? null,
      betExecuted: input.betExecuted ?? false,
      actualCrashPoint: input.actualCrashPoint ?? null,
      thresholdHit: hit,
      predictionCorrect: hit != null ? hit === true : null,
      probabilityError:
        probability != null && hit != null ? probability - (hit ? 1 : 0) : null,
      absoluteError:
        probability != null && hit != null ? Math.abs(probability - (hit ? 1 : 0)) : null,
      resolvedAt: new Date().toISOString(),
    };
    this.outcomes.set(input.predictionId, rec);
    return rec;
  }

  async findByPredictionId(predictionId: string): Promise<PredictionRecord | null> {
    return this.predictions.get(predictionId) ?? null;
  }
}
