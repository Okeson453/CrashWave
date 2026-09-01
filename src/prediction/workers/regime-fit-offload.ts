import {
  featureRowsFromCrashPoints,
  runRegimeFitJob,
} from '../regimes/regime-fit-job.js';
import type { LearnedClusteringModel } from '../regimes/learned-clustering.js';

export function fitRegimesOffline(crashPoints: number[], k = 8): LearnedClusteringModel {
  const { rows, outcomes } = featureRowsFromCrashPoints(crashPoints);
  return runRegimeFitJob({ featureRows: rows, outcomes, k });
}
