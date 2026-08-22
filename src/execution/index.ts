/** Re-export latency-compensated execution primitives */
export {
  NativeSocketWorker,
  RttEstimator,
  computeTriggerMultiplier,
  type SocketWorkerConfig,
  type PreSendParams,
} from '../network/tls/native-socket';
