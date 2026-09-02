import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import { autocorrelationModel as impl } from './candidate-models.js';

export function scoreAutocorrelation(engine: IncrementalStateEngine): number {
  return impl(engine).probability;
}
