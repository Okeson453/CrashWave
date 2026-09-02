export {
  buildHardenedLaunchArgs,
  hardenedContextOptions,
  HARDENED_LAUNCH_ARGS,
} from './launch-config.js';
export type { LaunchHardeningOptions } from './launch-config.js';

export {
  CDPSanitizer,
  CDPSanitizedSession,
  cdpSanitizer,
  DEFAULT_CDP_CONFIG,
} from './cdp-sanitizer.js';
export type { CDPSanitizerConfig } from './cdp-sanitizer.js';

export {
  BehavioralEntropyEngine,
  DEFAULT_ENTROPY,
} from './behavioral-entropy.js';
export type { BehavioralEntropyConfig } from './behavioral-entropy.js';

export {
  BehavioralPersona,
  seedFromProfileId,
} from './behavioral-persona.js';
export type {
  PersonaConfig,
  PersonaArchetype,
  BetTiming,
  IdleAction,
} from './behavioral-persona.js';

export { IdleBehaviorEngine } from './idle-behavior.js';
export type { IdleBehaviorConfig } from './idle-behavior.js';

export { buildDeepFingerprintScript } from './deep-fingerprint.js';
export type { DeepFingerprintParams } from './deep-fingerprint.js';

export {
  applyNetworkNormalization,
  getHTTP2LaunchArgs,
  DEFAULT_NETWORK_CONFIG,
} from './network-fingerprint.js';
export type { NetworkFingerprintConfig } from './network-fingerprint.js';

export {
  generateMemoryForensicsScript,
  DEFAULT_MEMORY_CONFIG,
} from './memory-forensics.js';
export type { MemoryForensicsConfig } from './memory-forensics.js';

export { generateScopeInjectorScript } from './scope-injector.js';
export type { ScopeInjectorConfig } from './scope-injector.js';

export { DeepStealthOrchestrator } from './deep-stealth.js';
export type { DeepStealthConfig } from './deep-stealth.js';
