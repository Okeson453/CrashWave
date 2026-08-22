export type HealthStatus = 'OK' | 'DEGRADED' | 'FAILING' | 'UNKNOWN';

export interface ComponentHealth {
  component: string;
  status: HealthStatus;
  message: string;
  lastCheckedAt: string;
  metricValue?: number;
}

export interface HealthCheckResult {
  overallStatus: HealthStatus;
  components: ComponentHealth[];
  checkedAt: string;
}
