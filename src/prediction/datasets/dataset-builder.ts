/**
 * DatasetBuilder — reproducible pipeline with comprehensive leakage detection.
 */

import { createHash, randomUUID } from 'crypto';
import { HistoricalRound, Dataset, DatasetMeta, DatasetRow } from '../types.js';
import { FeatureEngine, CURRENT_FEATURE_VERSION } from '../features/feature-engine.js';
import { LabelGenerator, CURRENT_TARGET_VERSION } from '../labels/label-generator.js';
import { getLogger } from '../../observability/logger.js';
import { CriticalError } from '../../utils/errors.js';

export interface DatasetBuildOptions {
  minHistory?: number;
  /** When true (default), throw if leakage is detected */
  failOnLeakage?: boolean;
}

export class DatasetBuilder {
  private readonly logger = getLogger();
  private readonly featureEngine: FeatureEngine;
  private readonly labelGenerator: LabelGenerator;

  constructor(featureEngine?: FeatureEngine, labelGenerator?: LabelGenerator) {
    this.featureEngine = featureEngine ?? new FeatureEngine();
    this.labelGenerator = labelGenerator ?? new LabelGenerator();
  }

  build(rounds: HistoricalRound[], options: DatasetBuildOptions = {}): Dataset {
    const minHistory = options.minHistory ?? 20;
    const failOnLeakage = options.failOnLeakage !== false;

    this.assertChronological(rounds);

    if (rounds.length <= minHistory) {
      return this.emptyDataset(rounds);
    }

    const featureVectors = this.featureEngine.buildSequence(rounds, minHistory);
    const rows: DatasetRow[] = [];
    const seenRoundIds = new Set<string>();

    for (const fv of featureVectors) {
      if (seenRoundIds.has(fv.roundId)) {
        throw new CriticalError(
          `Duplicate round id in dataset features: ${fv.roundId}`,
          'DATASET_DUPLICATE_ROUND'
        );
      }
      seenRoundIds.add(fv.roundId);

      const idx = rounds.findIndex((r) => r.id === fv.roundId);
      if (idx < 0) {
        throw new CriticalError(
          `Feature roundId ${fv.roundId} not found in source rounds`,
          'DATASET_ROUND_MISSING'
        );
      }
      // Feature cutoff: only prior rounds may contribute
      if (idx < minHistory) {
        throw new CriticalError(
          `Feature generated for round index ${idx} below minHistory ${minHistory}`,
          'DATASET_HISTORY_VIOLATION'
        );
      }
      const round = rounds[idx];
      const label = this.labelGenerator.generate(round);
      rows.push({ features: fv, label });
    }

    const leakageIssues = this.detectLeakage(rows, rounds, minHistory);
    const leakageCheckPassed = leakageIssues.length === 0;
    if (!leakageCheckPassed) {
      this.logger.error(
        { component: 'DatasetBuilder', issues: leakageIssues },
        'Dataset leakage detected'
      );
      if (failOnLeakage) {
        throw new CriticalError(
          `Dataset leakage detected: ${leakageIssues.join('; ')}`,
          'DATASET_LEAKAGE'
        );
      }
    }

    const classDist: Record<string, number> = {};
    for (const row of rows) {
      for (const [k, v] of Object.entries(row.label.thresholds)) {
        classDist[`${k}=${v}`] = (classDist[`${k}=${v}`] ?? 0) + 1;
      }
    }

    const sourceFrom = rounds[0]?.crashedAt ?? rounds[0]?.createdAt ?? '';
    const sourceTo =
      rounds[rounds.length - 1]?.crashedAt ?? rounds[rounds.length - 1]?.createdAt ?? '';

    const configHash = createHash('sha256')
      .update(
        [
          this.featureEngine.featureVersion,
          this.labelGenerator.targetVersion,
          this.featureEngine.configHash(),
          this.labelGenerator.configHash(),
          String(minHistory),
          sourceFrom,
          sourceTo,
        ].join('|')
      )
      .digest('hex')
      .slice(0, 16);

    const meta: DatasetMeta = {
      id: randomUUID(),
      featureVersion: this.featureEngine.featureVersion,
      targetVersion: this.labelGenerator.targetVersion,
      sourceFrom,
      sourceTo,
      generatedAt: new Date().toISOString(),
      sampleCount: rows.length,
      classDistribution: classDist,
      missingDataStats: {},
      leakageCheckPassed,
      configHash,
    };

    this.logger.info(
      { component: 'DatasetBuilder', sampleCount: meta.sampleCount, leakageCheckPassed, configHash },
      'Dataset built'
    );

    return { meta, rows };
  }

  private assertChronological(rounds: HistoricalRound[]): void {
    for (let i = 1; i < rounds.length; i++) {
      const prev = new Date(rounds[i - 1].crashedAt ?? rounds[i - 1].createdAt).getTime();
      const cur = new Date(rounds[i].crashedAt ?? rounds[i].createdAt).getTime();
      if (cur < prev) {
        throw new CriticalError(
          `Rounds not chronological at index ${i}`,
          'DATASET_NOT_CHRONOLOGICAL'
        );
      }
    }
  }

  /**
   * Comprehensive leakage checks beyond simple timestamp comparison.
   */
  private detectLeakage(
    rows: DatasetRow[],
    rounds: HistoricalRound[],
    minHistory: number
  ): string[] {
    const issues: string[] = [];
    const idToIndex = new Map(rounds.map((r, i) => [r.id, i]));

    for (const row of rows) {
      const ft = new Date(row.features.timestamp).getTime();
      const lt = new Date(row.label.timestamp).getTime();
      if (ft > lt) {
        issues.push(`feature timestamp after label for ${row.features.roundId}`);
      }

      const idx = idToIndex.get(row.features.roundId);
      if (idx === undefined) {
        issues.push(`unknown round ${row.features.roundId}`);
        continue;
      }
      if (idx < minHistory) {
        issues.push(`insufficient history for ${row.features.roundId}`);
      }

      // Label crash point must not appear as a direct future aggregate in sample_size mismatch
      if (row.features.meta.sampleSize !== idx) {
        // sampleSize should equal number of prior rounds (= index when chronological from 0)
        // Allow slight flexibility only if filtered; flag large mismatches
        if (Math.abs(row.features.meta.sampleSize - idx) > 0 && row.features.meta.sampleSize > idx) {
          issues.push(
            `sampleSize ${row.features.meta.sampleSize} exceeds prior index ${idx} for ${row.features.roundId}`
          );
        }
      }

      // Feature values must be finite
      for (const [k, v] of Object.entries(row.features.values)) {
        if (!Number.isFinite(v)) {
          issues.push(`non-finite feature ${k} on ${row.features.roundId}`);
        }
      }
    }

    // Duplicate labels
    const labelIds = rows.map((r) => r.label.roundId);
    if (new Set(labelIds).size !== labelIds.length) {
      issues.push('duplicate labels in dataset');
    }

    return issues;
  }

  private emptyDataset(rounds: HistoricalRound[]): Dataset {
    return {
      meta: {
        id: randomUUID(),
        featureVersion: CURRENT_FEATURE_VERSION,
        targetVersion: CURRENT_TARGET_VERSION,
        sourceFrom: rounds[0]?.createdAt ?? '',
        sourceTo: rounds[rounds.length - 1]?.createdAt ?? '',
        generatedAt: new Date().toISOString(),
        sampleCount: 0,
        classDistribution: {},
        missingDataStats: {},
        leakageCheckPassed: true,
        configHash: 'empty',
      },
      rows: [],
    };
  }
}
