import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from './registry.js';

export const workerJobsTotal = new Counter({
  name: 'crash_worker_jobs_total',
  help: 'Worker jobs completed',
  labelNames: ['worker', 'status'],
  registers: [metricsRegistry],
});

export const workerJobDurationMs = new Histogram({
  name: 'crash_worker_job_duration_ms',
  help: 'Worker job duration ms',
  labelNames: ['worker'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [metricsRegistry],
});

export const workerInflight = new Gauge({
  name: 'crash_worker_inflight',
  help: 'In-flight worker jobs',
  labelNames: ['worker'],
  registers: [metricsRegistry],
});

export const workerLastSuccessUnix = new Gauge({
  name: 'crash_worker_last_success_unixtime',
  help: 'Unix time of last successful worker job',
  labelNames: ['worker'],
  registers: [metricsRegistry],
});

export const workerDlqTotal = new Counter({
  name: 'crash_worker_dlq_total',
  help: 'Worker dead-letter enqueues',
  labelNames: ['worker'],
  registers: [metricsRegistry],
});

export const workerMissingTotal = new Counter({
  name: 'crash_worker_missing_total',
  help: 'Dispatch to unknown worker name',
  labelNames: ['worker'],
  registers: [metricsRegistry],
});
