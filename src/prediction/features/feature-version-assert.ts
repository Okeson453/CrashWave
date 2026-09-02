
import { FEATURE_VERSION_V2 } from './feature-meta.js';

/** Reject live decisions if stored prediction feature version mismatches engine */
export function assertFeatureVersionMatch(stored: string | null | undefined): void {
  if (!stored) return;
  if (stored !== FEATURE_VERSION_V2) {
    throw new Error(
      `Feature version mismatch: prediction=${stored} engine=${FEATURE_VERSION_V2}`
    );
  }
}
