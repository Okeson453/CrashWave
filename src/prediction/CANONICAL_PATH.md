# Canonical production prediction path (P0-11)

```
FeatureSnapshot → ModelEnsemble (ACIE/PSI) → Calibration → Uncertainty
  → Opportunity → RiskEngine → Decision
```

Production entry points:
- `EntryDecisionService.evaluateEntry` (live decisions)
- `runPredictionPipeline` (pipeline orchestration)

Legacy / research paths must not place bets.
