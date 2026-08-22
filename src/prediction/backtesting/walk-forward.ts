/**
 * Walk-forward chronological validation.
 * Calls model.fit(trainingDataset) when the model implements fit().
 * Never shuffles time-series data.
 */

import { HistoricalRound, WalkForwardWindow, BacktestConfig, ThresholdTarget } from '../types.js';
import { DatasetBuilder } from '../datasets/dataset-builder.js';
import { StatisticalValidator } from '../validation/statistical-validator.js';
import { BaselineStatisticalModel, PredictiveModel } from '../models/baseline-model.js';
import { BacktestEngine } from './backtest-engine.js';
import { getLogger } from '../../observability/logger.js';

export interface WalkForwardConfig {
  trainSize: number;
  valSize: number;
  testSize: number;
  stepSize: number;
  target: ThresholdTarget;
  backtest?: Omit<BacktestConfig, 'from' | 'to' | 'target'>;
}

export class WalkForwardValidator {
  private readonly logger = getLogger();
  private readonly datasetBuilder = new DatasetBuilder();
  private readonly validator = new StatisticalValidator();
  private readonly backtestEngine = new BacktestEngine();

  constructor(private readonly modelFactory: () => PredictiveModel = () => new BaselineStatisticalModel()) {}

  run(rounds: HistoricalRound[], cfg: WalkForwardConfig): WalkForwardWindow[] {
    const windows: WalkForwardWindow[] = [];
    let start = 0;

    while (start + cfg.trainSize + cfg.valSize + cfg.testSize <= rounds.length) {
      const trainEnd = start + cfg.trainSize;
      const valEnd = trainEnd + cfg.valSize;
      const testEnd = valEnd + cfg.testSize;

      const trainRounds = rounds.slice(start, trainEnd);
      const valRounds = rounds.slice(trainEnd, valEnd);
      const testRounds = rounds.slice(valEnd, testEnd);

      // Fresh model instance per window (trainable models re-fit)
      const model = this.modelFactory();

      const trainDataset = this.datasetBuilder.build(trainRounds, {
        minHistory: Math.min(20, Math.floor(trainRounds.length * 0.4)),
        failOnLeakage: true,
      });
      if (model.fit) {
        model.fit(trainDataset);
      }

      // Validation: features may use train+val history, metrics only on val rows
      const valDataset = this.datasetBuilder.build([...trainRounds, ...valRounds], {
        minHistory: Math.min(20, Math.floor(trainRounds.length * 0.5)),
        failOnLeakage: true,
      });
      const valRows = valDataset.rows.filter((r) =>
        valRounds.some((vr) => vr.id === r.features.roundId)
      );
      const valScores = valRows.map((row) => model.predict(row.features, cfg.target, null).probability);
      const valMetrics = this.validator.evaluate(
        valScores,
        { ...valDataset, rows: valRows },
        cfg.target
      );

      const testDataset = this.datasetBuilder.build(
        [...trainRounds, ...valRounds, ...testRounds],
        {
          minHistory: Math.min(20, Math.floor((trainRounds.length + valRounds.length) * 0.5)),
          failOnLeakage: true,
        }
      );
      const testRows = testDataset.rows.filter((r) =>
        testRounds.some((tr) => tr.id === r.features.roundId)
      );
      const testScores = testRows.map((row) => model.predict(row.features, cfg.target, null).probability);
      const testMetrics = this.validator.evaluate(
        testScores,
        { ...testDataset, rows: testRows },
        cfg.target
      );

      let backtestResult;
      if (cfg.backtest) {
        backtestResult = this.backtestEngine.run(testRounds, {
          ...cfg.backtest,
          from: testRounds[0]?.createdAt ?? '',
          to: testRounds[testRounds.length - 1]?.createdAt ?? '',
          target: cfg.target,
        });
      }

      windows.push({
        trainFrom: trainRounds[0]?.createdAt ?? '',
        trainTo: trainRounds[trainRounds.length - 1]?.createdAt ?? '',
        valFrom: valRounds[0]?.createdAt ?? '',
        valTo: valRounds[valRounds.length - 1]?.createdAt ?? '',
        testFrom: testRounds[0]?.createdAt ?? '',
        testTo: testRounds[testRounds.length - 1]?.createdAt ?? '',
        validationMetrics: valMetrics,
        testMetrics,
        backtest: backtestResult,
      });

      start += cfg.stepSize;
    }

    this.logger.info(
      { component: 'WalkForwardValidator', windows: windows.length },
      'Walk-forward complete'
    );
    return windows;
  }
}
