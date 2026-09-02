/**
 * In-memory Prediction Provenance Repository (personal-use build).
 *
 * Per spec §4: the durable PredictionProvenanceRepository (which writes to
 * Postgres tables created in migration 025) is removed in personal use.
 * The InMemoryPredictionProvenanceRepository is kept because the
 * `design-acceptance` and `partials-closure` spec-keep tests
 * (spec §18.1) directly exercise it. It is exported from
 * `@/persistence/repositories/prediction-provenance-repo` so the existing
 * test imports resolve.
 *
 * The methods are typed loosely (the production repo is gone) so we
 * don't have to define a full interface here. Callers cast as needed.
 */

export class InMemoryPredictionProvenanceRepository {
  readonly modelScores: unknown[] = [];
  readonly calibrations: unknown[] = [];
  readonly opportunities: unknown[] = [];
  readonly shadows: unknown[] = [];
  readonly drifts: unknown[] = [];

  async recordModelScores(_predictionId: string, scores: unknown): Promise<void> {
    this.modelScores.push(scores);
  }
  async recordCalibration(input: unknown): Promise<void> {
    this.calibrations.push(input);
  }
  async recordOpportunity(input: unknown): Promise<void> {
    this.opportunities.push(input);
  }
  async recordShadow(input: unknown): Promise<void> {
    this.shadows.push(input);
  }
  async recordDrift(input: unknown): Promise<void> {
    this.drifts.push(input);
  }
  async upsertModelVersion(_input?: unknown): Promise<void> {
    /* no-op in personal-use build */
  }
  async enrichPrediction(_input?: unknown): Promise<void> {
    /* no-op in personal-use build */
  }
}
