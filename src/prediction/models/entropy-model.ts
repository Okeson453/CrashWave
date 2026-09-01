import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import { entropyModel as impl } from './candidate-models.js';

export function scoreEntropy(engine: IncrementalStateEngine): number {
  return impl(engine).probability;
}
