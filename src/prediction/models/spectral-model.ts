import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import { spectralModel as impl } from './candidate-models.js';

export function scoreSpectral(engine: IncrementalStateEngine): number {
  return impl(engine).probability;
}
