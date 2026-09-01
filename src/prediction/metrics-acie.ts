import { Histogram } from 'prom-client';
import { metricsRegistry } from '../observability/metrics/registry.js';

export const acieHeavyEvidenceLatencyMs = new Histogram({
  name: 'crash_acie_heavy_evidence_ms',
  help: 'Duration of heavy ACIE evidence evaluation (off hot path)',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [metricsRegistry],
});
