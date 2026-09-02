import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import { markovChainModel } from './candidate-models.js';

export function scoreMarkov(engine: IncrementalStateEngine): number {
  return markovChainModel(engine).probability;
}
