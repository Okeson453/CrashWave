export interface RegimeClusterState {
  clusterId: number;
  clusterDistance: number;
  clusterConfidence: number;
  regimeDuration: number;
  transitionProbability: number;
  sampleCount: number;
  historicalHitRate: number;
  historicalCalibration: number;
  label: string;
}
