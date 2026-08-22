export type WindowType =
  | 'last_10'
  | 'last_50'
  | 'last_100'
  | 'last_500'
  | 'session'
  | 'day'
  | 'week'
  | 'month'
  | 'all';

export interface AnalyticsSummary {
  window: WindowType;
  windowSize: number;
  entries: number;
  wins: number;
  losses: number;
  hitRate: number;
  breakEvenHitRate: number;
  realizedPnl: number;
  expectedPnl: number;
  maxDrawdown: number;
  currentDrawdown: number;
  recommendation: string;
}

export interface MetricSnapshot {
  timestamp: string;
  metricName: string;
  value: number;
  labels: Record<string, string>;
}

export interface Recommendation {
  type: 'continue' | 'pause' | 'dry_run' | 'stop' | 'review';
  message: string;
  confidence: number;
  triggeredAt: string;
}
