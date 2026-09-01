/**
 * Prediction stack snapshot v2 — crash points, ACIE online, ensemble flags.
 */

import { globalIncrementalState } from './incremental-state-engine.js';
import { globalCalibrationState } from '../calibration/calibration-state.js';
import { getLogger } from '../../observability/logger.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { OnlineAdaptiveState } from '../acie/online-state.js';

const logger = getLogger();
const SNAPSHOT_KEY = process.env.PREDICTION_SNAPSHOT_REDIS_KEY ?? 'crash:prediction:stack:v2';

export interface PredictionStackSnapshot {
  version: 2;
  savedAt: string;
  crashPoints: number[];
  calibrationVersion: string;
  acieOnline?: OnlineAdaptiveState;
  acieCrashPoints?: number[];
  acieConsecutiveLosses?: number;
  ensembleFlags?: Record<string, boolean>;
}

export type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
};

export type AcieLike = {
  exportSnapshot: () => {
    online: OnlineAdaptiveState;
    crashPoints: number[];
    consecutiveLosses: number;
  };
  importSnapshot: (snap: {
    online?: OnlineAdaptiveState;
    crashPoints?: number[];
    consecutiveLosses?: number;
  }) => void;
};

export function snapshotPredictionStack(
  maxPoints = 2000,
  acie?: AcieLike | null
): PredictionStackSnapshot {
  const points =
    typeof (globalIncrementalState as unknown as { getRecentPoints?: (n: number) => number[] })
      .getRecentPoints === 'function'
      ? (globalIncrementalState as unknown as { getRecentPoints: (n: number) => number[] }).getRecentPoints(
          maxPoints
        )
      : [];
  const acieSnap = acie?.exportSnapshot();
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    crashPoints: points,
    calibrationVersion: globalCalibrationState.version,
    acieOnline: acieSnap?.online,
    acieCrashPoints: acieSnap?.crashPoints,
    acieConsecutiveLosses: acieSnap?.consecutiveLosses,
  };
}

export function restoreIncrementalFromPoints(points: number[]): void {
  if (!points.length) return;
  globalIncrementalState.seed(points);
  logger.info(
    { component: 'StatePersistence', n: points.length },
    'Incremental state restored from points'
  );
}

export function applySnapshot(snap: PredictionStackSnapshot, acie?: AcieLike | null): void {
  const pts = snap.crashPoints?.length ? snap.crashPoints : snap.acieCrashPoints;
  if (pts?.length) restoreIncrementalFromPoints(pts);
  if (acie && (snap.acieOnline || snap.acieCrashPoints?.length)) {
    acie.importSnapshot({
      online: snap.acieOnline,
      crashPoints: snap.acieCrashPoints ?? snap.crashPoints,
      consecutiveLosses: snap.acieConsecutiveLosses,
    });
    logger.info({ component: 'StatePersistence' }, 'ACIE online state restored');
  }
}

export async function saveSnapshotToRedis(
  redis: RedisLike,
  acie?: AcieLike | null
): Promise<void> {
  const snap = snapshotPredictionStack(2000, acie);
  await redis.set(SNAPSHOT_KEY, JSON.stringify(snap));
  logger.info(
    { component: 'StatePersistence', points: snap.crashPoints.length },
    'Snapshot v2 saved to Redis'
  );
}

export async function loadSnapshotFromRedis(
  redis: RedisLike,
  acie?: AcieLike | null
): Promise<boolean> {
  try {
    const raw = await redis.get(SNAPSHOT_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw) as PredictionStackSnapshot;
    applySnapshot(snap, acie);
    return true;
  } catch (err) {
    logger.warn(
      { component: 'StatePersistence', error: String(err) },
      'Redis snapshot load failed'
    );
    return false;
  }
}

export async function saveSnapshotToFile(
  filePath?: string,
  acie?: AcieLike | null
): Promise<string> {
  const dest =
    filePath ??
    path.join(process.env.PREDICTION_SNAPSHOT_DIR ?? '/tmp/crash-snapshots', 'prediction-stack-v2.json');
  await mkdir(path.dirname(dest), { recursive: true });
  const snap = snapshotPredictionStack(2000, acie);
  await writeFile(dest, JSON.stringify(snap), 'utf8');
  return dest;
}

export async function loadSnapshotFromFile(
  filePath?: string,
  acie?: AcieLike | null
): Promise<boolean> {
  const dest =
    filePath ??
    path.join(process.env.PREDICTION_SNAPSHOT_DIR ?? '/tmp/crash-snapshots', 'prediction-stack-v2.json');
  try {
    const raw = await readFile(dest, 'utf8');
    const snap = JSON.parse(raw) as PredictionStackSnapshot;
    applySnapshot(snap, acie);
    return true;
  } catch {
    return false;
  }
}

export async function loadPredictionStackOnBoot(
  redis?: RedisLike | null,
  acie?: AcieLike | null
): Promise<void> {
  if (redis) {
    const ok = await loadSnapshotFromRedis(redis, acie);
    if (ok) return;
  }
  await loadSnapshotFromFile(undefined, acie);
}
