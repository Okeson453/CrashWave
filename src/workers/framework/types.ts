/**
 * V1.1 Worker Framework — shared types
 * Design ref: Section 3 Worker / Team Architecture
 */

export type WorkerType =
  | 'discovery'
  | 'data-collection'
  | 'signal-scanner'
  | 'confirmation'
  | 'prediction'
  | 'regime'
  | 'entry-optimization'
  | 'risk'
  | 'execution'
  | 'settlement'
  | 'monitoring'
  | 'learning'
  | 'validation'
  | 'sentiment'
  | 'analytics';

export type WorkerStatus =
  | 'starting'
  | 'running'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type WorkerPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';

export interface WorkerHealth {
  status: WorkerStatus;
  lastHeartbeatAt: string;
  lastEventAt: string | null;
  processedCount: number;
  errorCount: number;
  restartCount: number;
  latencyMsP99: number | null;
  message: string | null;
}

export interface WorkerConfig {
  type: WorkerType;
  name: string;
  concurrency: number;
  priority: WorkerPriority;
  heartbeatIntervalMs: number;
  maxConsecutiveErrors: number;
  autoRestart: boolean;
  restartBackoffMs: number;
}

export interface WorkerContext {
  tenantId: string | null;
  correlationId: string;
  eventId: string;
  receivedAt: string;
}

export interface WorkerMetrics {
  throughputPerMinute: number;
  errorRate: number;
  avgLatencyMs: number;
  queueDepth: number;
}

export const DEFAULT_WORKER_CONFIG: Omit<WorkerConfig, 'type' | 'name'> = {
  concurrency: 1,
  priority: 'normal',
  heartbeatIntervalMs: 5_000,
  maxConsecutiveErrors: 5,
  autoRestart: true,
  restartBackoffMs: 1_000,
};
