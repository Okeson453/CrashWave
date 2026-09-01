/**
 * OpportunityScore — ranking only, does not invent probability.
 */

export interface OpportunityInputs {
  calibratedEdge: number;
  confidence: number;
  dataQuality: number;
  regimeStability: number;
  modelAgreement: number;
  executionQuality: number;
}

export function computeOpportunityScore(i: OpportunityInputs): number {
  const edge = Math.max(0, i.calibratedEdge);
  return (
    edge *
    clamp(i.confidence) *
    clamp(i.dataQuality) *
    clamp(i.regimeStability) *
    clamp(i.modelAgreement) *
    clamp(i.executionQuality)
  );
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x));
}
