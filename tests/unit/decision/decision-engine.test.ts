/**
 * Decision Engine + Opportunity Ranker unit tests
 */

import { DecisionEngine } from '../../../src/decision';
import { SheathMode } from '../../../src/core/sheath-mode';
import type { OpportunityDimensions } from '../../../src/opportunity';

const goodDims: OpportunityDimensions = {
  edge: 0.7,
  confidence: 0.8,
  dataQuality: 0.9,
  regimeFit: 0.75,
  executionFeasibility: 0.85,
  temporalConsistency: 0.7,
};

describe('DecisionEngine', () => {
  it('ENTER when quality and rank pass', () => {
    const engine = new DecisionEngine({ baseEnterThreshold: 0.4 });
    const rec = engine.decide({
      roundId: 'r1',
      probability: 0.6,
      confidence: 0.8,
      dimensions: goodDims,
    });
    expect(rec.decision).toBe('ENTER');
    expect(rec.qualityScore).toBeGreaterThan(0.4);
  });

  it('REJECT when quality below threshold', () => {
    const engine = new DecisionEngine({ baseEnterThreshold: 0.9 });
    const rec = engine.decide({
      roundId: 'r2',
      probability: 0.5,
      confidence: 0.5,
      dimensions: {
        edge: 0.4,
        confidence: 0.4,
        dataQuality: 0.5,
        regimeFit: 0.4,
        executionFeasibility: 0.5,
        temporalConsistency: 0.4,
      },
    });
    expect(rec.decision).toBe('REJECT');
  });

  it('SHEATH when sheath mode suspends betting', () => {
    const sheath = new SheathMode();
    sheath.operatorSheath();
    const engine = new DecisionEngine({ sheathMode: sheath, baseEnterThreshold: 0.3 });
    const rec = engine.decide({
      roundId: 'r3',
      probability: 0.9,
      confidence: 0.9,
      dimensions: goodDims,
    });
    expect(rec.decision).toBe('SHEATH');
  });

  it('geometric mean prevents single dimension dominance', () => {
    const engine = new DecisionEngine({ baseEnterThreshold: 0.5 });
    const rec = engine.decide({
      roundId: 'r4',
      probability: 0.9,
      confidence: 0.9,
      dimensions: {
        edge: 1.0,
        confidence: 1.0,
        dataQuality: 1.0,
        regimeFit: 1.0,
        executionFeasibility: 1.0,
        temporalConsistency: 0.01, // collapses geometric mean
      },
    });
    expect(rec.qualityScore).toBeLessThan(0.5);
    expect(rec.decision).toBe('REJECT');
  });
});
